import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import {
  BOOTSTRAP_IDENTITY_SQL,
  BootstrapIdentityFacts,
  bootstrapIdentityProblems,
  expectedWorkerDispatchPrivilegeLines,
  POINTER_WRITERS_PRESENT_SQL,
  WORKER_DISPATCH_POINTER_DOWN_SQL,
  WORKER_DISPATCH_POINTER_EXPECTED_STATE,
  WORKER_DISPATCH_POINTER_STATE_SQL,
  WORKER_DISPATCH_POINTER_UP_SQL,
  WORKER_ROLE_FACTS_SQL,
  WorkerRoleFacts,
  workerDispatchPrivilegeChecksSql,
  workerRoleProblems,
} from '../worker-dispatch-pointer-sql';

/**
 * Phase D / D1 (owner decisions 2026-10-31): secure global dispatch claims. SQL owner-approved 2026-11-01 (docs/plans/PHASE-D-SQL-GATE.md); the exact SQL is
 * in ../worker-dispatch-pointer-sql.ts. Executed on disposable test databases only; a real environment needs the separate
 * release approval and the operator-created crewflow_worker (docs/runbooks/phase-d-worker-dispatch.md §2).
 * Not in production-migration-approval.ts.
 *
 *   - `core.worker_dispatch_pointer`: routing ids only (queue label, subject id, organisation, workspace, due time, claim
 *     token, claim count). Owner rab_secure_owner, ENABLE + FORCE RLS in this same migration, an owner-only permissive
 *     policy (CURRENT_USER = rab_secure_owner — true only inside the definers) and a RESTRICTIVE deny-all for crewflow,
 *     crewflow_app and crewflow_worker. No table privilege for any login.
 *   - `core.worker_claim_{email_dispatch,push_dispatch,realtime_publish,statement_dispatch}(p_limit)`: SECURITY DEFINER,
 *     server-fixed lease (30/30/15/60 s) and per-organisation cap (10/10/25/10), server-generated claim token, batch
 *     clamped 1..200, fair across organisations (random pivot, one index descent per organisation), FOR UPDATE SKIP LOCKED.
 *     Return (subject_id, organisation_id, workspace_id, claim_token, claim_count) only. EXECUTE crewflow_worker only.
 *   - `core.worker_release_dispatch_claim(queue, subject, token, retry_s)`: re-times the caller's own claim by 1..300 s.
 *     Never deletes. EXECUTE crewflow_worker only.
 *   - `core.worker_dispatch_claim_impl(...)`: the claim body, SECURITY INVOKER, executable by no login.
 * Nothing writes pointers yet: the triggers come with 1786721310000 / 1786721320000. No backfill (a cross-tenant copy from
 * FORCE tables is the privileged ROW_COPY class); the Worker's slow per-scope reconciliation cycle covers rows written
 * before the triggers.
 *
 * SECURITY TRADE-OFF (owner-only policy, no tenant-scoped policy): global discovery must see due pointers across tenants;
 * rows hold routing ids only, never a payload. Versus NOT FORCE: same owner visibility, FORCE stays on, no allowlist entry,
 * and the runtime logins are denied twice (no privilege + RESTRICTIVE policy). Residual: whoever can act as
 * rab_secure_owner (the migration identity) sees all pointers, as with every rab_secure_owner table.
 *
 * Preconditions (fail closed, nothing created otherwise): the CF-41 / Phase 0b bootstrap identity; `crewflow_worker`
 * exists with the reviewed shape (LOGIN, INHERIT, member of crewflow_app WITH INHERIT TRUE / SET FALSE and nothing else,
 * no member of its own, owns nothing, no SUPERUSER / BYPASSRLS / CREATEROLE / CREATEDB / REPLICATION). The role is
 * created by an operator (dev: postgres-init/01-roles.sql + the membership step; CI / M2: the harness), never here.
 * Self-check before commit: exact table / policy / function / ACL state, effective privileges of the three logins, and
 * secureOwnerInvariantViolations() empty.
 *
 * down(): drops the five functions, the claim body and the table (pointers are derived data; the per-scope cycles still
 * see every subject row). Only after 1786721310000's and 1786721320000's down() (TypeORM reverts in order); refuses (E-9) while
 * any outbox trigger function exists or the statement function still has its live body.
 */
export class WorkerDispatchPointer1786721300000 implements MigrationInterface {
  name = 'WorkerDispatchPointer1786721300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await preflight(queryRunner, this.name);
    const [exists] = (await queryRunner.query(`SELECT pg_catalog.to_regclass('core.worker_dispatch_pointer') IS NOT NULL AS present`)) as Array<{ present: boolean }>;
    if (exists?.present) throw new Error(`${this.name}: core.worker_dispatch_pointer already exists. Refusing.`);

    for (const sql of WORKER_DISPATCH_POINTER_UP_SQL) await queryRunner.query(sql);

    const [state] = (await queryRunner.query(WORKER_DISPATCH_POINTER_STATE_SQL)) as Array<Record<string, unknown>>;
    const problems = Object.entries(WORKER_DISPATCH_POINTER_EXPECTED_STATE)
      .filter(([key, expected]) => state?.[key] !== expected)
      .map(([key, expected]) => `${key}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(state?.[key])}`);
    const lines = ((await queryRunner.query(workerDispatchPrivilegeChecksSql())) as Array<{ line: string }>).map((r) => r.line).sort();
    const expectedLines = expectedWorkerDispatchPrivilegeLines();
    if (JSON.stringify(lines) !== JSON.stringify(expectedLines)) {
      problems.push(`effective privileges: ${lines.filter((l) => !expectedLines.includes(l)).join('; ')}`);
    }
    if (problems.length) throw new Error(`${this.name}: unexpected state after create (rolled back):\n  ${problems.join('\n  ')}`);

    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const problems = bootstrapIdentityProblems(f);
    if (problems.length) throw new Error(`${this.name}: refusing to run down as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
    // E-9: never drop the table while a live trigger function still writes to it (every outbox / payroll write would
    // then fail with 42P01). TypeORM's order guarantees this; a partial or manual revert is refused instead.
    const [w] = (await queryRunner.query(POINTER_WRITERS_PRESENT_SQL)) as Array<{ outbox_functions: boolean; statement_function_live: boolean }>;
    if (w?.outbox_functions !== false || w?.statement_function_live !== false) {
      throw new Error(
        `${this.name}: refusing down(): pointer trigger functions still write to core.worker_dispatch_pointer ` +
          `(outbox functions present: ${w?.outbox_functions}; statement function live: ${w?.statement_function_live}). ` +
          'Revert 1786721340000 → 1786721320000 → 1786721310000 first.',
      );
    }
    for (const sql of WORKER_DISPATCH_POINTER_DOWN_SQL) await queryRunner.query(sql);
    const [gone] = (await queryRunner.query(
      `SELECT pg_catalog.to_regclass('core.worker_dispatch_pointer') IS NULL
              AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'core'::regnamespace
                                 AND p.proname IN ('worker_dispatch_claim_impl', 'worker_claim_email_dispatch', 'worker_claim_push_dispatch',
                                                   'worker_claim_realtime_publish', 'worker_claim_statement_dispatch', 'worker_release_dispatch_claim')) AS gone`,
    )) as Array<{ gone: boolean }>;
    if (gone?.gone !== true) throw new Error(`${this.name}: dispatch pointer objects remain after down() (rolled back).`);
  }
}

/** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is core-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}

async function preflight(queryRunner: QueryRunner, name: string): Promise<void> {
  const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
  const [w] = (await queryRunner.query(WORKER_ROLE_FACTS_SQL)) as WorkerRoleFacts[];
  const problems = [...bootstrapIdentityProblems(f), ...workerRoleProblems(w)];
  if (problems.length) throw new Error(`${name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
}
