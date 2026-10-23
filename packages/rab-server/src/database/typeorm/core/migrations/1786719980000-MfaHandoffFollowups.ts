import { MigrationInterface, QueryRunner } from 'typeorm';

import { MFA_HANDOFF_FOLLOWUPS_DOWN_SQL, MFA_HANDOFF_FOLLOWUPS_UP_SQL } from '../mfa-handoff-followups-sql';

/**
 * Waves 4+5 lane DB5 — additive follow-ups requested by the MFA lane (WAVE4_LANE_MFA_REPORT.md §10). Dev/test only:
 * deliberately NOT in production-migration-approval.ts (N1). Contract v3: docs/evidence/w45-db5/CONTRACT.md §1.4, §2.
 * SQL and design: ../mfa-handoff-followups-sql.ts.
 *
 *  - `core.login_handoff_peek(text, text)`: pre-auth, STABLE (cannot write), display fields only, never consumes/extends.
 *  - `GRANT INSERT (mfa_verified_at) ON core.user_session TO crewflow_app` (no UPDATE) + a BEFORE INSERT guard (not in the
 *    future; the user must hold an enabled TOTP factor).
 * Nothing existing is changed or dropped. Must run as the bootstrap identity (rab_secure_owner-owned objects).
 */
export class MfaHandoffFollowups1786719980000 implements MigrationInterface {
  name = 'MfaHandoffFollowups1786719980000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertBootstrap(queryRunner);
    await queryRunner.query(MFA_HANDOFF_FOLLOWUPS_UP_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertBootstrap(queryRunner);
    await queryRunner.query(MFA_HANDOFF_FOLLOWUPS_DOWN_SQL);
  }

  private async assertBootstrap(queryRunner: QueryRunner): Promise<void> {
    const [{ ok }] = await queryRunner.query(
      `SELECT pg_has_role(current_user, 'crewflow', 'USAGE') AND pg_has_role(current_user, 'rab_secure_owner', 'USAGE') AS ok`,
    );
    if (!ok) throw new Error(`${this.name} must run as the bootstrap identity (rab_secure_owner-owned objects)`);
  }
}
