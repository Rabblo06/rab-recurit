import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import {
  HWS_CUTOVER_CREWFLOW_FUNCTIONS_SQL,
  HWS_CUTOVER_FENCE_TRIGGER,
  HWS_CUTOVER_FENCE_TRIGGERS_SQL,
  HWS_CUTOVER_SECURE_FUNCTIONS_SQL,
  HWS_CUTOVER_STATE_SECURITY_SQL,
  HWS_CUTOVER_STATE_SQL,
  HWS_CUTOVER_STATE_TABLE_SQL,
  HWS_CUTOVER_TABLE_FACTS_SQL,
  HWS_CUTOVER_TABLES,
  HwsCutoverTableFacts,
  hwsCutoverStateProblems,
  hwsCutoverTableProblems,
} from '../hws-cutover-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';

const CREWFLOW_FUNCTIONS = [
  'hws_cutover_schema(uuid)',
  'hws_cutover_source_sql(text)',
  'hws_cutover_probe(uuid)',
  'hws_cutover_copy_batch(uuid, text, text, integer)',
  'hws_cutover_verify_range(uuid, text, text, integer)',
  'hws_cutover_started_any()',
  'hws_cutover_core_fence()',
];
const SECURE_FUNCTIONS = ['hws_cutover_drop_new_statement_pointers(uuid, uuid[])', 'hws_cutover_purge_core_statement_pointers(uuid)'];

/**
 * OWNER-DB-ULTIMATE Part C3, option A′ — PENDING OWNER CHOICE (A′ vs B′) AND SQL REVIEW (docs/plans/phase-x3/SQL-DRAFTS.md
 * §6 "FOR OWNER REVIEW — C3"). Until the owner approves, this migration runs ONLY on throwaway databases. Not merged
 * anywhere yet, so it is still edited in place (security review 2026-11-15: L-2 state table, M-3 fence, M-1 pointer split).
 *
 * Creates (SQL text and reasoning: ../hws-cutover-sql.ts):
 *   - core.hws_cutover_state: per-workspace cutover state (started / verified), crewflow-owned, organisation_id, ENABLE +
 *     FORCE RLS with a tenant policy (USING + WITH CHECK) and an owner-only SELECT policy for the boot-check definer;
 *     crewflow_app SELECT only; the runtime login's DML refused by statement-level grant-parity guard triggers.
 *   - crewflow functions: guard hws_cutover_schema, source builder, definers probe / copy_batch / verify_range (FORCE lifted
 *     only inside their own transaction), hws_cutover_started_any (boot check), hws_cutover_core_fence (trigger function).
 *   - fence triggers `hws_cutover_core_fence` on the 21 core copies (review M-3).
 *   - rab_secure_owner functions: hws_cutover_drop_new_statement_pointers, hws_cutover_purge_core_statement_pointers (EXECUTE
 *     to crewflow; R4 list unchanged: their bodies name only worker_dispatch_pointer).
 * EXECUTE: REVOKE ALL FROM PUBLIC on every function; crewflow_app holds EXECUTE only on hws_cutover_started_any (boolean).
 *
 * Identity: the CF-41 bootstrap identity (the owner login, or a superuser on a disposable cluster), able to SET ROLE
 * rab_secure_owner. Self-checks (rolled back on failure): every function's owner / definer / config / grantees; the table's
 * owner, RLS, policies, grants, guard and fence triggers; secure-owner invariants. down(): drops all of it (the state table's
 * rows go with it).
 */
export class HwsCutoverCopyFunctions1786721510000 implements MigrationInterface {
  name = 'HwsCutoverCopyFunctions1786721510000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    await withCrewflowCoreCreate(queryRunner, async () => {
      for (const sql of HWS_CUTOVER_STATE_TABLE_SQL) await queryRunner.query(sql);
      await queryRunner.query('ALTER TABLE core.hws_cutover_state OWNER TO crewflow');
      for (const sql of HWS_CUTOVER_CREWFLOW_FUNCTIONS_SQL) await queryRunner.query(sql);
      for (const fn of CREWFLOW_FUNCTIONS) await queryRunner.query(`ALTER FUNCTION core.${fn} OWNER TO crewflow`);
    });
    for (const sql of HWS_CUTOVER_STATE_SECURITY_SQL) await queryRunner.query(sql);
    for (const fn of CREWFLOW_FUNCTIONS) await queryRunner.query(`REVOKE ALL ON FUNCTION core.${fn} FROM PUBLIC`);
    await queryRunner.query('GRANT EXECUTE ON FUNCTION core.hws_cutover_started_any() TO crewflow_app');
    for (const sql of HWS_CUTOVER_FENCE_TRIGGERS_SQL) await queryRunner.query(sql);
    await queryRunner.query('SET LOCAL ROLE rab_secure_owner');
    for (const sql of HWS_CUTOVER_SECURE_FUNCTIONS_SQL) await queryRunner.query(sql);
    for (const fn of SECURE_FUNCTIONS) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION core.${fn} FROM PUBLIC`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.${fn} TO crewflow`);
    }
    await queryRunner.query('RESET ROLE');

    const problems = [
      ...hwsCutoverStateProblems((await queryRunner.query(HWS_CUTOVER_STATE_SQL)) as Array<{ fn: string; state: string }>, true),
      ...hwsCutoverTableProblems(((await queryRunner.query(HWS_CUTOVER_TABLE_FACTS_SQL)) as HwsCutoverTableFacts[])[0]),
    ];
    if (problems.length) throw new Error(`${this.name}: self-check failed (rolled back):\n  ${problems.join('\n  ')}`);
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    for (const t of HWS_CUTOVER_TABLES) await queryRunner.query(`DROP TRIGGER IF EXISTS ${HWS_CUTOVER_FENCE_TRIGGER} ON core.${t}`);
    await queryRunner.query('SET LOCAL ROLE rab_secure_owner');
    for (const fn of SECURE_FUNCTIONS) await queryRunner.query(`DROP FUNCTION IF EXISTS core.${fn}`);
    await queryRunner.query('RESET ROLE');
    for (const fn of [...CREWFLOW_FUNCTIONS].reverse()) await queryRunner.query(`DROP FUNCTION IF EXISTS core.${fn}`);
    await queryRunner.query('DROP TABLE IF EXISTS core.hws_cutover_state');
    const problems = hwsCutoverStateProblems((await queryRunner.query(HWS_CUTOVER_STATE_SQL)) as Array<{ fn: string; state: string }>, false);
    if (problems.length) throw new Error(`${this.name}: down() self-check failed (rolled back):\n  ${problems.join('\n  ')}`);
  }

  private async preflight(queryRunner: QueryRunner): Promise<void> {
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const problems = bootstrapIdentityProblems(f);
    if (f && !f.su && !f.can_set_secure) problems.push('cannot SET ROLE rab_secure_owner (owner of core.worker_dispatch_pointer and of the pointer functions)');
    if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }
}

/** This session resolves names in pg_catalog only; every object named here is core-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}
