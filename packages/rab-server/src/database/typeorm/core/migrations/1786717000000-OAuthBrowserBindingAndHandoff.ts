import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Google/Microsoft sign-in: browser binding + one-time login handoff (TWENTY_GOOGLE_AUTH_GAP_ANALYSIS.md §4).
 *
 * Extends the existing `core.oauth_transaction_state` row instead of adding a second token table — the row now
 * carries the whole sign-in attempt: `pending` (state/PKCE/nonce) → `authenticated` (callback validated, handoff
 * issued) → `completed` (handoff redeemed, session issued). One handoff type, not two.
 *
 * - `browser_binding_hash`: SHA-256 of an HttpOnly cookie set when the flow starts. The callback consumes the
 *   state only if the same browser presents that cookie (closes the login-CSRF / session-swap gap: a callback URL
 *   started in another browser can no longer be completed here).
 * - `handoff_token_hash` / `handoff_expires_at` / `handoff_consumed_at`: SHA-256 of a 32-byte secret delivered as
 *   an HttpOnly cookie on the callback redirect (never in the URL). Five minutes, consumed exactly once by a single
 *   conditional UPDATE; PostgreSQL is authoritative (atomic across API replicas, unaffected by Redis outages).
 * - `intent` / `invitation_token_hash`: "sign in" or "accept a member invitation with Google".
 * - `provider_*` / `resolved_user_id`: the validated identity awaiting redemption. Nulled when the handoff is
 *   redeemed; rows are deleted one hour after expiry/consumption by the existing cleanup function.
 *
 * Still no `organisation_id` / RLS — same justification as the original migration (created before any identity is
 * known; the provider identity it later carries is not tenant data until redemption re-derives the account).
 * crewflow_app keeps table-level SELECT/INSERT/UPDATE only (no DELETE; cleanup is the SECURITY DEFINER function).
 */
export class OAuthBrowserBindingAndHandoff1786717000000 implements MigrationInterface {
  name = 'OAuthBrowserBindingAndHandoff1786717000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.oauth_transaction_state
        ADD COLUMN browser_binding_hash   text,
        ADD COLUMN intent                 text NOT NULL DEFAULT 'sign_in',
        ADD COLUMN invitation_token_hash  text,
        ADD COLUMN authenticated_at       timestamptz,
        ADD COLUMN handoff_token_hash     text,
        ADD COLUMN handoff_expires_at     timestamptz,
        ADD COLUMN handoff_consumed_at    timestamptz,
        ADD COLUMN provider_subject       text,
        ADD COLUMN provider_email         text,
        ADD COLUMN provider_email_verified boolean NOT NULL DEFAULT false,
        ADD COLUMN provider_given_name    text,
        ADD COLUMN provider_family_name   text,
        ADD COLUMN resolved_user_id       uuid REFERENCES core."user"(id) ON DELETE CASCADE,
        ADD CONSTRAINT oauth_transaction_state_intent_check CHECK (intent IN ('sign_in', 'accept_invitation')),
        ADD CONSTRAINT oauth_transaction_state_invitation_check
          CHECK ((intent = 'accept_invitation') = (invitation_token_hash IS NOT NULL)),
        ADD CONSTRAINT oauth_transaction_state_hash_shape_check CHECK (
          (browser_binding_hash IS NULL OR browser_binding_hash ~ '^[0-9a-f]{64}$')
          AND (handoff_token_hash IS NULL OR handoff_token_hash ~ '^[0-9a-f]{64}$')
          AND (invitation_token_hash IS NULL OR invitation_token_hash ~ '^[0-9a-f]{64}$')
        ),
        ADD CONSTRAINT oauth_transaction_state_handoff_check CHECK (
          (handoff_token_hash IS NULL) = (handoff_expires_at IS NULL)
          AND (handoff_token_hash IS NULL OR authenticated_at IS NOT NULL)
          AND (handoff_consumed_at IS NULL OR handoff_token_hash IS NOT NULL)
        ),
        ADD CONSTRAINT oauth_transaction_state_provider_fields_check CHECK (
          coalesce(length(provider_subject), 0) <= 512 AND coalesce(length(provider_email), 0) <= 320
          AND coalesce(length(provider_given_name), 0) <= 200 AND coalesce(length(provider_family_name), 0) <= 200
        );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX oauth_transaction_state_handoff_uq ON core.oauth_transaction_state (handoff_token_hash)
        WHERE handoff_token_hash IS NOT NULL;
    `);
    // Table-level privileges (the original column lists were superseded by table-level grants in the P1C.2 role
    // migration); re-stated so the new columns are covered explicitly. No DELETE for the runtime role.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.oauth_transaction_state TO crewflow_app;`);
    await queryRunner.query(`REVOKE DELETE, TRUNCATE ON core.oauth_transaction_state FROM crewflow_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS core.oauth_transaction_state_handoff_uq;`);
    await queryRunner.query(`
      ALTER TABLE core.oauth_transaction_state
        DROP CONSTRAINT IF EXISTS oauth_transaction_state_provider_fields_check,
        DROP CONSTRAINT IF EXISTS oauth_transaction_state_handoff_check,
        DROP CONSTRAINT IF EXISTS oauth_transaction_state_hash_shape_check,
        DROP CONSTRAINT IF EXISTS oauth_transaction_state_invitation_check,
        DROP CONSTRAINT IF EXISTS oauth_transaction_state_intent_check,
        DROP COLUMN IF EXISTS resolved_user_id,
        DROP COLUMN IF EXISTS provider_family_name,
        DROP COLUMN IF EXISTS provider_given_name,
        DROP COLUMN IF EXISTS provider_email_verified,
        DROP COLUMN IF EXISTS provider_email,
        DROP COLUMN IF EXISTS provider_subject,
        DROP COLUMN IF EXISTS handoff_consumed_at,
        DROP COLUMN IF EXISTS handoff_expires_at,
        DROP COLUMN IF EXISTS handoff_token_hash,
        DROP COLUMN IF EXISTS authenticated_at,
        DROP COLUMN IF EXISTS invitation_token_hash,
        DROP COLUMN IF EXISTS intent,
        DROP COLUMN IF EXISTS browser_binding_hash;
    `);
  }
}
