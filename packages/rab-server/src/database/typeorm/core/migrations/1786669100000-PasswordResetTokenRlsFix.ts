import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 correction — `IdentityWorkspaceRls1786667800000` set
 * `password_reset_token_tenant` to `USING (false) WITH CHECK (false)`
 * ("zero ordinary runtime access"), on the assumption every access would
 * go through a SECURITY DEFINER pre-auth function. That's only true for
 * the INITIAL lookup: `AuthService.resetPassword()` calls
 * `core.auth_find_password_reset_token_org` (SECURITY DEFINER) purely to
 * learn which organisation a presented token's hash belongs to, then binds
 * REAL tenant context (`runInTenantContext`) and does everything else —
 * `PasswordResetTokenService.issue()`'s INSERT, `consume()`'s `findOne` and
 * mark-used UPDATE, the invalidate-prior-tokens UPDATE — through the
 * normal, already-tenant-bound path every other table in this schema uses.
 * `USING/WITH CHECK (false)` blocks ALL of that unconditionally, org
 * context bound or not: confirmed live under `rab_app` (invisible under
 * `rab_owner`, which bypasses this table's RLS entirely via its own
 * pre-auth `NO FORCE` exemption) — issuing a reset token throws outright
 * (`WITH CHECK false` rejects the INSERT), and consuming one always
 * resolves to "invalid or expired" (`USING false` makes `findOne` return
 * nothing) — password reset has not functioned under the real runtime role
 * since that migration.
 *
 * Fix: the standard org-scoped predicate, matching every other tenant
 * table's baseline (before any workspace-level narrowing) — the org
 * boundary is already established via the SECURITY DEFINER lookup before
 * this policy is ever evaluated, so it's exactly what's needed and no
 * looser than that.
 */
export class PasswordResetTokenRlsFix1786669100000 implements MigrationInterface {
  name = 'PasswordResetTokenRlsFix1786669100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY password_reset_token_tenant ON core.password_reset_token
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY password_reset_token_tenant ON core.password_reset_token
        USING (false)
        WITH CHECK (false);
    `);
  }
}
