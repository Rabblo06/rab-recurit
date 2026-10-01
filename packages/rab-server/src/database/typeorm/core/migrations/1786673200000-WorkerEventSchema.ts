import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.worker_event` — a preference-independent, durable processing ledger
 * for worker automations, replacing "does a Notification row already exist"
 * as the idempotency mechanism (that check is defeated whenever every
 * recipient has disabled in-app notifications for the relevant type, since
 * `NotificationService.notify()` only inserts a `Notification` row
 * `if (inAppEnabled)` — see `notification.service.ts`).
 *
 * `event_key UNIQUE` is the actual cross-replica deduplication authority —
 * every claim is `INSERT ... ON CONFLICT (event_key) DO NOTHING RETURNING
 * id`, never a SELECT-then-INSERT. A losing INSERT (another replica, or an
 * overlapping tick on the same replica) is the expected, correct outcome
 * of a race, not an error — matching the precedent already established by
 * `replacement_request.declined_shift_assignment_id UNIQUE` +
 * `ON CONFLICT DO NOTHING` (ReplacementRequestSchema1786673100000).
 *
 * `event_key` is a stable, deterministic string per logical occurrence,
 * e.g. `late-clock-in:{assignmentId}`, `shift-reminder-24h:{assignmentId}`,
 * `manager-confirmation-timeout:{offerId}:{deadlineVersion}` — a version/
 * timestamp component is included wherever the same entity can legitimately
 * generate the same logical event more than once (e.g. a shift that's
 * rescheduled after an earlier reminder already fired).
 *
 * This table is pure internal worker infrastructure — no controller ever
 * exposes it, and no manager/staff-facing feature reads it — but it is
 * still genuinely tenant-scoped data (each row belongs to exactly one
 * organisation), so it gets the same ENABLE + FORCE + real USING/WITH CHECK
 * treatment as every other tenant table, per this codebase's own
 * non-negotiable rule. `workspace_id` is nullable (some event types are
 * org-wide, not workspace-scoped) and the policy treats NULL as "matches
 * any workspace within the org" rather than exempting it from tenant
 * isolation entirely.
 *
 * Status values:
 *  - pending    — never actually persisted as a *terminal* state; every
 *                 successful claim is completed or cancelled within the
 *                 SAME transaction as the claiming INSERT (see
 *                 core/database/worker-event.ts) for the lightweight
 *                 "detect once, notify once" events this phase migrates.
 *                 Kept in the CHECK constraint for forward compatibility
 *                 with a heavier event type that needs a real PROCESSING/
 *                 lease window later, without a second migration.
 *  - processing — reserved for that future heavier-job case (a claim that
 *                 legitimately spans more than one DB transaction, e.g. an
 *                 external provider call). Not used by this phase's
 *                 migrated jobs.
 *  - completed  — the business condition held; side effects (notify/audit)
 *                 ran successfully.
 *  - cancelled  — the business condition stopped holding between discovery
 *                 and claim (e.g. the shift was cancelled) — a genuine,
 *                 permanent, non-retryable exit, deliberately distinct from
 *                 `completed` (no side effects ran) and from `failed`
 *                 (nothing went wrong; the event just stopped applying).
 *  - retry      — reserved for the same future heavier-job case as
 *                 `processing`.
 *  - failed     — reserved likewise; this phase's rollback-on-exception
 *                 design means a transient failure never leaves a `failed`
 *                 row at all (the whole transaction, including the
 *                 claiming INSERT, rolls back, so the event is simply
 *                 reclaimed on the next tick — see that file's doc comment
 *                 for why this is the deliberate, non-overengineered choice
 *                 for events whose only work is "notify + audit").
 */
export class WorkerEventSchema1786673200000 implements MigrationInterface {
  name = 'WorkerEventSchema1786673200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.worker_event (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id  uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id     uuid REFERENCES core.manager_workspace(id),
        event_key        text NOT NULL UNIQUE,
        event_type       text NOT NULL,
        entity_type      text NOT NULL,
        entity_id        uuid NOT NULL,
        status           text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'completed', 'retry', 'failed', 'cancelled')),
        attempt_count    integer NOT NULL DEFAULT 0,
        claimed_at       timestamptz,
        claim_token      uuid,
        processed_at     timestamptz,
        last_error_code  text,
        last_error_at    timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`CREATE INDEX worker_event_org_idx ON core.worker_event (organisation_id);`);
    await queryRunner.query(`CREATE INDEX worker_event_entity_idx ON core.worker_event (entity_type, entity_id);`);
    await queryRunner.query(`CREATE INDEX worker_event_status_idx ON core.worker_event (status);`);

    await queryRunner.query(`ALTER TABLE core.worker_event ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.worker_event FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY worker_event_tenant ON core.worker_event
        USING (
          organisation_id = core.current_org()
          AND (workspace_id IS NULL OR workspace_id = core.current_workspace())
        )
        WITH CHECK (
          organisation_id = core.current_org()
          AND (workspace_id IS NULL OR workspace_id = core.current_workspace())
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.worker_event`);
  }
}
