import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import { HWS_CUTOVER_CREWFLOW_FUNCTIONS_SQL, HWS_CUTOVER_RECONCILE_SQL, HWS_CUTOVER_STATE_SQL, hwsCutoverStateProblems } from '../hws-cutover-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';

/**
 * OWNER-DB-ULTIMATE Part C3, option A′ — PENDING OWNER CHOICE (A′ vs B′) AND SQL REVIEW (docs/plans/phase-x3/SQL-DRAFTS.md,
 * "FOR OWNER REVIEW — C3"). Until the owner approves, this migration runs ONLY on throwaway databases.
 *
 * Functions only (no table, policy, grant on a table, role, or workspace template change; no workspace fingerprint change):
 *   - core.hws_cutover_schema(uuid)            crewflow, INVOKER  guard: migration lock on this backend, tenant = W, W READY
 *   - core.hws_cutover_source_sql(text)        crewflow, INVOKER  closed table list → the core-side source SELECT (text only)
 *   - core.hws_cutover_probe(uuid)             crewflow, DEFINER  per table: core rows of W? rows in W's schema? (pre-check)
 *   - core.hws_cutover_copy_batch(...)         crewflow, DEFINER  one keyset batch core → W, FORCE lifted inside the call only
 *   - core.hws_cutover_verify_range(...)       crewflow, DEFINER  counts, md5, money / minutes totals per key range
 *   - core.hws_cutover_reconcile_statement_pointers(uuid, boolean)
 *                                              rab_secure_owner, DEFINER, EXECUTE to crewflow (Q13 pointer reconcile)
 * EXECUTE: REVOKE ALL FROM PUBLIC on every one. crewflow (owner) and the owner login (crewflow_owner, through its crewflow
 * membership) hold it; crewflow_app holds nothing. The SQL text and the reasoning: ../hws-cutover-sql.ts.
 *
 * Identity: the CF-41 bootstrap identity (the owner login, or a superuser on a disposable cluster). The crewflow functions are
 * created inside withCrewflowCoreCreate and handed to crewflow (no LOGIN role owns a core object); the reconcile function is
 * created as rab_secure_owner (SET LOCAL ROLE, as StatementPointerPhysicalIdentity1786721350000).
 * Self-checks (rolled back on failure): the six functions with exactly the reviewed owner / definer / config / EXECUTE
 * grantees; secure-owner invariants (R4: the rab_secure_owner body names no crewflow-owned table).
 * down(): drops the six functions (no data).
 */
export class HwsCutoverCopyFunctions1786721510000 implements MigrationInterface {
  name = 'HwsCutoverCopyFunctions1786721510000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    await withCrewflowCoreCreate(queryRunner, async () => {
      for (const sql of HWS_CUTOVER_CREWFLOW_FUNCTIONS_SQL) await queryRunner.query(sql);
      await queryRunner.query(`ALTER FUNCTION core.hws_cutover_schema(uuid) OWNER TO crewflow`);
      await queryRunner.query(`ALTER FUNCTION core.hws_cutover_source_sql(text) OWNER TO crewflow`);
      await queryRunner.query(`ALTER FUNCTION core.hws_cutover_probe(uuid) OWNER TO crewflow`);
      await queryRunner.query(`ALTER FUNCTION core.hws_cutover_copy_batch(uuid, text, text, integer) OWNER TO crewflow`);
      await queryRunner.query(`ALTER FUNCTION core.hws_cutover_verify_range(uuid, text, text, integer) OWNER TO crewflow`);
    });
    for (const fn of ['hws_cutover_schema(uuid)', 'hws_cutover_source_sql(text)', 'hws_cutover_probe(uuid)', 'hws_cutover_copy_batch(uuid, text, text, integer)', 'hws_cutover_verify_range(uuid, text, text, integer)']) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION core.${fn} FROM PUBLIC`);
    }
    await queryRunner.query('SET LOCAL ROLE rab_secure_owner');
    await queryRunner.query(HWS_CUTOVER_RECONCILE_SQL);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.hws_cutover_reconcile_statement_pointers(uuid, boolean) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.hws_cutover_reconcile_statement_pointers(uuid, boolean) TO crewflow`);
    await queryRunner.query('RESET ROLE');

    const problems = hwsCutoverStateProblems((await queryRunner.query(HWS_CUTOVER_STATE_SQL)) as Array<{ fn: string; state: string }>, true);
    if (problems.length) throw new Error(`${this.name}: self-check failed (rolled back):\n  ${problems.join('\n  ')}`);
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    await queryRunner.query('SET LOCAL ROLE rab_secure_owner');
    await queryRunner.query('DROP FUNCTION IF EXISTS core.hws_cutover_reconcile_statement_pointers(uuid, boolean)');
    await queryRunner.query('RESET ROLE');
    await queryRunner.query('DROP FUNCTION IF EXISTS core.hws_cutover_verify_range(uuid, text, text, integer)');
    await queryRunner.query('DROP FUNCTION IF EXISTS core.hws_cutover_copy_batch(uuid, text, text, integer)');
    await queryRunner.query('DROP FUNCTION IF EXISTS core.hws_cutover_probe(uuid)');
    await queryRunner.query('DROP FUNCTION IF EXISTS core.hws_cutover_source_sql(text)');
    await queryRunner.query('DROP FUNCTION IF EXISTS core.hws_cutover_schema(uuid)');
    const problems = hwsCutoverStateProblems((await queryRunner.query(HWS_CUTOVER_STATE_SQL)) as Array<{ fn: string; state: string }>, false);
    if (problems.length) throw new Error(`${this.name}: down() self-check failed (rolled back):\n  ${problems.join('\n  ')}`);
  }

  private async preflight(queryRunner: QueryRunner): Promise<void> {
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const problems = bootstrapIdentityProblems(f);
    if (f && !f.su && !f.can_set_secure) problems.push('cannot SET ROLE rab_secure_owner (owner of core.worker_dispatch_pointer and of the reconcile function)');
    if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }
}

/** This session resolves names in pg_catalog only; every object named here is core-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}
