import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C1 security review F2 (Low): a provider push token registered by a DIFFERENT account of the same organisation under a
 * new device id was not superseded, so the earlier account's row kept sending its (generic, id-only) notifications to the
 * phone that now belongs to someone else. Tokens are stored AES-GCM-encrypted with a random IV, so equal tokens cannot be
 * compared in SQL.
 *
 * WHAT CHANGES (additive, core.push_device only):
 *  1. `token_fingerprint bytea NULL`: the keyed HMAC-SHA256 of the provider token under the active encryption kid's
 *     fingerprint key (SecretEncryptionService, keyring.util purpose `push-token-fingerprint`; secret rotation moves it to
 *     the new kid with the ciphertext). NULL for rows registered before this migration until their device registers
 *     again (the mobile apps re-register on start and on every token refresh).
 *  2. CHECK `push_device_token_fingerprint_length`: NULL or exactly 32 bytes.
 *  3. Partial index `push_device_org_token_fingerprint_active_idx (organisation_id, token_fingerprint) WHERE active AND
 *     token_fingerprint IS NOT NULL`: the registration's supersede lookup. Not UNIQUE on purpose: two concurrent
 *     registrations of one token must not fail a sign-in; the later one supersedes the earlier.
 *
 * WHAT DOES NOT CHANGE: RLS (ENABLE + FORCE, `push_device_tenant` USING/WITH CHECK on organisation_id) and the grants are
 * untouched; the column inherits the table's policy and grants. No function, no trigger, no backfill (a backfill would need
 * the server secret inside the database). The table is small (push is off in production). The ACCESS EXCLUSIVE statements
 * run with a bounded lock wait (lock_timeout 5s, transaction-local, the previous value restored after), like
 * VenueManagerStaffCompositeParentKeys1786676100000.
 *
 * New SQL: owner review first (draft PR). Not production-approved by itself.
 */
export class PushDeviceTokenFingerprint1786722800000 implements MigrationInterface {
  name = 'PushDeviceTokenFingerprint1786722800000';

  async up(runner: QueryRunner): Promise<void> {
    await this.withLockTimeout(runner, () => this.apply(runner));
  }

  private async apply(runner: QueryRunner): Promise<void> {
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
    await this.withLockTimeout(runner, async () => {
      await runner.query(`DROP INDEX IF EXISTS core.push_device_org_token_fingerprint_active_idx;`);
      await runner.query(`ALTER TABLE core.push_device DROP CONSTRAINT IF EXISTS push_device_token_fingerprint_length;`);
      await runner.query(`ALTER TABLE core.push_device DROP COLUMN IF EXISTS token_fingerprint;`);
    });
  }

  /** A bounded lock wait for the ACCESS EXCLUSIVE statements, transaction-local; the previous value is restored after. */
  private async withLockTimeout(runner: QueryRunner, fn: () => Promise<void>): Promise<void> {
    const [{ lock_timeout: previous }] = (await runner.query(`SHOW lock_timeout`)) as Array<{ lock_timeout: string }>;
    await runner.query(`SET LOCAL lock_timeout = '5s'`);
    await fn();
    await runner.query(`SELECT pg_catalog.set_config('lock_timeout', $1, true)`, [previous]);
  }
}
