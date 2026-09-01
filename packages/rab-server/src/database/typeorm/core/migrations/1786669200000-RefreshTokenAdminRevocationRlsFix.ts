import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 correction — a real, confirmed production bug: account
 * deactivation/suspension (`ActiveAccountGuard`'s whole reason to exist)
 * revokes the TARGET's refresh tokens via `RefreshTokenService
 * .revokeAllForUser(manager, targetUserId)` — `manager.update(RefreshToken,
 * {userId: targetUserId}, {revokedAt: now()})`, run by the DEACTIVATING
 * MANAGER's own session, not the target's. `refresh_token_tenant`'s single
 * `user_id = current_uid()` predicate (applied to every command) requires
 * the row's `user_id` to equal the ACTOR's own id — so this UPDATE matches
 * zero rows whenever the actor isn't the target, silently no-opping the
 * revocation. Confirmed live under `rab_app`:
 * `account-deactivation-abuse-cases.integration.spec.ts`'s own "denies
 * their existing access token, their refresh token" tests — the still-live
 * refresh token successfully mints a new access token after deactivation,
 * which should be structurally impossible.
 *
 * Fix: split into command-specific policies, the same pattern already
 * applied to `user`/`user_role`/`manager_profile` earlier this migration
 * set. SELECT stays self-scoped (`user_id = current_uid()`) — nobody
 * legitimately reads another user's token hash via a raw query, and
 * `revokeByToken`'s own `findOne` is always keyed off the PRESENTED token's
 * hash, self-driven by construction. INSERT/UPDATE/DELETE become
 * org-scoped (`organisation_id = current_org()`) — real write
 * authorization for "who can revoke whose session" is already enforced at
 * the service layer (`ActiveAccountGuard`, the deactivate/suspend
 * endpoints' own permission gates), matching every other split policy in
 * this migration set.
 */
export class RefreshTokenAdminRevocationRlsFix1786669200000 implements MigrationInterface {
  name = 'RefreshTokenAdminRevocationRlsFix1786669200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY refresh_token_tenant ON core.refresh_token;`);
    await queryRunner.query(`
      CREATE POLICY refresh_token_select ON core.refresh_token
        FOR SELECT USING (user_id = core.current_uid());
    `);
    await queryRunner.query(`
      CREATE POLICY refresh_token_write ON core.refresh_token
        FOR INSERT WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      CREATE POLICY refresh_token_update ON core.refresh_token
        FOR UPDATE USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      CREATE POLICY refresh_token_delete ON core.refresh_token
        FOR DELETE USING (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY refresh_token_delete ON core.refresh_token;`);
    await queryRunner.query(`DROP POLICY refresh_token_update ON core.refresh_token;`);
    await queryRunner.query(`DROP POLICY refresh_token_write ON core.refresh_token;`);
    await queryRunner.query(`DROP POLICY refresh_token_select ON core.refresh_token;`);
    await queryRunner.query(`
      CREATE POLICY refresh_token_tenant ON core.refresh_token
        USING (user_id = core.current_uid())
        WITH CHECK (user_id = core.current_uid());
    `);
  }
}
