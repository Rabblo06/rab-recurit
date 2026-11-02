import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import {
  BOOTSTRAP_IDENTITY_SQL,
  BootstrapIdentityFacts,
  bootstrapIdentityProblems,
  OUTBOX_FUNCTIONS_EXPECTED,
  OUTBOX_FUNCTIONS_STATE_SQL,
  OUTBOX_POINTERS_PURGE_SQL,
  OUTBOX_TRIGGERS_DOWN_SQL,
  OUTBOX_TRIGGERS_EXPECTED,
  OUTBOX_TRIGGERS_STATE_SQL,
  OUTBOX_TRIGGERS_UP_SQL,
} from '../worker-dispatch-pointer-sql';

/**
 * Phase D / D1 + D2: the pointer triggers on the three core outboxes (email_outbox, push_delivery, realtime_event).
 * SQL owner-approved 2026-11-01 (docs/plans/PHASE-D-SQL-GATE.md); exact SQL in ../worker-dispatch-pointer-sql.ts. Executed on disposable test
 * databases only. Write cost accepted by the owner (performance gate 2026-11-01, docs/plans/PHASE-D-PERFORMANCE-GATE.md).
 *
 * Three SECURITY DEFINER trigger functions (rab_secure_owner, `search_path = pg_catalog, pg_temp`, no EXECUTE grant to any
 * login — a trigger needs none to fire), nine AFTER ROW triggers and three AFTER TRUNCATE statement triggers (E-4). Each
 * function, in the producer's own transaction:
 *   - refuses to run anywhere but its own table in `core` (TG_TABLE_NAME, E-2), AFTER, ROW (or STATEMENT for TRUNCATE),
 *     and on a row whose columns are not the reviewed built-in types;
 *   - mirrors the Worker dispatcher's due predicate into `due_at` (email: PENDING now, QUEUED queued_at + 2 min,
 *     PROCESSING processing_at + 10 min, RETRY updated_at + 5 min; push: PENDING now until first published, then
 *     queued_at + 2 min (Agent B's stale-PENDING rule), PROCESSING + 10 min, RETRY + 5 min; realtime: pending/retry
 *     COALESCE(next_retry_at, now), processing lease_expires_at) — a state the dispatcher would never pick up (terminal,
 *     or a NULL timestamp) deletes the pointer; TRUNCATE deletes the queue's pointers;
 *   - clears any claim on the pointer (claim_token / claimed_at) whenever the subject changes state;
 *   - refuses (42501) a change of the SOURCE row's id / organisation / workspace and a realtime workspace that is not the
 *     organisation's; an existing pointer with another scope is RE-POINTED to the row's scope (E-3, repoint_count + 1);
 *   - NOTIFYs `crewflow_worker_wake` (payload = queue label) when the pointer is due now AND the writing session set
 *     `crewflow.dispatch_notify = on` (E-1: event mode only; default off ⇒ no NOTIFY at all).
 * The WHEN clauses skip the function for writes that cannot change a pointer (retention purges of terminal rows, updates
 * of unrelated columns).
 *
 * E-8: `SET LOCAL lock_timeout = '5s'` first: CREATE / DROP TRIGGER take SHARE ROW EXCLUSIVE on each outbox; behind a long
 * transaction the deploy fails (55P03, rolled back, nothing applied) instead of stalling every write. Retry: re-run.
 * Authority: the CF-41 / Phase 0b bootstrap identity (TRIGGER on the crewflow-owned tables as a member of crewflow,
 * EXECUTE on the functions as a member of rab_secure_owner). No grant to any login, no table or policy change.
 * Self-check: the twelve triggers exactly and ENABLED (E-5), the three functions' owner / config / ACL (E-10), and
 * secureOwnerInvariantViolations() empty (attachments on the reviewed list; R4 may now contain the three outbox tables,
 * exempted per (function, own table) pair: R4_PHASE_D_TRIGGER_PAIRS, N-1).
 *
 * No backfill: open rows written before this migration get their pointer on their next state change, and the Worker's
 * per-scope reconciliation cycle (WORKER_DISPATCH_RECONCILE_SECONDS) dispatches them meanwhile.
 *
 * down(): drops the twelve triggers and the three functions (lock_timeout too), then removes the email / push / realtime pointers (as
 * rab_secure_owner: the owner-only policy hides them from everyone else).
 */
export class WorkerDispatchPointerOutboxTriggers1786721310000 implements MigrationInterface {
  name = 'WorkerDispatchPointerOutboxTriggers1786721310000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    for (const sql of OUTBOX_TRIGGERS_UP_SQL) await queryRunner.query(sql);

    const [row] = (await queryRunner.query(OUTBOX_TRIGGERS_STATE_SQL)) as Array<{ triggers: string | null }>;
    if (row?.triggers !== OUTBOX_TRIGGERS_EXPECTED) {
      throw new Error(`${this.name}: unexpected triggers after create (rolled back): ${row?.triggers ?? 'none'}`);
    }
    // E-10: the functions themselves — owner, SECURITY DEFINER, pinned search_path, EXECUTE held by the owner only.
    const [fn] = (await queryRunner.query(OUTBOX_FUNCTIONS_STATE_SQL)) as Array<{ functions: string | null }>;
    if (fn?.functions !== OUTBOX_FUNCTIONS_EXPECTED) {
      throw new Error(`${this.name}: unexpected trigger function shape after create (rolled back): ${fn?.functions ?? 'none'}`);
    }
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    const f = await this.preflight(queryRunner);
    if (!f.su && !f.can_set_secure) {
      throw new Error(`${this.name}: down() must be able to SET ROLE rab_secure_owner to remove the pointers. Refusing.`);
    }
    for (const sql of OUTBOX_TRIGGERS_DOWN_SQL) await queryRunner.query(sql);
    await queryRunner.query('SET LOCAL ROLE rab_secure_owner');
    await queryRunner.query(OUTBOX_POINTERS_PURGE_SQL);
    await queryRunner.query('RESET ROLE');
    const [gone] = (await queryRunner.query(
      `SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'core'::regnamespace
                             AND p.proname IN ('worker_dispatch_pointer_email_trg', 'worker_dispatch_pointer_push_trg', 'worker_dispatch_pointer_realtime_trg'))
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g
                           WHERE g.tgrelid IN ('core.email_outbox'::regclass, 'core.push_delivery'::regclass, 'core.realtime_event'::regclass)
                             AND g.tgname LIKE '%\\_dispatch\\_pointer\\_%') AS gone`,
    )) as Array<{ gone: boolean }>;
    if (gone?.gone !== true) throw new Error(`${this.name}: outbox pointer triggers remain after down() (rolled back).`);
  }

  private async preflight(queryRunner: QueryRunner): Promise<BootstrapIdentityFacts> {
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const problems = bootstrapIdentityProblems(f);
    const [t] = (await queryRunner.query(`SELECT pg_catalog.to_regclass('core.worker_dispatch_pointer') IS NOT NULL AS present`)) as Array<{ present: boolean }>;
    if (!t?.present) problems.push('core.worker_dispatch_pointer does not exist (WorkerDispatchPointer1786721300000 first)');
    if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
    return f!;
  }
}

/** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is core-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}
