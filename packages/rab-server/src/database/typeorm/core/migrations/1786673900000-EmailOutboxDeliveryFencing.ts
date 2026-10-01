import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 9 — closes the confirmed "provider succeeded, SENT persist failed"
 * defect: a row could get permanently stuck PROCESSING because (a) nothing
 * fenced a stale worker's late writes against a newer claim, and (b) the
 * dispatcher's stale-row recovery had no durable signal to tell "the
 * provider was never contacted, safe to retry" apart from "the provider may
 * already have sent this — retrying could duplicate it."
 *
 * Three columns, each answering one question the recovery logic could not
 * previously answer at all:
 *
 *   processing_token          -- "does THIS worker still own this row?" A
 *                                 fresh UUID minted at claim time; every
 *                                 subsequent write for that attempt is
 *                                 WHERE-guarded on it matching, so a worker
 *                                 whose lease was reclaimed by someone else
 *                                 can never overwrite a newer attempt's
 *                                 result (a stale-worker-wakes-up race).
 *   provider_call_started_at  -- "did we ever actually reach the provider?"
 *                                 Set in its own committed step, AFTER
 *                                 revalidation but BEFORE the provider call.
 *                                 NULL means recovery can retry unconditionally
 *                                 (nothing was ever sent); NOT NULL means the
 *                                 outcome is genuinely ambiguous and recovery
 *                                 must consult the configured driver's
 *                                 ambiguous-retry safety before touching it.
 *   dispatch_generation       -- durable, CAS'd (via this row's own UPDATE,
 *                                 which Postgres serializes per-row) counter
 *                                 driving the BullMQ jobId suffix for a
 *                                 RECOVERY republish only (see
 *                                 email-queue.service.ts's `republish()`).
 *                                 A first-ever publish (fast path, or the
 *                                 dispatcher's first pickup of a still-PENDING
 *                                 row) never bumps this and always uses
 *                                 generation 0 — preserving today's BullMQ
 *                                 jobId-dedupe behavior for that case
 *                                 unchanged. Only a genuine "this row already
 *                                 had an attempt that may be dead" recovery
 *                                 bumps it, so the new BullMQ job is never
 *                                 blocked by the old job's terminal state
 *                                 (completed-with-7-day-retention, or
 *                                 failed-and-removed) — the actual root cause
 *                                 of the confirmed bug.
 *
 * All three are nullable/defaulted so existing rows (mid-flight at deploy
 * time) are simply treated as "no fencing token held, never started" by the
 * new code — the safest possible reading, never a false "already attempted."
 */
export class EmailOutboxDeliveryFencing1786673900000 implements MigrationInterface {
  name = 'EmailOutboxDeliveryFencing1786673900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.email_outbox
        ADD COLUMN processing_token         uuid,
        ADD COLUMN provider_call_started_at timestamptz,
        ADD COLUMN dispatch_generation       integer NOT NULL DEFAULT 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.email_outbox
        DROP COLUMN IF EXISTS dispatch_generation,
        DROP COLUMN IF EXISTS provider_call_started_at,
        DROP COLUMN IF EXISTS processing_token;
    `);
  }
}
