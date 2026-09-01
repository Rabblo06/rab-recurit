import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 correction — a real, confirmed production bug, not a test
 * fixture issue. `core.resolve_workspace_for_user(p_user_id)`
 * (`WorkspaceSessionContext1786667700000`) is SECURITY DEFINER precisely
 * because it must run BEFORE any tenant context exists (`JwtAuthGuard` calls
 * it to determine `AuthContext.workspaceId` in the first place — the same
 * chicken-and-egg reason `organisation`/`user`/`login_history`/
 * `refresh_token`/`password_reset_token`/`manager_workspace` are already
 * documented pre-auth exemptions).
 *
 * SECURITY DEFINER changes which ROLE's privileges a function runs with —
 * it does NOT disable RLS. With no `rab.organisation_id`/`rab.workspace_id`
 * bound (there is nothing to bind yet), every FORCE'd table's policy
 * predicate evaluates against NULL and denies, function owner or not. The
 * function's `manager_workspace` branch only ever worked because
 * `manager_workspace` already has `NO FORCE ROW LEVEL SECURITY` — the table
 * owner (`rab_owner`, this function's owner) is fully exempt from RLS
 * there, regardless of session context. `staff_profile` and
 * `manager_profile` do not have that exemption, so the function's other two
 * `UNION ALL` branches (staff-of, manager-of) have been silently returning
 * zero rows for every Staff and Manager since this migration set began —
 * confirmed by direct reproduction: a real `staff_profile` row with a
 * populated `workspace_id` column, queried by `resolve_workspace_for_user`
 * as `rab_owner` with no context bound, returns nothing; the identical
 * `SELECT` run manually as `rab_owner` also returns nothing until FORCE is
 * temporarily dropped. Every Staff member's `ctx.workspaceId` has
 * consequently been NULL on every request, breaking their own
 * `staff_profile`/`shift`/`job_offer`/`attendance` reads under the
 * combined org+workspace RLS predicate those tables now carry (`GET
 * /offers/mine`, `POST /offers/:id/accept`, clock-in/out, etc. all 404 or
 * 500 for a real Staff member using their own account) — the same class of
 * bug, and the same fix, already applied to `manager_workspace` for
 * `workspace_subdomain_taken()`.
 *
 * `rab_app` (the runtime connection every ordinary request query uses) is
 * NEVER exempted by `NO FORCE` — only the table OWNER is — so this changes
 * nothing about ordinary RLS enforcement for real application queries; it
 * only lets this one `rab_owner`-owned SECURITY DEFINER function read
 * across the pre-auth boundary, exactly like the 6 tables already granted
 * this exemption.
 */
export class ResolveWorkspaceForUserPreAuthExemption1786668400000 implements MigrationInterface {
  name = 'ResolveWorkspaceForUserPreAuthExemption1786668400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.staff_profile NO FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.manager_profile NO FORCE ROW LEVEL SECURITY;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.manager_profile FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.staff_profile FORCE ROW LEVEL SECURITY;`);
  }
}
