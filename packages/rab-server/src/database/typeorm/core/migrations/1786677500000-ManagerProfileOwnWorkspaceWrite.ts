import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A Manager onboarding its first workspace sets its OWN profile's workspace_id (ManagerWorkspaceService.create). The caller has no
 * workspace bound yet, so the WITH CHECK of 1786677400000 refused the UPDATE and POST /manager-workspaces returned 500.
 *
 * The WITH CHECK now also admits the caller's OWN profile (user_id = current_uid()). That is not a cross-workspace grant: a profile's
 * workspace only links to what the service sets, and every manager link is still checked by the composite FK and by RLS. USING and the
 * other branches are unchanged.
 *
 * LEGACY_WITH_CHECK is the WITH CHECK text written by 1786677400000, so down() restores it exactly.
 */
const HAS_MANAGER_MANAGE =
  "(EXISTS (SELECT 1 FROM ((core.user_role ur JOIN core.role_permission rp ON ((rp.role_id = ur.role_id))) JOIN core.permission p ON ((p.id = rp.permission_id))) WHERE ((ur.user_id = core.current_uid()) AND (p.key = 'manager.manage'))))";
const LEGACY_WITH_CHECK =
  '(organisation_id = core.current_org()) AND ((workspace_id IS NULL) OR (workspace_id = core.current_workspace()) OR ' + HAS_MANAGER_MANAGE + ')';
const NEW_WITH_CHECK =
  '(organisation_id = core.current_org()) AND ((user_id = core.current_uid()) OR (workspace_id IS NULL) OR (workspace_id = core.current_workspace()) OR ' + HAS_MANAGER_MANAGE + ')';
const USING =
  '(organisation_id = core.current_org()) AND ((user_id = core.current_uid()) OR (workspace_id = core.current_workspace()) OR ' + HAS_MANAGER_MANAGE + ')';

export class ManagerProfileOwnWorkspaceWrite1786677500000 implements MigrationInterface {
  name = 'ManagerProfileOwnWorkspaceWrite1786677500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER POLICY "manager_profile_tenant" ON core.manager_profile USING (' + USING + ') WITH CHECK (' + NEW_WITH_CHECK + ')');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER POLICY "manager_profile_tenant" ON core.manager_profile USING (' + USING + ') WITH CHECK (' + LEGACY_WITH_CHECK + ')');
  }
}
