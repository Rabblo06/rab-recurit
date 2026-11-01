import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import {
  BOOTSTRAP_IDENTITY_SQL,
  BootstrapIdentityFacts,
  bootstrapIdentityProblems,
  DUE_WORK_EXECUTORS_AFTER,
  DUE_WORK_EXECUTORS_BEFORE,
  DUE_WORK_EXECUTORS_SQL,
  DUE_WORK_TO_WORKER_DOWN_SQL,
  DUE_WORK_TO_WORKER_UP_SQL,
  WORKER_ROLE_FACTS_SQL,
  WorkerRoleFacts,
  workerRoleProblems,
} from '../worker-dispatch-pointer-sql';

/**
 * Phase D / D5 (closes D0-A1 / E7 for the due-work timers): EXECUTE on core.worker_claim_due_work,
 * core.worker_complete_due_work and core.worker_reschedule_due_work moves from crewflow + crewflow_app to crewflow_worker
 * only. SQL owner-approved 2026-11-01, APPLICATION GATED: never executed anywhere; it runs only after the D5 cutover gate
 * below holds and the owner separately approves the cutover.
 *
 * GATED: this file lives in `core/gated-migrations/`, outside the `core/migrations/*.{ts,js}` glob TypeORM and the M2
 * harness load, so no environment applies it by accident. 1786721330000 is a PLACEHOLDER id (E-10): at cutover the file
 * and class are renamed to a NEW id newer than every applied migration (so fresh and upgraded databases apply it in the
 * same order) and then moved into `core/migrations/`. That move IS the cutover, and is allowed
 * only when every item of the D5 cutover gate (docs/runbooks/phase-d-worker-dispatch.md §6) holds (every Worker in every
 * environment authenticates as crewflow_worker — per_scope included, because per_scope still claims due work; the API
 * refuses crewflow_worker and never holds these grants; no old Worker image on crewflow_app remains; rollback and
 * mixed-version behaviour tested). Until then an old Worker on crewflow_app keeps claiming manager-confirmation timeouts,
 * as today.
 *
 * After it: the API login can no longer claim, complete or reschedule any tenant's timer pointers (the cross-tenant read and
 * delete of D0-A1). Producers are unchanged: they keep INSERT / UPDATE on core.worker_due_work under RLS (schedulePointer).
 * Function bodies, owners, search_path and the NOT FORCE allowlist entry are unchanged.
 *
 * Preconditions: bootstrap identity; crewflow_worker has the reviewed shape; the three functions have exactly the
 * pre-cutover executors (crewflow, crewflow_app, owner). Self-check: exactly the post-cutover executors and
 * secureOwnerInvariantViolations() empty. down(): the exact reverse (an emergency rollback to crewflow_app Workers).
 */
export class WorkerDueWorkClaimsToWorkerRole1786721330000 implements MigrationInterface {
  name = 'WorkerDueWorkClaimsToWorkerRole1786721330000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner, DUE_WORK_EXECUTORS_BEFORE);
    for (const sql of DUE_WORK_TO_WORKER_UP_SQL) await queryRunner.query(sql);
    await this.expectExecutors(queryRunner, DUE_WORK_EXECUTORS_AFTER, 'after');
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner, DUE_WORK_EXECUTORS_AFTER);
    for (const sql of DUE_WORK_TO_WORKER_DOWN_SQL) await queryRunner.query(sql);
    await this.expectExecutors(queryRunner, DUE_WORK_EXECUTORS_BEFORE, 'after down()');
  }

  private async preflight(queryRunner: QueryRunner, expected: readonly string[]): Promise<void> {
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const [w] = (await queryRunner.query(WORKER_ROLE_FACTS_SQL)) as WorkerRoleFacts[];
    const problems = [...bootstrapIdentityProblems(f), ...workerRoleProblems(w)];
    if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
    await this.expectExecutors(queryRunner, expected, 'before');
  }

  private async expectExecutors(queryRunner: QueryRunner, expected: readonly string[], when: string): Promise<void> {
    const lines = ((await queryRunner.query(DUE_WORK_EXECUTORS_SQL)) as Array<{ line: string }>).map((r) => r.line);
    if (JSON.stringify(lines) !== JSON.stringify(expected)) {
      throw new Error(`${this.name}: due-work EXECUTE grants ${when} are ${JSON.stringify(lines)}, expected ${JSON.stringify(expected)}. Refusing.`);
    }
  }
}

/** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is core-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}
