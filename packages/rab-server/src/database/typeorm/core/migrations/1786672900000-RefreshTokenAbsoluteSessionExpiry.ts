import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fixes an unbounded session: `RefreshTokenService.issue()` recomputed
 * `expires_at = now() + 30d` on every rotation, never consulting the
 * original login time, and no absolute ceiling existed anywhere in the
 * codebase. A session touched at least once every 30 days lived forever
 * by construction. Found via a production auth audit (2026-09-25); see
 * docs/HANDOFF.md for the full trace.
 *
 * `family_expires_at` is the fix: set ONCE, at the family's creation
 * (first login), to `now() + 24h`, and copied — never recomputed — on
 * every rotation thereafter (see RefreshTokenService.issue/rotate). Every
 * issued row's own `expires_at` is clamped to `min(now() + 30d,
 * family_expires_at)`, so the already-existing `expires_at < now()` check
 * in `rotate()` becomes the enforcement mechanism with no new runtime
 * check needed.
 *
 * Backfill for pre-existing rows uses `created_at + 24h`, not `now() +
 * 24h` — a row already older than 24h becomes immediately past its
 * (backfilled) family deadline and is rejected on its next use, forcing
 * re-login. This is the correct, fail-closed outcome for a session that
 * was already relying on the unbounded bug to stay alive; it is not a
 * regression for any session actually within its first 24 hours.
 */
export class RefreshTokenAbsoluteSessionExpiry1786672900000 implements MigrationInterface {
  name = 'RefreshTokenAbsoluteSessionExpiry1786672900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.refresh_token
        ADD COLUMN family_expires_at timestamptz;
    `);
    await queryRunner.query(`
      UPDATE core.refresh_token
         SET family_expires_at = created_at + interval '24 hours'
       WHERE family_expires_at IS NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE core.refresh_token
        ALTER COLUMN family_expires_at SET NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.refresh_token DROP COLUMN family_expires_at;`);
  }
}
