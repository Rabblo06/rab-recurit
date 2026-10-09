// Installed after the pre-FORCE gate (see HYPER-WORKSPACE-PHASE3-FOUNDATION.md, FINAL MEMBERSHIP CUTOVER CHECKPOINT).
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, items 5–7 — step I/J: FORCE RLS on core.workspace_membership, and the ordinary policy
 * replaced by self-scoped visibility.
 *
 * - SELECT: only the bound user's own row, inside the bound organisation. An ordinary request cannot enumerate every
 *   membership of its organisation.
 * - INSERT: the new row must be in the bound organisation AND the bound workspace (server-derived by the write path).
 * - UPDATE: only the bound user's own row. Lifecycle changes for OTHER users go through the SECURITY DEFINER
 *   suspend/reinstate functions, which bind the target user themselves.
 * - No DELETE for rab_app (already revoked).
 *
 * Under FORCE the owner is subject to these policies, so every SECURITY DEFINER resolver binds rab.organisation_id and
 * rab.user_id itself and restores the caller's values (see WorkspaceMembershipCutover).
 */
export class WorkspaceMembershipForceRls1786675200000 implements MigrationInterface {
  name = 'WorkspaceMembershipForceRls1786675200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.workspace_membership ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.workspace_membership FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`DROP POLICY IF EXISTS workspace_membership_tenant ON core.workspace_membership;`);
    await queryRunner.query(`
      CREATE POLICY workspace_membership_self_select ON core.workspace_membership
        FOR SELECT
        USING (organisation_id = core.current_org() AND user_id = core.current_uid());
    `);
    await queryRunner.query(`
      CREATE POLICY workspace_membership_insert ON core.workspace_membership
        FOR INSERT
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      CREATE POLICY workspace_membership_self_update ON core.workspace_membership
        FOR UPDATE
        USING (organisation_id = core.current_org() AND user_id = core.current_uid())
        WITH CHECK (organisation_id = core.current_org() AND user_id = core.current_uid());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS workspace_membership_self_update ON core.workspace_membership;`);
    await queryRunner.query(`DROP POLICY IF EXISTS workspace_membership_insert ON core.workspace_membership;`);
    await queryRunner.query(`DROP POLICY IF EXISTS workspace_membership_self_select ON core.workspace_membership;`);
    await queryRunner.query(`
      CREATE POLICY workspace_membership_tenant ON core.workspace_membership
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`ALTER TABLE core.workspace_membership NO FORCE ROW LEVEL SECURITY;`);
  }
}
