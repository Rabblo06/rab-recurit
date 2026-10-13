import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 6 — durable push-notification delivery, two tables:
 *
 * `core.push_device` — one row per (user, device). `device_id` is the SAME opaque,
 * client-generated, non-secret identifier already threaded through `core.user_session`/
 * `core.refresh_token` (see `device-id.util.ts`) — reused, never a second device concept.
 * `push_token_encrypted` is the FCM registration token (or, per current Firebase guidance, a
 * Firebase Installation ID-addressed token), encrypted at rest via `SecretEncryptionService`,
 * same `bytea`/`select:false` convention already used for `user.totp_secret_encrypted` and
 * `platform_config.smtp_password_encrypted` — never logged, never returned by an ordinary
 * `find()`. `UNIQUE (user_id, device_id)`: a registration refresh/replacement is an UPDATE of
 * the existing row's token, never a second row for the same physical device — this is what
 * keeps "same user, multiple devices" and "re-registering after a token refresh" both correct
 * without a growing pile of stale rows.
 *
 * `core.push_delivery` — one row per (notification, device) PAIR, i.e. a single `Notification`
 * fans out to however many of that user's devices are currently `active`. Mirrors
 * `core.email_outbox`'s battle-tested claim/lease shape exactly (`processing_token` fencing,
 * `provider_call_started_at` ambiguous-retry marker, `dispatch_generation` CAS counter,
 * `attempt_count`/`max_attempts`) rather than `core.realtime_event`'s batch-scan shape, because
 * push delivery is naturally one BullMQ job per device-targeted send, exactly like one BullMQ
 * job per outbound email — never a second, diverging state machine reinvented from scratch.
 *
 * States, matching the owner's own required list exactly: PENDING, PROCESSING, ACCEPTED (by the
 * provider — deliberately NOT named SENT, to keep permanently visible in the schema itself that
 * provider acceptance is not proof of on-device display — see this table's own `accepted_at`
 * column doc comment), RETRY, FAILED, CANCELLED.
 *
 * Deliberately NOT keyed by Redis/real-time delivery in any way — `push_dispatch.job.ts`'s sweep
 * reads straight from this table, same as `email-dispatch.job.ts` reads `core.email_outbox`; a
 * Redis outage can delay the FOREGROUND SSE experience but never erases or blocks this durable
 * row, and nothing here is ever created by, or waits on, Redis Pub/Sub.
 *
 * RLS: both tables use the same org-only shape as `core.notification`/`core.email_outbox`
 * (`organisation_id = core.current_org()`), FORCE'd, with per-user filtering enforced in the
 * service layer exactly like `NotificationService.list/markRead` already does — consistent with
 * every other user-owned-but-org-scoped table in this schema.
 *
 * EXPLICIT GRANTs below, not inherited — confirmed live, the hard way: `postgres-init/01-
 * roles.sql`'s `ALTER DEFAULT PRIVILEGES` only ever applied retroactively, ONCE, via
 * `CrewflowAppRestrictedRuntimeRole1786687000000`'s one-time replication of whatever `crewflow`
 * held AT THAT MIGRATION'S RUN TIME — it is not an ongoing rule. Any table created by a LATER
 * migration (this one) needs its own explicit `GRANT ... TO crewflow_app`, exactly like
 * `RealtimeEventOutbox1786698000000`'s own migration already does (and its own doc comment
 * explains precisely) — a first version of this migration's own doc comment claimed otherwise
 * and was wrong; corrected here after reproducing the resulting `permission denied` directly
 * against this local database, not guessed.
 */
export class PushDeliverySchema1786700000000 implements MigrationInterface {
  name = 'PushDeliverySchema1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.push_device (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id        uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id                uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        device_id              text NOT NULL,
        platform               text NOT NULL,
        push_token_encrypted   bytea NOT NULL,
        app_version            text,
        active                 boolean NOT NULL DEFAULT true,
        registered_at          timestamptz NOT NULL DEFAULT now(),
        last_seen_at           timestamptz NOT NULL DEFAULT now(),
        deactivated_at         timestamptz,
        deactivated_reason     text,
        created_at             timestamptz NOT NULL DEFAULT now(),
        updated_at             timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT push_device_platform_check CHECK (platform IN ('ios', 'android')),
        CONSTRAINT push_device_user_device_unique UNIQUE (user_id, device_id)
      );
    `);
    await queryRunner.query(`CREATE INDEX push_device_user_active_idx ON core.push_device (user_id) WHERE active;`);

    await queryRunner.query(`ALTER TABLE core.push_device ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.push_device FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY push_device_tenant ON core.push_device
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.push_device TO crewflow_app;`);

    await queryRunner.query(`
      CREATE TABLE core.push_delivery (
        id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id                 uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        notification_id                 uuid NOT NULL REFERENCES core.notification(id) ON DELETE CASCADE,
        push_device_id                  uuid NOT NULL REFERENCES core.push_device(id) ON DELETE CASCADE,
        status                          text NOT NULL DEFAULT 'PENDING',
        attempt_count                   integer NOT NULL DEFAULT 0,
        max_attempts                    integer NOT NULL DEFAULT 5,
        processing_token                uuid,
        provider_call_started_at        timestamptz,
        dispatch_generation             integer NOT NULL DEFAULT 0,
        provider                        text,
        provider_message_id             text,
        last_error_code                 text,
        last_error_message_sanitized    text,
        queued_at                       timestamptz,
        processing_at                   timestamptz,
        -- Provider ACCEPTED the message for delivery — never evidence the device displayed it.
        accepted_at                     timestamptz,
        failed_at                       timestamptz,
        cancelled_at                    timestamptz,
        created_at                      timestamptz NOT NULL DEFAULT now(),
        updated_at                      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT push_delivery_status_check CHECK (status IN (
          'PENDING', 'PROCESSING', 'ACCEPTED', 'RETRY', 'FAILED', 'CANCELLED'
        ))
      );
    `);
    await queryRunner.query(`CREATE INDEX push_delivery_dispatch_idx ON core.push_delivery (status, created_at) WHERE status IN ('PENDING', 'RETRY');`);
    await queryRunner.query(`CREATE INDEX push_delivery_notification_idx ON core.push_delivery (notification_id);`);
    await queryRunner.query(`CREATE INDEX push_delivery_device_idx ON core.push_delivery (push_device_id);`);

    await queryRunner.query(`ALTER TABLE core.push_delivery ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.push_delivery FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY push_delivery_tenant ON core.push_delivery
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON core.push_delivery TO crewflow_app;`);

    // audit_log-style immutability for delivery history: no UPDATE path should ever let a
    // caller rewrite history away from a terminal state once ACCEPTED/FAILED/CANCELLED — enforced
    // at the service layer (claim/complete are both fenced on processing_token + a WHERE-guarded
    // status transition), not by a DB trigger here, matching `core.realtime_event`'s own choice
    // not to add a trigger where fencing already makes the invariant hold in practice.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.push_delivery`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.push_device`);
  }
}
