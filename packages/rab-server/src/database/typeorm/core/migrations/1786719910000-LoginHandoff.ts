import { MigrationInterface, QueryRunner } from 'typeorm';

import { LOGIN_HANDOFF_DOWN_SQL, LOGIN_HANDOFF_UP_SQL } from '../login-handoff-sql';

/**
 * Waves 4+5 lane DB5 — cross-host login handoff for the MFA/auth lane (C8: default host → the user's own workspace host).
 * Dev/test only: deliberately NOT in production-migration-approval.ts (N1). Contract: docs/evidence/w45-db5/CONTRACT.md §2.
 * SQL, design and the SECURITY TRADE-OFF (ENABLE but NOT FORCE: pre-auth consume) live in ../login-handoff-sql.ts.
 *
 * `core.login_handoff`: single-use (atomic conditional UPDATE), ≤ 60 s (table CHECK), audience-bound to the target
 * workspace's host label, SHA-256-hashed token, consumed_at; no table privilege for crewflow_app or crewflow — only
 * `core.login_handoff_create` (post-auth), `core.login_handoff_consume` (pre-auth) and `core.login_handoff_cleanup`.
 * Must run as the bootstrap identity (rab_secure_owner-owned objects). No existing data is touched.
 */
export class LoginHandoff1786719910000 implements MigrationInterface {
  name = 'LoginHandoff1786719910000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertBootstrap(queryRunner);
    await queryRunner.query(LOGIN_HANDOFF_UP_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertBootstrap(queryRunner);
    await queryRunner.query(LOGIN_HANDOFF_DOWN_SQL);
  }

  private async assertBootstrap(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF NOT pg_has_role(current_user, 'crewflow', 'USAGE') OR NOT pg_has_role(current_user, 'rab_secure_owner', 'USAGE') THEN
          RAISE EXCEPTION 'LoginHandoff1786719910000 must run as the bootstrap identity (rab_secure_owner-owned objects); refusing as %', current_user
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);
  }
}
