import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 correction. `ManagerProfileWorkspaceRls1786668150000`'s
 * SELECT policy (`organisation_id = current_org() AND workspace_id =
 * current_workspace()`) is wrong for this table, confirmed two ways:
 *
 * 1. Postgres requires an `INSERT ... RETURNING` row to ALSO satisfy the
 *    table's SELECT policy, not just the INSERT `WITH CHECK` (reproduced
 *    directly against the live DB: an INSERT whose `WITH CHECK` passes but
 *    whose `RETURNING` row fails the SELECT policy throws "new row violates
 *    row-level security policy", not a WITH-CHECK-specific error). Unlike
 *    every other operational table, `manager_profile.workspace_id` is
 *    ROUTINELY NULL at creation — not just migration-era backfill noise —
 *    because the assignee's own `ManagerWorkspace` frequently doesn't exist
 *    yet (an internal Manager onboards it later; a CEO has no workspace
 *    concept at all). TypeORM's `manager.insert()` always appends
 *    `RETURNING`, so every ordinary `ManagerProfile` creation (`POST
 *    /managers`) tripped this — a functional break, not just an ambiguous
 *    edge case.
 * 2. `DashboardService.getSummary()`'s `managerCount` does `manager.count
 *    (ManagerProfile, {})` — a deliberately unfiltered, org-wide count,
 *    already covered by an existing passing test asserting the full org
 *    total regardless of which Manager is asking. `ManagerController`'s
 *    routes are already gated by `MANAGER_MANAGE` (admin/CEO only) at the
 *    application layer — that permission gate, not a workspace-matching RLS
 *    predicate, is and was always the real access control on "who can see
 *    the manager roster." A platform admin/CEO's own `current_workspace()`
 *    is typically NULL (admin owns no workspace by design), so a
 *    workspace-matching SELECT policy would ALSO have hidden every
 *    already-onboarded manager's profile from the very account meant to
 *    manage them.
 *
 * Revert to a single org-scoped policy — the same shape `manager_profile`
 * had before any of this workspace RLS work touched it, and the same shape
 * this table's real, already-established access-control boundary (the
 * `MANAGER_MANAGE` permission gate) has depended on unchanged throughout.
 * `jobTitle`/`type`/`workspaceId` carry no confidential per-Workspace
 * business data (Staff/Venue/Shift/Offer are the tables this whole
 * migration effort is actually protecting) — org-scoping this table back is
 * not a confidentiality regression.
 */
export class ManagerProfileRlsRevertToOrgScoped1786668200000 implements MigrationInterface {
  name = 'ManagerProfileRlsRevertToOrgScoped1786668200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY manager_profile_delete ON core.manager_profile;`);
    await queryRunner.query(`DROP POLICY manager_profile_update ON core.manager_profile;`);
    await queryRunner.query(`DROP POLICY manager_profile_write ON core.manager_profile;`);
    await queryRunner.query(`DROP POLICY manager_profile_select ON core.manager_profile;`);
    await queryRunner.query(`
      CREATE POLICY manager_profile_tenant ON core.manager_profile
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY manager_profile_tenant ON core.manager_profile;`);
    await queryRunner.query(`
      CREATE POLICY manager_profile_select ON core.manager_profile
        FOR SELECT USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      CREATE POLICY manager_profile_write ON core.manager_profile
        FOR INSERT WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      CREATE POLICY manager_profile_update ON core.manager_profile
        FOR UPDATE USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      CREATE POLICY manager_profile_delete ON core.manager_profile
        FOR DELETE USING (organisation_id = core.current_org());
    `);
  }
}
