import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 correction — a real, confirmed production bug, only
 * surfaced once integration tests actually ran as `rab_app` (the real
 * runtime role) instead of `rab_owner` (which fully bypasses RLS on `user`
 * — `user` has no FORCE, so the table owner has always been exempt
 * regardless of policy content, silently masking this all session).
 *
 * `IdentityWorkspaceRls1786667800000`'s `user_select` policy (self OR
 * staff-of-my-workspace OR manager-of-my-workspace) shares the exact same
 * defect already found and fixed twice this migration set
 * (`ManagerProfileRlsRevertToOrgScoped`, and the RETURNING semantics
 * documented there in full): Postgres checks an `INSERT ... RETURNING` row
 * against the table's SELECT policy, not just its `WITH CHECK`.
 * `user_write`'s `WITH CHECK` is already `true` (unconditional — every
 * actor-creates-subject flow, `StaffService.create`/`ManagerService.create`,
 * needs to insert a User row for someone who isn't the actor). But the new
 * row's own `staff_profile`/`manager_profile` sibling rows don't exist yet
 * at the moment `User` is inserted (they're separate, later statements in
 * the same transaction) — so `user_select`'s three-way OR never matches,
 * and TypeORM's `RETURNING "id", ...` throws "new row violates row-level
 * security policy for table user" on literally every Staff/Manager
 * creation under `rab_app`. Confirmed live: 100% reproducible under
 * `rab_app`, invisible under `rab_owner` for the reason above.
 *
 * Also confirmed independently necessary: `ManagerService.list()` (the
 * admin/CEO-only manager roster, `relations: { user: true }`) needs to see
 * every Manager's `User` row in the org regardless of workspace — the
 * self/staff-of/manager-of predicate would ALSO have blocked that for any
 * admin without their own matching workspace membership.
 *
 * Fix: revert `user_select` to plain `organisation_id = current_org()` —
 * the same resolution already applied to `manager_profile`, and consistent
 * with `user_write`/`user_update`/`user_delete` already being fully
 * unrestricted at the RLS layer (`USING/WITH CHECK true`) for this exact
 * table, per the Revision 3 correction's own stated principle: "global
 * identity ≠ globally readable... application-layer, not RLS." The real
 * confidentiality boundary for identity data (who can see whose email/name)
 * is enforced by the calling service (`StaffService`/`ManagerService`'s own
 * ownership/permission checks), never by narrowing `core.user` SELECT
 * beyond plain org-tenancy — narrowing it further breaks the INSERT flow
 * that has to exist for identity to be creatable at all. `passwordHash`
 * (the one genuinely sensitive column) is never returned by any API
 * response regardless of this policy — org-scoping still blocks a
 * different organisation's raw query from reading it, which is the RLS
 * layer's real job here.
 */
export class UserSelectRlsRevertToOrgScoped1786668900000 implements MigrationInterface {
  name = 'UserSelectRlsRevertToOrgScoped1786668900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY user_select ON core."user"
        USING (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY user_select ON core."user"
        USING (
          id = core.current_uid()
          OR EXISTS (
            SELECT 1 FROM core.staff_profile sp
            WHERE sp.user_id = "user".id AND sp.workspace_id = core.current_workspace()
          )
          OR EXISTS (
            SELECT 1 FROM core.manager_profile mp
            WHERE mp.user_id = "user".id AND mp.workspace_id = core.current_workspace()
          )
        );
    `);
  }
}
