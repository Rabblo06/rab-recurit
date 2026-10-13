import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.realtime_event` — the durable outbox for cross-process real-time
 * delivery (Stage 1 of the real-time design in
 * `docs/architecture/REALTIME-PUBSUB-DESIGN.md`). Reconciled against
 * `core.worker_event` (`WorkerEventSchema1786673200000`) before writing this
 * migration; deliberately a SEPARATE table, not a repurposing of it, because
 * the two solve different problems despite looking superficially similar:
 *
 *  - `worker_event` is written by a WORKER'S OWN PERIODIC SCAN discovering a
 *    condition after the fact (late clock-in, confirmation timeout, shift
 *    reminders — see that file's claim call sites, all in
 *    `rab-worker/src/queues/**`). Nothing in the request path ever inserts
 *    into it, and its own doc comment states "no manager/staff-facing
 *    feature reads it."
 *  - This table is written by the REQUEST-PATH BUSINESS MUTATION ITSELF,
 *    in the SAME transaction as the mutation (Stage 1 requirement 2) — e.g.
 *    `OfferService.sendOne()` inserts a row in the same `manager` the offer
 *    and assignment are created in. Retrofitting `worker_event`'s existing,
 *    tested call sites to also serve this purpose would risk the five
 *    production jobs that already depend on its current "detect once,
 *    notify once, no payload, no recipient" shape.
 *  - `worker_event` has no payload or recipient/target column — this table
 *    needs both: a specific `target_user_id` (Stage 1 requirement 3,
 *    "authorised recipient/target scope"; most catalogued events in the
 *    design doc are addressed to one person, not merely org/workspace-wide)
 *    and a minimal `payload` (requirement 1). Per the design doc's own
 *    delivery plan, the payload stays a thin reference — ids only, the
 *    client re-fetches full state over the existing REST API — never a
 *    rendered message or anything resembling PII/secrets.
 *  - `worker_event`'s `processing`/`retry`/`failed` states are explicitly
 *    reserved-but-unused ("not used by this phase's migrated jobs" per its
 *    own doc comment) because every current consumer completes within one
 *    transaction. This table's claim step (publish to Redis, a later stage)
 *    is exactly the multi-transaction, externally-failable operation those
 *    states anticipated — a real lease window with expiry is needed here
 *    (unlike `worker_event`, which never persists a `processing` row), so
 *    `lease_expires_at` is new rather than borrowed.
 *
 * The claim/fencing idiom instead follows `core.email_outbox`'s
 * `processing_token` pattern (`EmailOutboxDeliveryFencing1786673900000`):
 * `email_outbox` is the closest existing precedent for "a row written by a
 * business transaction, later claimed and delivered — at least once, never
 * exactly once — by a worker with a fencing token so a reclaimed lease loser
 * can't overwrite a newer attempt's outcome." Same shape here as
 * `claim_token`/`lease_expires_at`.
 *
 * `event_key UNIQUE` + `INSERT ... ON CONFLICT DO NOTHING RETURNING id` is
 * the cross-replica dedup authority, the same idiom as `worker_event` and
 * `replacement_request.declined_shift_assignment_id`.
 *
 * Tenant-scoped (`organisation_id` always; `workspace_id` nullable, NULL
 * meaning "org-wide" under the policy, never "exempt from isolation") — gets
 * the full ENABLE + FORCE + real USING/WITH CHECK treatment this codebase's
 * non-negotiable rules require for every tenant table, in this same
 * migration. No explicit GRANT statements needed: `postgres-init/01-roles.sql`'s
 * `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON
 * TABLES TO rab_app` already covers a newly created core table, the same
 * reason `worker_event`'s own migration has none.
 *
 * `target_user_id` is never exposed by this migration to any endpoint —
 * Stage 1 requirement 3 ("never expose raw outbox records through ordinary
 * REST/GraphQL") is satisfied by there being no controller/resolver for this
 * table at all, not by a column-level restriction. Recipient-level delivery
 * restriction (a client only ever receiving events addressed to it) is a
 * later-stage gateway concern once a transport exists; nothing untrusted can
 * query this table directly today.
 *
 * EXPLICIT GRANT, not inherited: `CrewflowAppRestrictedRuntimeRole1786687000000`
 * was a one-time catch-up that replicated `crewflow`'s privileges onto
 * `crewflow_app` for every table that existed AT THAT MIGRATION'S RUN TIME —
 * it did not also install an `ALTER DEFAULT PRIVILEGES FOR ROLE crewflow ...
 * TO crewflow_app` rule, so a table created by a LATER migration (this one)
 * gets nothing automatically. Confirmed empirically against the local
 * database: `pg_default_acl` has no `crewflow`-owned entry in `core`, only
 * the pre-existing `rab_owner -> rab_app` one from before the crewflow
 * rename. Granting explicitly here, in the same migration that creates the
 * table, is both the correct per-table fix (this codebase's own
 * non-negotiable rule for RLS+grants) and the one that doesn't silently
 * depend on a global catch-up rule that doesn't exist. The missing
 * permanent default-privilege rule itself is a separate, pre-existing gap
 * (affects every table any future migration creates, not just this one) —
 * tracked, not fixed here, since fixing it is a broader change than Stage 1
 * asked for. SELECT/INSERT/UPDATE/DELETE only, matching exactly what
 * `crewflow_app` already holds on `worker_event`/`email_outbox` — never
 * TRIGGER/REFERENCES/TRUNCATE.
 */
export class RealtimeEventOutbox1786698000000 implements MigrationInterface {
  name = 'RealtimeEventOutbox1786698000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.realtime_event (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id      uuid REFERENCES core.manager_workspace(id),
        target_user_id    uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        event_key         text NOT NULL UNIQUE,
        event_type        text NOT NULL,
        entity_type       text NOT NULL,
        entity_id         uuid NOT NULL,
        payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
        schema_version    integer NOT NULL DEFAULT 1,
        status            text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'completed', 'retry', 'failed', 'cancelled')),
        attempt_count     integer NOT NULL DEFAULT 0,
        max_attempts      integer NOT NULL DEFAULT 10,
        claimed_at        timestamptz,
        claim_token       uuid,
        lease_expires_at  timestamptz,
        next_retry_at     timestamptz,
        processed_at      timestamptz,
        last_error_code   text,
        last_error_at     timestamptz,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`CREATE INDEX realtime_event_org_idx ON core.realtime_event (organisation_id);`);
    await queryRunner.query(`CREATE INDEX realtime_event_entity_idx ON core.realtime_event (entity_type, entity_id);`);
    await queryRunner.query(`CREATE INDEX realtime_event_target_user_idx ON core.realtime_event (target_user_id);`);
    // Drives the claim query: pending/retry rows due now, oldest first.
    await queryRunner.query(`CREATE INDEX realtime_event_claimable_idx ON core.realtime_event (status, next_retry_at, created_at)
      WHERE status IN ('pending', 'retry');`);
    // Drives lease reclaim (a crashed worker's expired claim).
    await queryRunner.query(`CREATE INDEX realtime_event_lease_idx ON core.realtime_event (lease_expires_at) WHERE status = 'processing';`);

    await queryRunner.query(`ALTER TABLE core.realtime_event ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.realtime_event FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY realtime_event_tenant ON core.realtime_event
        USING (
          organisation_id = core.current_org()
          AND (workspace_id IS NULL OR workspace_id = core.current_workspace())
        )
        WITH CHECK (
          organisation_id = core.current_org()
          AND (workspace_id IS NULL OR workspace_id = core.current_workspace())
        );
    `);

    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.realtime_event TO crewflow_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.realtime_event`);
  }
}
