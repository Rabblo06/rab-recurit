// sql-injection-reviewed-file: SQL definition module (database layer). Every interpolation is a code constant of this repository (the frozen template, module ids / versions / checksums, a 64-hex fingerprint, a validated app_version literal and a structure level integer); no request or row data reaches these templates.
import { provisionWorkspaceFunctionV3Sql } from '../core/provision-workspace-guards-sql';
import type { ProvisionLedgerModule } from './v1/provision-workspace-function-v2';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import { composeServerPathTemplateV1GrantParity } from './v1/server-path-template-grant-parity';
import { staffProfileMemberSelectSql } from '../../../engine/core-modules/upgrade/upgrade-commands/0-6/staff-profile-member-select';

/**
 * FROZEN with migration WorkspaceStaffMemberSelect1786721480000 (never edited after merge; owner-reviewed SQL, see
 * docs/plans/phase-x3/WS-COMMANDS.md "FOR OWNER REVIEW — 0b release"). The first structure-changing release of Part D
 * (D-RUNNER.md §5.3 / §9.1):
 *
 *  1. `core.workspace_schema_fingerprint_v2_lines(uuid)` / `core.workspace_schema_fingerprint_v2(uuid)`: the v1 lines (FROZEN
 *     with WorkspaceSchemaMigrationLedger1786719800000, unchanged) prefixed `v1|`, plus what v1 does not hash (relation
 *     persistence, reloptions, rewrite rules, inheritance, standalone types, operators). Every structure level above 20 is
 *     declared and compared with v2; levels 14..20 keep their v1 tables. The registry's expected/observed fingerprint columns
 *     keep holding v1 (core.record_workspace_schema_drift, unchanged, compares v1).
 *  2. `core.verify_workspace_schema_v1(uuid)`: the VenueTeamOrgAdmin1786721090000 body with ONE change: the policy count of
 *     level 21 and above is 42 (staff_profile_member_select), and 42 joins the counts accepted when no registry version is
 *     visible (the provisioning transaction before READY).
 *  3. `core.provision_workspace(uuid)`: the guarded v3 body over template(20) + the level-21 command, recording
 *     module_version 21, checking the level-21 v2 fingerprint and storing the v1 fingerprint in the registry.
 */

/**
 * The §9.1 draft (D-RUNNER.md), owner-approved to ship with the first structure-changing release, with ONE change: the owner is
 * `rab_secure_owner` (the NOLOGIN owner of `core`), not `crewflow`. Since Phase 0b crewflow holds no CREATE on core, and
 * PostgreSQL refuses to hand an object to an owner without CREATE on its schema ("permission denied for schema core"); every
 * core object created since Phase 0b is owned by rab_secure_owner. Both functions stay SECURITY INVOKER (the owner never
 * runs them), EXECUTE for crewflow only (the runner, the provisioners and the drift job act as crewflow), never PUBLIC.
 */
export const WORKSPACE_FINGERPRINT_V2_FUNCTIONS_SQL = `
CREATE FUNCTION core.workspace_schema_fingerprint_v2_lines(p_workspace_id uuid)
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fingerprint$
  WITH s AS (
    SELECT n.oid, n.nspname FROM pg_catalog.pg_namespace n
     WHERE p_workspace_id IS NOT NULL AND n.nspname = 'workspace_' || pg_catalog.replace(p_workspace_id::text, '-', '')
  ),
  rel AS (SELECT c.oid, c.relname, c.relkind, c.relpersistence, c.reloptions FROM pg_catalog.pg_class c JOIN s ON s.oid = c.relnamespace),
  raw(line) AS (
    SELECT 'v1|' || l FROM core.workspace_schema_fingerprint_lines(p_workspace_id) AS l
    UNION ALL
    SELECT 'persistence|' || r.relname || '|' || r.relpersistence::text FROM rel r
    UNION ALL
    SELECT 'reloptions|' || r.relname || '|' || coalesce(pg_catalog.array_to_string(r.reloptions, ','), '<none>') FROM rel r
    UNION ALL
    SELECT 'rule|' || r.relname || '|' || pg_catalog.pg_get_ruledef(w.oid) FROM rel r JOIN pg_catalog.pg_rewrite w ON w.ev_class = r.oid
    UNION ALL
    SELECT 'inherits|' || i.inhrelid::pg_catalog.regclass::text || '|' || i.inhparent::pg_catalog.regclass::text
      FROM pg_catalog.pg_inherits i WHERE i.inhrelid IN (SELECT oid FROM rel) OR i.inhparent IN (SELECT oid FROM rel)
    UNION ALL
    SELECT 'type|' || y.typname || '|' || y.typtype::text || '|' || y.typcategory::text FROM s JOIN pg_catalog.pg_type y ON y.typnamespace = s.oid
    UNION ALL
    SELECT 'operator|' || o.oid::pg_catalog.regoperator::text FROM s JOIN pg_catalog.pg_operator o ON o.oprnamespace = s.oid
  )
  SELECT DISTINCT pg_catalog.regexp_replace(
           pg_catalog.replace(pg_catalog.replace(raw.line, s.nspname, 'workspace_*'), p_workspace_id::text, '<workspace_id>'),
           '[[:space:]]+', ' ', 'g') COLLATE "C" AS line
    FROM raw CROSS JOIN s
   ORDER BY 1
$fingerprint$;

CREATE FUNCTION core.workspace_schema_fingerprint_v2(p_workspace_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fingerprint$
  SELECT CASE WHEN count(*) = 0 THEN NULL
              ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(l, E'\\n' ORDER BY l COLLATE "C"), 'UTF8')), 'hex') END
    FROM core.workspace_schema_fingerprint_v2_lines(p_workspace_id) AS f(l)
$fingerprint$;

ALTER FUNCTION core.workspace_schema_fingerprint_v2_lines(uuid) OWNER TO rab_secure_owner;
ALTER FUNCTION core.workspace_schema_fingerprint_v2(uuid) OWNER TO rab_secure_owner;
REVOKE ALL ON FUNCTION core.workspace_schema_fingerprint_v2_lines(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.workspace_schema_fingerprint_v2(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.workspace_schema_fingerprint_v2_lines(uuid) TO crewflow;
GRANT EXECUTE ON FUNCTION core.workspace_schema_fingerprint_v2(uuid) TO crewflow;
`;

/**
 * Security review F1: the workspace schemas that still carry the level-21 policy (catalog only). down() refuses while any
 * remains, so a rollback can never leave level-21 workspaces behind a verify body that expects 41 policies.
 */
export const LEVEL_21_WORKSPACES_SQL = `SELECT pg_catalog.count(*)::int AS n
  FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE p.polname = 'staff_profile_member_select' AND n.nspname ~ '^workspace_[0-9a-f]{32}$'`;

export const DROP_WORKSPACE_FINGERPRINT_V2_FUNCTIONS_SQL = `
DROP FUNCTION IF EXISTS core.workspace_schema_fingerprint_v2(uuid);
DROP FUNCTION IF EXISTS core.workspace_schema_fingerprint_v2_lines(uuid);
`;

/**
 * `core.verify_workspace_schema_v1(uuid)` from this release on. Byte-identical to VERIFY_WORKSPACE_SCHEMA_V1_POLICY_AWARE_SQL
 * (VenueTeamOrgAdmin1786721090000) except the two policy-count lines (42 at level 21+, 42 accepted with no visible version).
 * CREATE OR REPLACE keeps owner, ACL and the SECURITY INVOKER / STABLE / search_path attributes.
 */
export const VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_21_SQL = `
CREATE OR REPLACE FUNCTION core.verify_workspace_schema_v1(p_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $verify$
    DECLARE
      v_name   text := 'workspace_' || replace(p_workspace_id::text, '-', '');
      v_n      integer;
      v_forced integer;
      v_owned  integer;
      v_mv     integer;
      v_idx    integer;
      v_pol    integer;
    BEGIN
      -- Same checks, same labels, as provision-workspace-schema.ts verifyStructure(), plus table ownership.
      SELECT count(*)::int,
             count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int,
             count(*) FILTER (WHERE pg_catalog.pg_get_userbyid(c.relowner) = 'crewflow')::int
        INTO v_n, v_forced, v_owned
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = v_name AND c.relkind = 'r';
      IF v_n <> 21 THEN RETURN 'table count'; END IF;
      IF v_forced <> 21 THEN RETURN 'FORCE RLS'; END IF;
      IF v_owned <> 21 THEN RETURN 'table owner'; END IF;
      -- Index count (90 for v1..15, 94 at v16, 100 at v17+) and policy count (39 for v1..17, 41 at v18..20, 42 at 21+) depend on the
      -- workspace's recorded module version. With no visible registry version (0 / no tenant context: a pre-ledger
      -- baseline, or the provisioning transaction before READY) any known count is accepted; the exact structure is then
      -- proven by the per-version fingerprint, which every caller also checks.
      SELECT r.module_version INTO v_mv FROM core.workspace_schema_registry r WHERE r.workspace_id = p_workspace_id;
      v_idx := (SELECT count(*)::int FROM pg_catalog.pg_indexes WHERE schemaname = v_name);
      v_pol := (SELECT count(*)::int FROM pg_catalog.pg_policies WHERE schemaname = v_name);
      IF coalesce(v_mv, 0) = 0 THEN
        IF v_idx NOT IN (90, 94, 100) THEN RETURN 'index count'; END IF;
        IF v_pol NOT IN (39, 41, 42) THEN RETURN 'policy count'; END IF;
      ELSE
        IF v_idx <> (CASE WHEN v_mv >= 17 THEN 100 WHEN v_mv = 16 THEN 94 ELSE 90 END) THEN RETURN 'index count'; END IF;
        IF v_pol <> (CASE WHEN v_mv >= 21 THEN 42 WHEN v_mv >= 18 THEN 41 ELSE 39 END) THEN RETURN 'policy count'; END IF;
      END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
           WHERE ns.nspname = v_name AND k.contype = 'f') <> 128 THEN RETURN 'foreign key count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
           WHERE ns.nspname = v_name AND k.contype = 'c' AND k.conname LIKE '%_workspace_bound') <> 21 THEN
        RETURN 'workspace CHECK count';
      END IF;
      -- Wave 2 lane S2: the schema's own binding CHECKs are selected FIRST (MATERIALIZED), so pg_get_constraintdef — which
      -- takes AccessShareLock on the constrained table — never touches another workspace's tables. Before this, a lock
      -- held on ANY workspace's table blocked the verification (and therefore provisioning/migration) of every other one.
      IF EXISTS (WITH bound AS MATERIALIZED (
                   SELECT k.oid FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
                    WHERE ns.nspname = v_name AND k.contype = 'c' AND k.conname LIKE '%_workspace_bound')
                 SELECT 1 FROM bound b
                  WHERE strpos(pg_catalog.pg_get_constraintdef(b.oid), '''' || p_workspace_id::text || '''::uuid') = 0
                     OR strpos(pg_catalog.pg_get_constraintdef(b.oid), 'workspace_id IS NOT NULL') = 0) THEN
        RETURN 'workspace CHECK value or NULL exclusion';
      END IF;
      IF (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace WHERE nspname = v_name) IS DISTINCT FROM 'rab_secure_owner' THEN
        RETURN 'schema owner';
      END IF;
      IF (SELECT a.attnotnull FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
           WHERE ns.nspname = v_name AND c.relname = 'user_note' AND a.attname = 'workspace_id') IS DISTINCT FROM true THEN
        RETURN 'user_note workspace_id NOT NULL';
      END IF;
      RETURN NULL;
    END;
    $verify$;
`;

/** The composition core.provision_workspace embeds from this release on: the frozen module-20 composition + level 21. */
export function composeServerPathTemplateLevel21(): string {
  return [composeServerPathTemplateV1GrantParity(), staffProfileMemberSelectSql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}

const once = (sql: string, anchor: string): void => {
  if (sql.split(anchor).length !== 2) throw new Error('provision_workspace v3 anchor not found exactly once; refusing to compose the structure-level body');
};

/**
 * The guarded v3 body (provisionWorkspaceFunctionV3Sql, unchanged) for a structure level above 20, with three anchored
 * substitutions and nothing else:
 *   - the fingerprint compared is `core.workspace_schema_fingerprint_v2` against the level's declared v2 value;
 *   - the error names the structure level;
 *   - the registry records `module_version = <level>` and the v1 fingerprint (expected / observed, for the drift recorder).
 * The ledger still records one APPLIED row per frozen module (1..20, owner decision D5: template history).
 */
export function provisionWorkspaceFunctionLevelSql(
  template: string,
  modules: readonly ProvisionLedgerModule[],
  level: number,
  expectedV2: string,
  appVersion: string,
): string {
  if (!Number.isInteger(level) || level <= 20 || level > 999) throw new Error('structure level must be an integer above 20');
  const last = modules[modules.length - 1]?.version;
  if (last !== 20) throw new Error('the structure-level body records the 20 frozen modules');
  const v3 = provisionWorkspaceFunctionV3Sql(template, modules, expectedV2, appVersion);
  const fp = `        v_fp := core.workspace_schema_fingerprint(p_workspace_id);\n        IF v_fp IS DISTINCT FROM `;
  const msg = `does not match the expected fingerprint for module version ${last}'`;
  const reg = `        END IF;\n        UPDATE core.workspace_schema_registry\n           SET module_version = ${last}, expected_fingerprint = v_fp, observed_fingerprint = v_fp,`;
  for (const a of [fp, msg, reg]) once(v3, a);
  return v3
    .replace(fp, `        v_fp := core.workspace_schema_fingerprint_v2(p_workspace_id);\n        IF v_fp IS DISTINCT FROM `)
    .replace(msg, `does not match the expected fingerprint (v2) for structure level ${level}'`)
    .replace(
      reg,
      `        END IF;\n        -- The registry keeps the v1 fingerprint: core.record_workspace_schema_drift compares v1.\n` +
        `        v_fp := core.workspace_schema_fingerprint(p_workspace_id);\n        UPDATE core.workspace_schema_registry\n` +
        `           SET module_version = ${level}, expected_fingerprint = v_fp, observed_fingerprint = v_fp,`,
    );
}
