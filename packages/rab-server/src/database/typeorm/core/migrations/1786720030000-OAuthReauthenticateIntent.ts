import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Account security step 1 (P6): SSO re-authentication as a step-up for an ALREADY signed-in user.
 *
 * Extends the existing `core.oauth_transaction_state` row (the one table that already carries state / PKCE / nonce /
 * browser binding for a provider round trip) with a third intent, `reauthenticate`, instead of a new table:
 *
 *  - `reauth_user_id`         the signed-in user who started the re-authentication (FK, ON DELETE CASCADE — same as
 *                             `resolved_user_id`). The callback requires the provider identity to be an identity ALREADY
 *                             linked to exactly this user; it never signs anyone in and never links anything.
 *  - `reauth_session_hash`    SHA-256 (hex) of the session id the re-authentication is for. The step-up grant is recorded
 *                             for that session only (the grant key is derived from this hash), and the callback must come
 *                             from a browser presenting that same session. The raw session id is never stored.
 *  - `reauth_organisation_id` the user's organisation at start, so a refused callback can be audited in it. Not a
 *                             foreign key on purpose (short-lived row, deleted ≤ 1 h after expiry/consumption by the
 *                             existing cleanup function); it is never used for authorisation.
 *
 * CHECKs: the three columns are set exactly when `intent = 'reauthenticate'`; the hash has the canonical shape; a
 * re-authentication row can never carry a login handoff (`handoff_token_hash IS NULL`) or an invitation, so this intent
 * can never be turned into a session by the sign-in path.
 *
 * Still no `organisation_id` / RLS on this table — unchanged justification (OAuthTransactionState1786680300000 /
 * OAuthBrowserBindingAndHandoff1786717000000): the row is created and consumed around a provider round trip and holds
 * no tenant data; `crewflow_app` keeps its existing table-level SELECT / INSERT / UPDATE (which covers the new columns)
 * and no DELETE. No function, grant or owner changes, so the security-posture golden is unchanged.
 */
export class OAuthReauthenticateIntent1786720030000 implements MigrationInterface {
  name = 'OAuthReauthenticateIntent1786720030000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.oauth_transaction_state
        ADD COLUMN reauth_user_id         uuid REFERENCES core."user"(id) ON DELETE CASCADE,
        ADD COLUMN reauth_session_hash    text,
        ADD COLUMN reauth_organisation_id uuid,
        DROP CONSTRAINT oauth_transaction_state_intent_check,
        ADD CONSTRAINT oauth_transaction_state_intent_check CHECK (intent IN ('sign_in', 'accept_invitation', 'reauthenticate')),
        ADD CONSTRAINT oauth_transaction_state_reauth_check CHECK (
          (intent = 'reauthenticate') = (reauth_user_id IS NOT NULL)
          AND (reauth_user_id IS NULL) = (reauth_session_hash IS NULL)
          AND (reauth_user_id IS NULL) = (reauth_organisation_id IS NULL)
          AND (reauth_session_hash IS NULL OR reauth_session_hash ~ '^[0-9a-f]{64}$')
          AND (intent <> 'reauthenticate' OR (handoff_token_hash IS NULL AND invitation_token_hash IS NULL))
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM core.oauth_transaction_state WHERE intent = 'reauthenticate';`);
    await queryRunner.query(`
      ALTER TABLE core.oauth_transaction_state
        DROP CONSTRAINT IF EXISTS oauth_transaction_state_reauth_check,
        DROP CONSTRAINT oauth_transaction_state_intent_check,
        ADD CONSTRAINT oauth_transaction_state_intent_check CHECK (intent IN ('sign_in', 'accept_invitation')),
        DROP COLUMN IF EXISTS reauth_organisation_id,
        DROP COLUMN IF EXISTS reauth_session_hash,
        DROP COLUMN IF EXISTS reauth_user_id;
    `);
  }
}
