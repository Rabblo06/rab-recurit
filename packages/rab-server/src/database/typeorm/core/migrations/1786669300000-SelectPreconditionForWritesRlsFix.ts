import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 correction — a fundamental PostgreSQL RLS semantic this
 * whole migration set got wrong in three places, found via exhaustive live
 * debugging of `refresh_token_update`'s "affected: 0" mystery (a broader
 * `organisation_id = current_org()` UPDATE policy silently matched zero
 * rows even with `organisation_id` provably correct) and confirmed with a
 * minimal, isolated repro table: **a row must satisfy the table's SELECT
 * policy to be visible to UPDATE/DELETE at all, regardless of how
 * permissive the UPDATE/DELETE-specific policy is.** Postgres evaluates
 * SELECT visibility as a precondition, then the command-specific policy on
 * top — a narrow, self-scoped SELECT (`user_id = current_uid()`) silently
 * defeats a broader UPDATE/DELETE policy for every row the caller isn't
 * also allowed to SELECT. This invalidates the "narrow SELECT + broad
 * write, service-layer-enforced" split used for three tables this session:
 *
 * - `refresh_token`: confirmed ACTIVELY BROKEN — `RefreshTokenService
 *   .revokeAllForUser`, called by account deactivation/suspension, updates
 *   ZERO rows whenever the revoking actor isn't the token's own owner
 *   (i.e. every real admin-driven revocation), because
 *   `refresh_token_select` was self-scoped while `refresh_token_update`
 *   was org-scoped. `account-deactivation-abuse-cases.integration.spec.ts`
 *   caught this live under `rab_app`.
 * - `user_role` / `user_permission_override`: the identical shape
 *   (self-scoped SELECT, unconditional UPDATE/DELETE) — not currently
 *   exercised by any production code path (no service updates or deletes
 *   either table today), but the same landmine for the first one that
 *   does. Fixed now, preemptively, while this lesson is fresh.
 *
 * Fix, uniform across all three: SELECT becomes org-scoped
 * (`organisation_id = current_org()`), matching every other table this
 * session already resolved to (`user`, `manager_profile`) once this same
 * lesson applied to them. This doesn't reopen any real confidentiality
 * gap — none of these three tables' rows carry data whose sensitivity
 * exceeds "which organisation this belongs to" (a token hash, a role
 * assignment, a permission override — never raw credentials), and the
 * actual boundary the earlier self-scoped design was reaching for
 * ("Manager A shouldn't casually browse Manager B's role list") was never
 * enforced by RLS alone anywhere in this codebase — it's an application-
 * layer concern, per this migration set's own repeated "global identity ≠
 * globally readable" principle.
 */
export class SelectPreconditionForWritesRlsFix1786669300000 implements MigrationInterface {
  name = 'SelectPreconditionForWritesRlsFix1786669300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY refresh_token_select ON core.refresh_token
        USING (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      ALTER POLICY user_role_select ON core.user_role
        USING (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      ALTER POLICY user_permission_override_select ON core.user_permission_override
        USING (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY user_permission_override_select ON core.user_permission_override
        USING (user_id = core.current_uid());
    `);
    await queryRunner.query(`
      ALTER POLICY user_role_select ON core.user_role
        USING (user_id = core.current_uid());
    `);
    await queryRunner.query(`
      ALTER POLICY refresh_token_select ON core.refresh_token
        USING (user_id = core.current_uid());
    `);
  }
}
