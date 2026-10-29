import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';

/**
 * Phase 0b — E1 (owner-approved 2026-10-28): R1, R2, R5 and R6 of the reviewed design.
 *
 * E1: `crewflow` (a LOGIN role; today held by the Worker's provisioner child, E6) could control code that runs as
 * `rab_secure_owner`, the NOLOGIN owner of the pre-auth tables and their SECURITY DEFINER functions:
 *   - channel 1: `core.current_org()` / `current_uid()` / `current_workspace()` are crewflow-owned invoker functions,
 *     called inside rab_secure_owner definers and in policies on rab_secure_owner tables — their owner can redefine them;
 *   - channel 2: four crewflow-owned trigger functions fire on rab_secure_owner tables (`user`, `user_session`,
 *     `organisation`, `platform_admin`);
 *   - channel 4: crewflow owned schema `core`, which holds every rab_secure_owner table and function (a schema owner may
 *     drop objects in it) and could create objects in it.
 *   - also (independent review M1): `core.immutable_unaccent(text)`, crewflow-owned, is used by the generated
 *     `search_vector` column of rab_secure_owner's `core."user"`; crewflow could redefine or drop it (CASCADE).
 * This migration closes channels 1 and 2 and the schema-owner part of channel 4 (DROP / CREATE in `core`).
 * E1 is PARTIALLY MITIGATED, NOT resolved:
 *   - R4 (open): crewflow still owns 11 tables that rab_secure_owner definers read or write; as their owner it can attach
 *     policies, triggers, RULEs, DEFAULTs and CHECKs whose expressions run as rab_secure_owner — i.e. it can still read
 *     (and write) as rab_secure_owner. Frozen and tracked by secure-owner-invariants.ts until crewflow stops being a
 *     runtime login (E6 / Phase B).
 *   - H2 (open, separate remediation): crewflow owns the database (database-level settings, CREATE on `public`).
 *   - H3 (open, separate remediation): crewflow owns the citext / pgcrypto / btree_gist / uuid-ossp extension objects
 *     used by the definers, so it can drop or relocate them (their member functions are owned by the bootstrap superuser).
 *   - R3 (open, lower): search_path `pg_catalog, core, pg_temp` on 29 definers is not changed here.
 *
 *   R1  ALTER SCHEMA core OWNER TO rab_secure_owner. PostgreSQL rewrites the schema ACL to the new owner, which would drop
 *       crewflow's USAGE: USAGE is granted back explicitly to crewflow and crewflow_app (rab_secure_owner holds it as owner).
 *   R5  crewflow holds no CREATE on core. Verified first that no runtime path needs it (provisioner, workspace-schema
 *       migrator, server-path provisioning and every crewflow-owned definer create only in workspace_* schemas). Later
 *       migrations that hand a new core object to crewflow use core-schema-create-scope.ts (withCrewflowCoreCreate).
 *   R2  rab_secure_owner becomes owner of the four core.current_* helpers, the four trigger functions above and
 *       core.immutable_unaccent(text) (IMMUTABLE, fully qualified body, default ACL kept). Function
 *       bodies are unchanged; the explicit EXECUTE grant crewflow held as owner is re-granted (ownership rewrites the ACL);
 *       PUBLIC and crewflow_app entries are kept. The trigger functions are pinned to `pg_catalog, pg_temp` (their bodies
 *       use only NEW/OLD). The current_* helpers deliberately get NO `SET` clause: a SET would stop PostgreSQL inlining these
 *       STABLE SQL functions into the 235+ RLS policies that call them.
 *   R6  Self-check before commit (any failure RAISES and rolls everything back): a before/after snapshot of RLS flags,
 *       crewflow / crewflow_app table, function and schema-USAGE privileges and role memberships must be identical; the
 *       ownership facts above must hold; and secureOwnerInvariantViolations() must return nothing.
 *
 * Not touched: no table, policy, FORCE/ENABLE flag, column, data, role attribute or membership; no grant to a LOGIN role
 * beyond what it already had; nothing becomes owned by a LOGIN role. Authority: the CF-41 bootstrap identity (a superuser,
 * or a non-superuser able to act as both rab_secure_owner and crewflow — proven in phase0b-secure-owner.integration.spec).
 *
 * down(): a real reversal to the exact previous effective state (owners, trigger search_path, schema USAGE/CREATE), with the
 * same snapshot check. It re-opens channels 1, 2 and 4 and exists for rehearsal and emergency rollback only.
 */
/** No SET clause, ever: the current_* helpers are inlined into RLS; immutable_unaccent backs generated columns and indexes. */
const HELPERS = ['current_org()', 'current_uid()', 'current_workspace()', 'current_role_name()', 'immutable_unaccent(text)'] as const;
const TRIGGER_FUNCTIONS = [
  'enforce_user_security_version_monotonic()',
  'enforce_organisation_security_version_monotonic()',
  'enforce_platform_admin_security_version_monotonic()',
  'enforce_user_session_mutation_invariants()',
] as const;
const ALL = [...HELPERS, ...TRIGGER_FUNCTIONS];
const PREVIOUS_TRIGGER_SEARCH_PATH = 'core, pg_catalog';

/** Effective privilege state that must NOT change in either direction (core and every workspace schema). */
const SNAPSHOT_SQL = `
SELECT line FROM (
  SELECT 'rls|' || n.nspname || '.' || c.relname || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity AS line
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE (n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$') AND c.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'table|' || n.nspname || '.' || c.relname || '|' || r.rolname || '|' || concat_ws(',',
           CASE WHEN has_table_privilege(r.oid, c.oid, 'SELECT') THEN 'S' END, CASE WHEN has_table_privilege(r.oid, c.oid, 'INSERT') THEN 'I' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'UPDATE') THEN 'U' END, CASE WHEN has_table_privilege(r.oid, c.oid, 'DELETE') THEN 'D' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'TRUNCATE') THEN 'T' END, CASE WHEN has_table_privilege(r.oid, c.oid, 'REFERENCES') THEN 'R' END,
           CASE WHEN has_table_privilege(r.oid, c.oid, 'TRIGGER') THEN 'G' END)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace CROSS JOIN pg_catalog.pg_roles r
   WHERE (n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$') AND c.relkind IN ('r', 'p', 'v', 'S')
     AND r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'execute|' || p.oid::regprocedure::text || '|' || r.rolname || '|' || has_function_privilege(r.oid, p.oid, 'EXECUTE')
    FROM pg_catalog.pg_proc p CROSS JOIN pg_catalog.pg_roles r
   WHERE p.pronamespace = 'core'::regnamespace AND r.rolname IN ('crewflow', 'crewflow_app')
  UNION ALL
  SELECT 'usage|' || n.nspname || '|' || r.rolname || '|' || has_schema_privilege(r.oid, n.oid, 'USAGE')
    FROM pg_catalog.pg_namespace n CROSS JOIN pg_catalog.pg_roles r
   WHERE (n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$') AND r.rolname IN ('crewflow', 'crewflow_app', 'rab_secure_owner')
  UNION ALL
  SELECT 'member|' || pg_catalog.pg_get_userbyid(m.roleid) || '|' || pg_catalog.pg_get_userbyid(m.member) || '|' || m.admin_option
    FROM pg_catalog.pg_auth_members m
) s ORDER BY 1`;

export class SecureOwnerCoreSchemaAndHelpers1786721100000 implements MigrationInterface {
  name = 'SecureOwnerCoreSchemaAndHelpers1786721100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    const before = await this.snapshot(queryRunner);
    const ownerGranted = await this.explicitlyGrantedToCrewflow(queryRunner);

    // R1 + R5
    await queryRunner.query('ALTER SCHEMA core OWNER TO rab_secure_owner');
    await queryRunner.query('GRANT USAGE ON SCHEMA core TO crewflow, crewflow_app');
    await queryRunner.query('REVOKE CREATE ON SCHEMA core FROM crewflow');

    // R2 (schema first: a non-superuser can hand a function only to a role that has CREATE on its schema)
    for (const fn of ALL) await queryRunner.query(`ALTER FUNCTION core.${fn} OWNER TO rab_secure_owner`);
    for (const fn of ownerGranted) await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.${fn} TO crewflow`);
    for (const fn of TRIGGER_FUNCTIONS) await queryRunner.query(`ALTER FUNCTION core.${fn} SET search_path = pg_catalog, pg_temp`);

    // R6
    await this.assertUnchanged(queryRunner, before);
    await this.assertState(queryRunner, 'rab_secure_owner');
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) {
      throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    const before = await this.snapshot(queryRunner);
    const ownerGranted = await this.explicitlyGrantedToCrewflow(queryRunner);

    // Schema first, so crewflow (its owner again) holds CREATE when the functions are handed back.
    await queryRunner.query('ALTER SCHEMA core OWNER TO crewflow');
    await queryRunner.query('GRANT USAGE ON SCHEMA core TO rab_secure_owner, crewflow_app');
    for (const fn of ALL) await queryRunner.query(`ALTER FUNCTION core.${fn} OWNER TO crewflow`);
    for (const fn of ownerGranted) await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.${fn} TO crewflow`);
    for (const fn of TRIGGER_FUNCTIONS) {
      await queryRunner.query(`ALTER FUNCTION core.${fn} SET search_path = ${PREVIOUS_TRIGGER_SEARCH_PATH}`);
    }

    await this.assertUnchanged(queryRunner, before);
    await this.assertState(queryRunner, 'crewflow');
  }

  /**
   * Independent review N1: this migration's own session resolves names only in pg_catalog (then pg_temp), so no
   * database- or role-level search_path default (see open finding H2: crewflow owns the database) can change what its
   * checks call. Transaction-local: it reverts at commit or rollback. Every object this migration names is `core.`-qualified.
   */
  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  }

  /** CF-41 bootstrap identity; rab_secure_owner stays a NOLOGIN, non-superuser, non-BYPASSRLS role that can own schemas. */
  private async preflight(queryRunner: QueryRunner): Promise<void> {
    const [f] = await queryRunner.query(`
      SELECT current_user AS who, r.rolsuper AS su,
             (pg_has_role(current_user, 'rab_secure_owner', 'USAGE') AND pg_has_role(current_user, 'rab_secure_owner', 'SET')
              AND pg_has_role(current_user, 'crewflow', 'USAGE') AND pg_has_role(current_user, 'crewflow', 'SET')) AS can_act,
             (SELECT s.rolcanlogin OR s.rolsuper OR s.rolbypassrls FROM pg_roles s WHERE s.rolname = 'rab_secure_owner') AS secure_bad,
             has_database_privilege('rab_secure_owner', current_database(), 'CREATE') AS secure_db_create,
             -- PG16 AlterSchemaOwner_internal checks CREATE on the database for the CURRENT user (review L2).
             has_database_privilege(current_user, current_database(), 'CREATE') AS self_db_create,
             (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'core') AS core_owner
        FROM pg_roles r WHERE r.rolname = current_user`);
    const problems: string[] = [];
    if (!f.su && !f.can_act) problems.push('it cannot act as both rab_secure_owner and crewflow (CF-41 bootstrap identity required)');
    if (f.secure_bad !== false) problems.push('rab_secure_owner must exist and be NOLOGIN, NOSUPERUSER, NOBYPASSRLS');
    if (f.secure_db_create !== true) problems.push('rab_secure_owner needs CREATE on the database to own a schema');
    if (f.self_db_create !== true) problems.push('the migration identity needs CREATE on the database to change a schema owner');
    if (!['crewflow', 'rab_secure_owner'].includes(f.core_owner)) problems.push(`schema core is owned by ${f.core_owner}, not crewflow/rab_secure_owner`);
    if (problems.length) throw new Error(`${this.name}: refusing to run as ${f.who}: ${problems.join('; ')}.`);
  }

  /** Of the eight functions, those whose ACL carries an explicit entry for crewflow (it moves with ownership). */
  private async explicitlyGrantedToCrewflow(queryRunner: QueryRunner): Promise<string[]> {
    const rows: Array<{ fn: string }> = await queryRunner.query(
      `SELECT replace(p.oid::regprocedure::text, 'core.', '') AS fn
         FROM pg_proc p
        WHERE p.oid = ANY ($1::regprocedure[]) AND p.proacl IS NOT NULL
          AND (EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 'crewflow'::regrole AND a.privilege_type = 'EXECUTE')
               OR p.proowner = 'crewflow'::regrole)`,
      [ALL.map((fn) => `core.${fn}`)],
    );
    return rows.map((r) => r.fn);
  }

  private async snapshot(queryRunner: QueryRunner): Promise<string[]> {
    return (await queryRunner.query(SNAPSHOT_SQL)).map((r: { line: string }) => r.line);
  }

  private async assertUnchanged(queryRunner: QueryRunner, before: string[]): Promise<void> {
    const after = await this.snapshot(queryRunner);
    const a = new Set(after);
    const b = new Set(before);
    const lost = before.filter((l) => !a.has(l));
    const gained = after.filter((l) => !b.has(l));
    if (lost.length || gained.length) {
      throw new Error(
        `${this.name}: effective privileges changed (rolled back): -${lost.length} +${gained.length}\n  ` +
          [...lost.map((l) => `- ${l}`), ...gained.map((l) => `+ ${l}`)].slice(0, 40).join('\n  '),
      );
    }
  }

  private async assertState(queryRunner: QueryRunner, owner: 'rab_secure_owner' | 'crewflow'): Promise<void> {
    const [s] = await queryRunner.query(`
      SELECT (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'core') AS core_owner,
             has_schema_privilege('crewflow', 'core', 'CREATE') AS crewflow_create,
             has_schema_privilege('crewflow', 'core', 'USAGE') AND has_schema_privilege('crewflow_app', 'core', 'USAGE')
               AND has_schema_privilege('rab_secure_owner', 'core', 'USAGE') AS usage_ok`);
    const fns: Array<{ fn: string; owner: string; cfg: string | null }> = await queryRunner.query(
      `SELECT replace(p.oid::regprocedure::text, 'core.', '') AS fn, pg_get_userbyid(p.proowner) AS owner, array_to_string(p.proconfig, ';') AS cfg
         FROM pg_proc p WHERE p.oid = ANY ($1::regprocedure[])`,
      [ALL.map((fn) => `core.${fn}`)],
    );
    const problems: string[] = [];
    if (s.core_owner !== owner) problems.push(`schema core owner is ${s.core_owner}`);
    if (s.crewflow_create !== (owner === 'crewflow')) problems.push(`crewflow CREATE on core is ${s.crewflow_create}`);
    if (s.usage_ok !== true) problems.push('USAGE on core missing for crewflow / crewflow_app / rab_secure_owner');
    if (fns.length !== ALL.length) problems.push(`expected ${ALL.length} functions, found ${fns.length}`);
    const triggerPath = owner === 'rab_secure_owner' ? 'search_path=pg_catalog, pg_temp' : `search_path=${PREVIOUS_TRIGGER_SEARCH_PATH}`;
    for (const f of fns) {
      if (f.owner !== owner) problems.push(`${f.fn} owner is ${f.owner}`);
      if ((HELPERS as readonly string[]).includes(f.fn) && f.cfg) problems.push(`${f.fn} must keep no SET clause (inlining), has ${f.cfg}`);
      if ((TRIGGER_FUNCTIONS as readonly string[]).includes(f.fn) && f.cfg !== triggerPath) problems.push(`${f.fn} config is ${f.cfg}`);
    }
    if (problems.length) throw new Error(`${this.name}: post-condition failed (rolled back): ${problems.join('; ')}`);
  }
}
