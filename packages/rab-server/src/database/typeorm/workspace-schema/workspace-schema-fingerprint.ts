/**
 * FROZEN with migration WorkspaceSchemaMigrationLedger1786719800000 (never edited after merge; a change is a new file and
 * a new migration that re-creates the functions).
 *
 * Wave 2 lane S2 (B4): the structural fingerprint of one physical workspace schema, computed IN THE DATABASE so every
 * caller (both provisioning paths, the migrator, the drift job, tests) uses exactly one implementation.
 *
 * `core.workspace_schema_fingerprint_lines(ws)` returns one canonical line per catalog fact of `workspace_<32 hex>`:
 *  - schema owner and schema ACL;
 *  - every relation (any relkind, so an injected view, sequence or foreign table shows up): kind, owner, ENABLE/FORCE RLS,
 *    and its raw ACL (any grantee, PUBLIC included);
 *  - every column: type, NOT NULL, default, identity/generated, collation, column ACL;
 *  - every constraint (PK, FK with actions, UNIQUE, CHECK, EXCLUDE): definition, validated, deferrable;
 *  - every index definition;
 *  - every policy: command, permissive, roles, USING, WITH CHECK;
 *  - every non-internal trigger, and any function placed in the schema.
 * Canonicalised: the schema name becomes `workspace_*` and the workspace uuid `<workspace_id>`, whitespace runs collapse
 * to one space, so every correctly built workspace at the same module version yields IDENTICAL lines and hash. Sorted with
 * the "C" collation (deterministic across locales).
 *
 * `core.workspace_schema_fingerprint(ws)` = sha256 (hex) over those lines joined by "\n"; NULL when the schema does not
 * exist. Not SECURITY DEFINER: it reads only the system catalogs, which every role can read. EXECUTE is granted to
 * `crewflow` (the migration/provisioner identity) only — the runtime role never needs it.
 *
 * CHECK constraint bodies are hashed with their parentheses removed (see the inline comment): found by rehearsing on a
 * pg_dump/pg_restore copy of rab-devdb, where one BETWEEN-derived CHECK came back with a re-associated AND tree. A
 * regrouping-only change to a CHECK is therefore not detected by the fingerprint (the posture snapshot and
 * verify_workspace_schema_v1 are unaffected); policy expressions are hashed exactly, because regrouping a USING clause
 * can change who sees a row.
 *
 * Known limitation (documented in WAVE2_LANE_S2_REPORT.md): pg_get_*def output is stable within a PostgreSQL major
 * version; the expected constants in v1/expected-fingerprints.ts are for PostgreSQL 16.
 */
export const WORKSPACE_FINGERPRINT_FUNCTIONS_SQL = `
CREATE FUNCTION core.workspace_schema_fingerprint_lines(p_workspace_id uuid)
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fingerprint$
  WITH s AS (
    SELECT n.oid, n.nspname, n.nspowner, n.nspacl
      FROM pg_catalog.pg_namespace n
     WHERE p_workspace_id IS NOT NULL
       AND n.nspname = 'workspace_' || pg_catalog.replace(p_workspace_id::text, '-', '')
  ),
  rel AS (
    SELECT c.oid, c.relname, c.relkind, c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_catalog.pg_class c JOIN s ON s.oid = c.relnamespace
  ),
  raw(line) AS (
    SELECT 'schema|owner|' || pg_catalog.pg_get_userbyid(s.nspowner) FROM s
    UNION ALL
    SELECT 'schema|acl|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
           || '|' || a.privilege_type || '|' || a.is_grantable
      FROM s CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(s.nspacl, pg_catalog.acldefault('n', s.nspowner))) a
    UNION ALL
    SELECT 'rel|' || r.relkind::text || '|' || r.relname || '|owner=' || pg_catalog.pg_get_userbyid(r.relowner)
           || '|rls=' || r.relrowsecurity || '|force=' || r.relforcerowsecurity
      FROM rel r
    UNION ALL
    SELECT 'acl|' || r.relname || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
           || '|' || a.privilege_type || '|' || a.is_grantable
      FROM rel r
      CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(r.relacl, pg_catalog.acldefault(CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END::"char", r.relowner))) a
     WHERE r.relkind <> 'i'
    UNION ALL
    SELECT 'column|' || r.relname || '.' || at.attname || '|' || pg_catalog.format_type(at.atttypid, at.atttypmod)
           || '|notnull=' || at.attnotnull || '|default=' || coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '<none>')
           || '|identity=' || at.attidentity::text || '|generated=' || at.attgenerated::text
           || '|collation=' || coalesce((SELECT co.collname::text FROM pg_catalog.pg_collation co WHERE co.oid = at.attcollation AND at.attcollation <> 0), '<none>')
      FROM rel r
      JOIN pg_catalog.pg_attribute at ON at.attrelid = r.oid AND at.attnum > 0 AND NOT at.attisdropped
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = at.attrelid AND d.adnum = at.attnum
     WHERE r.relkind IN ('r', 'p', 'v', 'm', 'f')
    UNION ALL
    SELECT 'column-acl|' || r.relname || '.' || at.attname || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
           || '|' || a.privilege_type
      FROM rel r
      JOIN pg_catalog.pg_attribute at ON at.attrelid = r.oid AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL
      CROSS JOIN LATERAL pg_catalog.aclexplode(at.attacl) a
    UNION ALL
    SELECT 'constraint|' || r.relname || '|' || k.conname || '|' || k.contype::text || '|'
           || CASE WHEN k.contype = 'c'
                   -- CHECK bodies are compared as a token stream (parentheses removed): a dump/restore re-parses
                   -- "a BETWEEN 1 AND 5 AND …" into a differently nested AND tree that deparses with different
                   -- parentheses but is the same constraint. Policies, FKs, indexes and every other line stay exact.
                   THEN pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(k.oid), '[()]', '', 'g')
                   ELSE pg_catalog.pg_get_constraintdef(k.oid) END
           || '|validated=' || k.convalidated || '|deferrable=' || k.condeferrable || '|deferred=' || k.condeferred
      FROM rel r JOIN pg_catalog.pg_constraint k ON k.conrelid = r.oid
    UNION ALL
    SELECT 'index|' || pg_catalog.pg_get_indexdef(i.indexrelid)
      FROM rel r JOIN pg_catalog.pg_index i ON i.indrelid = r.oid
    UNION ALL
    SELECT 'policy|' || r.relname || '|' || p.polname || '|cmd=' || p.polcmd::text || '|permissive=' || p.polpermissive
           || '|roles=' || coalesce((SELECT pg_catalog.string_agg(CASE WHEN x = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x)::text END, ',' ORDER BY 1)
                                       FROM pg_catalog.unnest(p.polroles) x), '')
           || '|using=' || coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '<none>')
           || '|check=' || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '<none>')
      FROM rel r JOIN pg_catalog.pg_policy p ON p.polrelid = r.oid
    UNION ALL
    SELECT 'trigger|' || r.relname || '|' || pg_catalog.pg_get_triggerdef(t.oid) || '|enabled=' || t.tgenabled::text
      FROM rel r JOIN pg_catalog.pg_trigger t ON t.tgrelid = r.oid AND NOT t.tgisinternal
    UNION ALL
    SELECT 'function|' || p.oid::pg_catalog.regprocedure::text || '|owner=' || pg_catalog.pg_get_userbyid(p.proowner) || '|definer=' || p.prosecdef
      FROM s JOIN pg_catalog.pg_proc p ON p.pronamespace = s.oid
  )
  SELECT DISTINCT pg_catalog.regexp_replace(
           pg_catalog.replace(pg_catalog.replace(raw.line, s.nspname, 'workspace_*'), p_workspace_id::text, '<workspace_id>'),
           '[[:space:]]+', ' ', 'g') COLLATE "C" AS line
    FROM raw CROSS JOIN s
   ORDER BY 1
$fingerprint$;

CREATE FUNCTION core.workspace_schema_fingerprint(p_workspace_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fingerprint$
  SELECT CASE WHEN count(*) = 0 THEN NULL
              ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(l, E'\\n' ORDER BY l COLLATE "C"), 'UTF8')), 'hex') END
    FROM core.workspace_schema_fingerprint_lines(p_workspace_id) AS f(l)
$fingerprint$;

ALTER FUNCTION core.workspace_schema_fingerprint_lines(uuid) OWNER TO crewflow;
ALTER FUNCTION core.workspace_schema_fingerprint(uuid) OWNER TO crewflow;
REVOKE ALL ON FUNCTION core.workspace_schema_fingerprint_lines(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.workspace_schema_fingerprint(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.workspace_schema_fingerprint_lines(uuid) TO crewflow;
GRANT EXECUTE ON FUNCTION core.workspace_schema_fingerprint(uuid) TO crewflow;
`;
