import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Manager profiles are workspace-private. The legacy policy was organisation-only, so any Manager could enumerate the profiles of every
 * private workspace in the same organisation. The product rule is: same organisation, different private workspaces.
 *
 * New visibility (USING), all of it required together with the organisation match:
 *   - the caller's own profile (user_id = current_uid()), so login, /me and the caller's own profile keep working;
 *   - profiles in the caller's current workspace (workspace_id = current_workspace());
 *   - broader access only through the explicit permission manager.manage (held by CEO and admin roles), checked through user_role,
 *     role_permission and permission. Those tables do not reference manager_profile, so the policy cannot recurse.
 *
 * WITH CHECK: a profile may be written with no workspace yet (a Venue Manager is born unresolved), with the caller's current workspace,
 * or by a manager.manage holder. A Manager cannot create or move a profile into another workspace.
 *
 * LEGACY_* holds the exact text that pg_policies returned before this migration, so down() restores it exactly.
 */
const LEGACY_USING = '(organisation_id = core.current_org())';
const LEGACY_WITH_CHECK = '(organisation_id = core.current_org())';
const HAS_MANAGER_MANAGE =
  "(EXISTS (SELECT 1 FROM ((core.user_role ur JOIN core.role_permission rp ON ((rp.role_id = ur.role_id))) JOIN core.permission p ON ((p.id = rp.permission_id))) WHERE ((ur.user_id = core.current_uid()) AND (p.key = 'manager.manage'))))";
const NEW_USING =
  '(organisation_id = core.current_org()) AND ((user_id = core.current_uid()) OR (workspace_id = core.current_workspace()) OR ' + HAS_MANAGER_MANAGE + ')';
const NEW_WITH_CHECK =
  '(organisation_id = core.current_org()) AND ((workspace_id IS NULL) OR (workspace_id = core.current_workspace()) OR ' + HAS_MANAGER_MANAGE + ')';

export class ManagerProfileWorkspaceVisibility1786677400000 implements MigrationInterface {
  name = 'ManagerProfileWorkspaceVisibility1786677400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER POLICY "manager_profile_tenant" ON core.manager_profile USING (' + NEW_USING + ') WITH CHECK (' + NEW_WITH_CHECK + ')');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER POLICY "manager_profile_tenant" ON core.manager_profile USING (' + LEGACY_USING + ') WITH CHECK (' + LEGACY_WITH_CHECK + ')');
  }
}
