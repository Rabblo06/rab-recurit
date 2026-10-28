/* eslint-disable */
/**
 * FROZEN TEST REFERENCE (M2-F4): the Phase 0b secure-owner invariant SQL exactly as committed in 0d677bbf, kept only so
 * secure-owner-invariants-equivalence.integration.spec.ts can prove the optimised production query reports the same
 * violations. Never imported by production code. Do not edit.
 */
/**
 * Phase 0b (E1, R6): catalog invariants that keep `rab_secure_owner` (NOLOGIN; owns the pre-auth tables and their SECURITY
 * DEFINER functions) from executing or depending on anything a LOGIN role controls. Read-only catalog queries; used by the
 * migration self-check (SecureOwnerCoreSchemaAndHelpers1786721100000) and by
 * `phase0b-secure-owner.integration.spec.ts`, so a later migration that reintroduces the pattern fails CI.
 *
 * What "reachable from rab_secure_owner" means here (every one of these runs with rab_secure_owner's privileges, or
 * decides what a NOT-FORCE secure table shows or stores):
 *   - every SECURITY DEFINER function rab_secure_owner owns;
 *   - every function a table rab_secure_owner owns depends on: trigger functions, policy expressions, column defaults and
 *     generated columns (pg_attrdef), CHECK / other constraints, index expressions and rules (pg_depend);
 *   - transitively, every `core` function named in the body of a reached function (`name(`), or recorded as a dependency
 *     of it (SQL-standard bodies).
 * Each reached `core` function must be owned by rab_secure_owner (pg_catalog built-ins and extension members excluded).
 * Function labels are `schema.name(argument types)` built from the catalog, never `regprocedure::text`, so the result does
 * not depend on the session search_path (a migration session, a pooled app session and a superuser psql must agree).
 *
 * Not covered, and therefore frozen as reviewed lists that fail on any change:
 *   - R4: `crewflow`-owned tables that rab_secure_owner definers read or write. Their owner (crewflow) can attach policies,
 *     triggers, RULEs, column DEFAULTs and CHECK constraints to them, and every one of those expressions runs as
 *     rab_secure_owner when a definer touches the table — including expressions that read any table through SPI. So R4
 *     means crewflow can still read (and write) as rab_secure_owner: E1 is PARTIALLY mitigated, not resolved. Accepted
 *     until `crewflow` stops being a runtime login (E6 / Phase B); the list may only shrink by an owner-reviewed change.
 *   - definers that use dynamic SQL (`EXECUTE`), whose targets a text scan cannot follow.
 * Also outside these checks (recorded as open findings H2 / H3, separate remediation): the database owner (database-level
 * settings such as search_path, and CREATE on `public`) and the owner of the extensions (`citext`, `pgcrypto`, ...) whose
 * functions and operators the definers call.
 */

/** R4 — frozen 2026-10-28 (Phase 0b). Any difference, addition or removal, fails until reviewed. */
export const R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS: readonly string[] = [
  'ai_usage_daily',
  'audit_log',
  'host_label_claim',
  'manager_profile',
  'organisation_ai_setting',
  'platform_config',
  'reserved_host_label',
  'role',
  'user_role',
  'workspace_membership',
  'workspace_schema_registry',
];

/** rab_secure_owner-owned SECURITY DEFINER functions that use dynamic SQL — reviewed 2026-10-28 (Phase 0b). */
export const REVIEWED_DYNAMIC_SQL_SECURE_DEFINERS: readonly string[] = [
  // Builds `workspace_<32 hex>` from a validated uuid (format %I): CREATE SCHEMA ... AUTHORIZATION rab_secure_owner + grants.
  'core.provision_workspace_schema(pg_catalog.uuid)',
];

/**
 * `schema.name(schema.type, ...)` for pg_proc alias `p`, every part read from the catalog: identical in any session,
 * whatever its search_path (independent review N2: format_type / regprocedure omit the schema of visible names).
 */
const fnLabel = (p: string) =>
  `pg_catalog.format('%s.%s(%s)', (SELECT pn.nspname FROM pg_catalog.pg_namespace pn WHERE pn.oid = ${p}.pronamespace), ${p}.proname,
     (SELECT pg_catalog.string_agg(tn.nspname || '.' || t.typname, ', ' ORDER BY a.ord)
        FROM unnest(${p}.proargtypes::pg_catalog.oid[]) WITH ORDINALITY a(typ, ord)
        JOIN pg_catalog.pg_type t ON t.oid = a.typ JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace))`;

/** Functions a secure table depends on, through any object attached to it (pg_depend `classid` of that object). */
const attachedToSecureTable = `
  SELECT d.refobjid FROM pg_catalog.pg_depend d
   WHERE d.refclassid = 'pg_catalog.pg_proc'::regclass
     AND (   (d.classid = 'pg_catalog.pg_attrdef'::regclass
              AND (SELECT ad.adrelid FROM pg_catalog.pg_attrdef ad WHERE ad.oid = d.objid) IN (SELECT oid FROM secure_tables))
          OR (d.classid = 'pg_catalog.pg_constraint'::regclass
              AND (SELECT co.conrelid FROM pg_catalog.pg_constraint co WHERE co.oid = d.objid) IN (SELECT oid FROM secure_tables))
          OR (d.classid = 'pg_catalog.pg_rewrite'::regclass
              AND (SELECT rw.ev_class FROM pg_catalog.pg_rewrite rw WHERE rw.oid = d.objid) IN (SELECT oid FROM secure_tables))
          OR (d.classid = 'pg_catalog.pg_class'::regclass
              AND (d.objid IN (SELECT oid FROM secure_tables)
                   OR (SELECT ix.indrelid FROM pg_catalog.pg_index ix WHERE ix.indexrelid = d.objid) IN (SELECT oid FROM secure_tables))))`;

/** One violation per row: `kind|object|detail`. Zero rows = every reachability / ownership / search_path invariant holds. */
export const SECURE_OWNER_INVARIANT_VIOLATIONS_SQL = `
WITH RECURSIVE
core_fn AS (
  SELECT p.oid, p.proname FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'core'::regnamespace
),
secure_tables AS (
  SELECT c.oid FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p') AND c.relowner = 'rab_secure_owner'::regrole
),
seed AS (
  SELECT p.oid FROM pg_catalog.pg_proc p WHERE p.proowner = 'rab_secure_owner'::regrole AND p.prosecdef
  UNION
  SELECT t.tgfoid FROM pg_catalog.pg_trigger t JOIN secure_tables s ON s.oid = t.tgrelid WHERE NOT t.tgisinternal
  UNION
  SELECT d.refobjid FROM pg_catalog.pg_policy pol JOIN secure_tables s ON s.oid = pol.polrelid
    JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_policy'::regclass AND d.objid = pol.oid
                               AND d.refclassid = 'pg_catalog.pg_proc'::regclass
  UNION
  -- column defaults and generated columns, constraints, rules and index expressions on secure tables (review M1)
  ${attachedToSecureTable}
),
reach(oid) AS (
  SELECT oid FROM seed
  UNION
  SELECT callee.oid
    FROM reach r JOIN pg_catalog.pg_proc caller ON caller.oid = r.oid
    JOIN core_fn callee ON callee.oid <> caller.oid
     AND (caller.prosrc ~ ('\\m' || callee.proname || '\\s*\\(')
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = caller.oid
                        AND d.refclassid = 'pg_catalog.pg_proc'::regclass AND d.refobjid = callee.oid))
),
violations AS (
  -- 1. Reachability: every reached core function is owned by rab_secure_owner.
  SELECT 'reachable-function-owner' AS kind, ${fnLabel('p')} AS object, pg_catalog.pg_get_userbyid(p.proowner) AS detail
    FROM reach r JOIN pg_catalog.pg_proc p ON p.oid = r.oid
   WHERE p.pronamespace = 'core'::regnamespace AND p.proowner <> 'rab_secure_owner'::regrole
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend e
                      WHERE e.classid = 'pg_catalog.pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e')
  UNION ALL
  -- 2. Schema core: owned by a NOLOGIN, non-superuser role.
  SELECT 'core-schema-owner', 'core', r.rolname
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
   WHERE n.nspname = 'core' AND (r.rolcanlogin OR r.rolsuper)
  UNION ALL
  -- 3. No runtime LOGIN role may create objects in core. Superusers and the migration identity (a member of
  --    rab_secure_owner by design: CF-41 bootstrap / crewflow_migrator) are excluded here; check 7 forbids the runtime
  --    logins from ever being such a member.
  SELECT 'core-create', 'core', r.rolname
    FROM pg_catalog.pg_roles r
   WHERE r.rolcanlogin AND NOT r.rolsuper AND NOT pg_catalog.pg_has_role(r.oid, 'rab_secure_owner', 'USAGE')
     AND pg_catalog.has_schema_privilege(r.oid, 'core'::regnamespace, 'CREATE')
  UNION ALL
  -- 4. Definer search_path: set, pg_catalog first, pg_temp last.
  SELECT 'definer-search-path', ${fnLabel('p')}, coalesce(sp.cfg, '<unset>')
    FROM pg_catalog.pg_proc p
    LEFT JOIN LATERAL (SELECT c AS cfg FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') sp ON true
   WHERE p.prosecdef AND p.pronamespace = 'core'::regnamespace
     AND (sp.cfg IS NULL OR sp.cfg !~ '^search_path=pg_catalog(,|$)' OR sp.cfg !~ '(^|, )pg_temp$')
  UNION ALL
  -- 5. No schema named in a definer search_path is writable by a non-superuser LOGIN role.
  SELECT 'definer-search-path-writable', ${fnLabel('p')}, s.elem || ' by ' || r.rolname
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL (SELECT c FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') sp(cfg)
    CROSS JOIN LATERAL (SELECT pg_catalog.btrim(e, '"') FROM unnest(pg_catalog.string_to_array(substring(sp.cfg FROM 13), ', ')) e) s(elem)
    JOIN pg_catalog.pg_namespace n ON n.nspname = s.elem
    JOIN pg_catalog.pg_roles r ON r.rolcanlogin AND NOT r.rolsuper AND NOT pg_catalog.pg_has_role(r.oid, 'rab_secure_owner', 'USAGE')
   WHERE p.prosecdef AND p.pronamespace = 'core'::regnamespace AND s.elem NOT IN ('pg_catalog', 'pg_temp')
     AND pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE')
  UNION ALL
  -- 6. No LOGIN role owns a rab_secure_owner-reachable object: secure tables' and definers' owner is NOLOGIN.
  SELECT 'secure-owner-login', 'rab_secure_owner', 'LOGIN or SUPERUSER or BYPASSRLS'
    FROM pg_catalog.pg_roles r WHERE r.rolname = 'rab_secure_owner' AND (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls)
  UNION ALL
  -- 7. The runtime logins never act as rab_secure_owner (CF-41 / assert-runtime-db-role.ts, re-asserted in the catalog).
  SELECT 'runtime-member-of-secure-owner', r.rolname, 'member of rab_secure_owner'
    FROM pg_catalog.pg_roles r
   WHERE r.rolname IN ('crewflow', 'crewflow_app')
     AND (pg_catalog.pg_has_role(r.oid, 'rab_secure_owner', 'USAGE') OR pg_catalog.pg_has_role(r.oid, 'rab_secure_owner', 'SET'))
)
SELECT kind || '|' || object || '|' || detail AS line FROM violations ORDER BY 1`;

/** R4 set as it stands: crewflow-owned (non-rab_secure_owner) core tables named in a rab_secure_owner definer's body. */
export const R4_TABLES_SQL = `
SELECT DISTINCT c.relname
  FROM pg_catalog.pg_proc p, pg_catalog.pg_class c
 WHERE p.proowner = 'rab_secure_owner'::regrole AND p.prosecdef
   AND c.relnamespace = 'core'::regnamespace AND c.relkind = 'r' AND c.relowner <> 'rab_secure_owner'::regrole
   AND p.prosrc ~* ('\\m(core\\.)?"?' || c.relname || '"?\\M')
 ORDER BY 1`;

/** rab_secure_owner definers whose body runs dynamic SQL. */
export const DYNAMIC_SQL_SECURE_DEFINERS_SQL = `
SELECT ${fnLabel('p')} AS fn
  FROM pg_catalog.pg_proc p
 WHERE p.prosecdef AND p.proowner = 'rab_secure_owner'::regrole AND p.prosrc ~* '\\mEXECUTE\\M'
 ORDER BY 1`;

type Query = (sql: string) => Promise<Array<Record<string, unknown>>>;

/** All violations, including drift of the two frozen lists. Empty array = all invariants hold. */
export async function secureOwnerInvariantViolations(query: Query): Promise<string[]> {
  const out = (await query(SECURE_OWNER_INVARIANT_VIOLATIONS_SQL)).map((r) => String(r.line));
  const diff = (label: string, actual: string[], frozen: readonly string[]) => {
    for (const a of actual) if (!frozen.includes(a)) out.push(`${label}-added|${a}|not in the reviewed list`);
    for (const f of frozen) if (!actual.includes(f)) out.push(`${label}-removed|${f}|reviewed list is stale`);
  };
  diff('r4-table', (await query(R4_TABLES_SQL)).map((r) => String(r.relname)), R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS);
  diff('dynamic-sql-definer', (await query(DYNAMIC_SQL_SECURE_DEFINERS_SQL)).map((r) => String(r.fn)), REVIEWED_DYNAMIC_SQL_SECURE_DEFINERS);
  return out;
}
