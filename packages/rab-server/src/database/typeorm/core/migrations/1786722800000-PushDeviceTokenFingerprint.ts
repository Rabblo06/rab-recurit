import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C1 security review F2 (Low): a provider push token registered by a DIFFERENT account of the same organisation under a
 * new device id was not superseded, so the earlier account's row kept sending its (generic, id-only) notifications to the
 * phone that now belongs to someone else. Tokens are stored AES-GCM-encrypted with a random IV, so equal tokens cannot be
 * compared in SQL.
 *
 * WHAT CHANGES (additive, core.push_device only):
 *  1. `token_fingerprint bytea NULL`: the keyed HMAC-SHA256 of the provider token (push-token-fingerprint.ts; key derived
 *     from APP_SECRET with its own HKDF label). NULL for rows registered before this migration until their device
 *     registers again (the mobile apps re-register on start and on every token refresh).
 *  2. CHECK `push_device_token_fingerprint_length`: NULL or exactly 32 bytes.
 *  3. Partial index `push_device_org_token_fingerprint_active_idx (organisation_id, token_fingerprint) WHERE active AND
 *     token_fingerprint IS NOT NULL`: the registration's supersede lookup. Not UNIQUE on purpose: two concurrent
 *     registrations of one token must not fail a sign-in; the later one supersedes the earlier.
 *
 * WHAT DOES NOT CHANGE: RLS (ENABLE + FORCE, `push_device_tenant` USING/WITH CHECK on organisation_id) and the grants are
 * untouched; the column inherits the table's policy and grants. No function, no trigger, no backfill (a backfill would need
 * the server secret inside the database). The table is small (push is off in production).
 *
 * New SQL: owner review first (draft PR). Not production-approved by itself.
 */
export class PushDeviceTokenFingerprint1786722800000 implements MigrationInterface {
  name = 'PushDeviceTokenFingerprint1786722800000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE core.push_device ADD COLUMN token_fingerprint bytea;`);
    await runner.query(`
      ALTER TABLE core.push_device
        ADD CONSTRAINT push_device_token_fingerprint_length CHECK (token_fingerprint IS NULL OR octet_length(token_fingerprint) = 32);
    `);
    await runner.query(`
      CREATE INDEX push_device_org_token_fingerprint_active_idx
        ON core.push_device (organisation_id, token_fingerprint)
        WHERE active AND token_fingerprint IS NOT NULL;
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP INDEX IF EXISTS core.push_device_org_token_fingerprint_active_idx;`);
    await runner.query(`ALTER TABLE core.push_device DROP CONSTRAINT IF EXISTS push_device_token_fingerprint_length;`);
    await runner.query(`ALTER TABLE core.push_device DROP COLUMN IF EXISTS token_fingerprint;`);
  }
}
