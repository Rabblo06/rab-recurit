import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.email_outbox` — the transactional-outbox row that makes email
 * delivery durable and decouples it from the HTTP request that triggers it.
 *
 * Written in the SAME transaction as the business state it accompanies
 * (e.g. `ManagerService.create()`'s `User`/`ManagerProfile`/`AccountInvite`
 * inserts) — if that transaction commits, this row commits with it, so an
 * API-process crash between commit and the BullMQ publish can never lose the
 * intent to send: the dispatcher (`queue-worker`) sweeps for PENDING rows on
 * a short interval and republishes, independent of whether the request-time
 * "fast path" publish attempt succeeded.
 *
 * `account_invite_id`/`password_reset_token_id` are how the worker
 * re-validates AUTHORITATIVE state immediately before sending — never trusts
 * that "this row exists" alone means "still safe to send" (see A9/A10 in the
 * design: a cancelled invitation, a superseded re-invite, or a used/expired
 * reset token must never be mailed out just because a queued row for it
 * still exists). Both nullable — not every job type has a token to
 * re-validate (WELCOME/PASSWORD_UPDATED/ACCOUNT_SUSPENDED don't).
 *
 * `rendered_subject`/`rendered_html`/`rendered_text` are captured ONCE, at
 * the same moment the referenced token is committed — never re-rendered
 * later. This is correct, not just convenient: the content embeds a
 * specific token (e.g. the activation URL), and re-rendering after the fact
 * could silently point at a different, superseded token.
 *
 * SECURITY: never persist SMTP passwords, API keys, or raw tokens — this
 * table is a corollary of `account_invite`/`password_reset_token`, which
 * already correctly store only a token HASH; nothing here duplicates the
 * raw token, only the fully-rendered email body (which necessarily contains
 * it — see FORCE RLS below, no different from any other tenant-scoped table
 * carrying user-facing content).
 */
export class EmailOutboxSchema1786670200000 implements MigrationInterface {
  name = 'EmailOutboxSchema1786670200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.email_outbox (
        id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id                 uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        job_type                        text NOT NULL,
        status                          text NOT NULL DEFAULT 'PENDING',
        recipient_email                 citext NOT NULL,
        target_user_id                  uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        account_invite_id               uuid REFERENCES core.account_invite(id) ON DELETE SET NULL,
        password_reset_token_id         uuid REFERENCES core.password_reset_token(id) ON DELETE SET NULL,
        rendered_subject                text NOT NULL,
        rendered_html                   text,
        rendered_text                   text,
        infrastructure_attempt_count    integer NOT NULL DEFAULT 0,
        max_infrastructure_attempts     integer NOT NULL DEFAULT 5,
        provider                        text,
        provider_message_id             text,
        last_error_code                 text,
        last_error_message_sanitized    text,
        queued_at                       timestamptz,
        processing_at                   timestamptz,
        sent_at                         timestamptz,
        failed_at                       timestamptz,
        cancelled_at                    timestamptz,
        created_by                      uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        created_at                      timestamptz NOT NULL DEFAULT now(),
        updated_at                      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT email_outbox_job_type_check CHECK (job_type IN (
          'ACCOUNT_INVITATION', 'PASSWORD_RESET', 'PASSWORD_UPDATED', 'WELCOME', 'ACCOUNT_SUSPENDED'
        )),
        CONSTRAINT email_outbox_status_check CHECK (status IN (
          'PENDING', 'QUEUED', 'PROCESSING', 'RETRY', 'SENT', 'FAILED', 'CANCELLED'
        ))
      );
    `);

    // The dispatcher's own claim query — "every row still needing a publish
    // attempt" — and the worker's "is this account's newest attempt still
    // in flight" checks both hinge on this.
    await queryRunner.query(`CREATE INDEX email_outbox_dispatch_idx ON core.email_outbox (status, created_at) WHERE status IN ('PENDING', 'RETRY');`);
    await queryRunner.query(`CREATE INDEX email_outbox_account_invite_idx ON core.email_outbox (account_invite_id) WHERE account_invite_id IS NOT NULL;`);
    await queryRunner.query(`CREATE INDEX email_outbox_password_reset_token_idx ON core.email_outbox (password_reset_token_id) WHERE password_reset_token_id IS NOT NULL;`);
    await queryRunner.query(`CREATE INDEX email_outbox_target_user_idx ON core.email_outbox (target_user_id) WHERE target_user_id IS NOT NULL;`);

    await queryRunner.query(`ALTER TABLE core.email_outbox ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.email_outbox FORCE ROW LEVEL SECURITY;`);
    // Standard tenant policy, same shape as every other operational table —
    // no pre-auth exemption needed (unlike account_invite's own narrow
    // ENABLE-only carve-out for the activation-link lookup): nothing reads
    // this table before tenant context exists. The worker binds a real,
    // per-row organisation_id context before touching a row (see
    // email-send.processor.ts's own doc comment) — it is never granted a
    // superuser/BYPASSRLS connection for this table.
    await queryRunner.query(`
      CREATE POLICY email_outbox_tenant ON core.email_outbox
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.email_outbox`);
  }
}
