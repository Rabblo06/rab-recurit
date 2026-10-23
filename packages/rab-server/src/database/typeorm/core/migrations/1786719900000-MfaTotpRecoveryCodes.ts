import { MigrationInterface, QueryRunner } from 'typeorm';

import { MFA_SCHEMA_DOWN_SQL, MFA_SCHEMA_UP_SQL } from '../mfa-schema-sql';

/**
 * Waves 4+5 lane DB5 — database half of TOTP MFA for the MFA/auth lane (B1). Dev/test only: deliberately NOT in
 * production-migration-approval.ts (N1). Contract: docs/evidence/w45-db5/CONTRACT.md §1. SQL + design: ../mfa-schema-sql.ts.
 *
 * - `core."user"`: `totp_last_used_step` (atomic replay protection) and `mfa_enabled_at`; the existing (never written)
 *   `totp_secret_encrypted` / `totp_enabled` are reused. A guard trigger lets only the narrow `core.mfa_*` DEFINER functions
 *   (owner rab_secure_owner) or a superuser write the four MFA columns, and keeps the step forward-only for everyone.
 * - `core.user_mfa_recovery_code`: hashed one-way, per user, `used_at`; ENABLE + FORCE RLS; no privilege for the runtime role.
 * - No NOT-FORCE exception: every function requires the tenant context the login challenge already has (server-derived).
 *
 * Pre-checks (fail closed, never "fix" data):
 *  - up() refuses if any user row already has `totp_enabled = true`: such a row has no `mfa_enabled_at` and no replay
 *    counter, so the new state CHECK cannot hold and adopting it would silently start with no replay history. Before this
 *    wave nothing ever wrote the column, so the only way to get here is a down() followed by MFA data written meanwhile.
 *  - down() refuses while any user has an enabled or staged TOTP factor or a recovery code: dropping the replay counter
 *    and the codes under a live factor would reopen replay and destroy the user's only fallback. Disable MFA first.
 * Must run as the bootstrap identity (rab_secure_owner-owned objects).
 */
export class MfaTotpRecoveryCodes1786719900000 implements MigrationInterface {
  name = 'MfaTotpRecoveryCodes1786719900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertBootstrap(queryRunner);
    const [{ n }] = await queryRunner.query(`SELECT count(*)::int AS n FROM core."user" WHERE totp_enabled`);
    if (Number(n) !== 0) {
      throw new Error(`${this.name}: ${n} user row(s) already have totp_enabled = true with no replay history; refusing (no data is changed)`);
    }
    await queryRunner.query(MFA_SCHEMA_UP_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertBootstrap(queryRunner);
    const [{ users, codes }] = await queryRunner.query(
      `SELECT (SELECT count(*)::int FROM core."user" WHERE totp_enabled OR totp_secret_encrypted IS NOT NULL) AS users,
              (SELECT count(*)::int FROM core.user_mfa_recovery_code) AS codes`,
    );
    if (Number(users) !== 0 || Number(codes) !== 0) {
      throw new Error(`${this.name}: ${users} user(s) hold a TOTP factor and ${codes} recovery code(s) exist; refusing to drop MFA state (disable MFA first)`);
    }
    await queryRunner.query(MFA_SCHEMA_DOWN_SQL);
  }

  private async assertBootstrap(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF NOT pg_has_role(current_user, 'crewflow', 'USAGE') OR NOT pg_has_role(current_user, 'rab_secure_owner', 'USAGE') THEN
          RAISE EXCEPTION 'MfaTotpRecoveryCodes1786719900000 must run as the bootstrap identity (rab_secure_owner-owned objects); refusing as %', current_user
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);
  }
}
