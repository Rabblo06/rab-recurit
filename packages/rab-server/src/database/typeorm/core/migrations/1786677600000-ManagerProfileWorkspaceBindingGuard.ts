import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An ordinary user may never choose an arbitrary manager_profile.workspace_id.
 *
 * 1. WITH CHECK no longer admits the caller's own profile with any workspace (1786677500000 allowed user_id = current_uid() for any
 *    workspace). A write must now be NULL (pre-workspace), the caller's current trusted workspace, or made by manager.manage.
 *    The server binds the new workspace in the transaction before it stamps a first-time profile (ManagerWorkspaceService.create).
 *
 * 2. BEFORE UPDATE trigger: once a profile's workspace_id is non-NULL it cannot change, except by a manager.manage holder. A WITH CHECK
 *    cannot see the old row, so this is the only place the rebind and the NULL-ing of a bound profile can be refused. The trigger runs as
 *    the caller (SECURITY INVOKER) and reads only user_role, role_permission and permission, which do not reference manager_profile.
 *
 * LEGACY_WITH_CHECK is the WITH CHECK written by 1786677500000, so down() restores it exactly. down() also drops the trigger.
 */
const HAS_MANAGER_MANAGE =
  "(EXISTS (SELECT 1 FROM ((core.user_role ur JOIN core.role_permission rp ON ((rp.role_id = ur.role_id))) JOIN core.permission p ON ((p.id = rp.permission_id))) WHERE ((ur.user_id = core.current_uid()) AND (p.key = 'manager.manage'))))";
const USING =
  '(organisation_id = core.current_org()) AND ((user_id = core.current_uid()) OR (workspace_id = core.current_workspace()) OR ' + HAS_MANAGER_MANAGE + ')';
const NEW_WITH_CHECK =
  '(organisation_id = core.current_org()) AND ((workspace_id IS NULL) OR (workspace_id = core.current_workspace()) OR ' + HAS_MANAGER_MANAGE + ')';
const LEGACY_WITH_CHECK =
  '(organisation_id = core.current_org()) AND ((user_id = core.current_uid()) OR (workspace_id IS NULL) OR (workspace_id = core.current_workspace()) OR ' + HAS_MANAGER_MANAGE + ')';

export class ManagerProfileWorkspaceBindingGuard1786677600000 implements MigrationInterface {
  name = 'ManagerProfileWorkspaceBindingGuard1786677600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER POLICY "manager_profile_tenant" ON core.manager_profile USING (' + USING + ') WITH CHECK (' + NEW_WITH_CHECK + ')');
    await queryRunner.query(`
      CREATE FUNCTION core.guard_manager_profile_workspace_binding()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      AS $$
      BEGIN
        IF OLD.workspace_id IS NOT NULL AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
          IF NOT EXISTS (
            SELECT 1 FROM core.user_role ur
              JOIN core.role_permission rp ON rp.role_id = ur.role_id
              JOIN core.permission p ON p.id = rp.permission_id
             WHERE ur.user_id = core.current_uid() AND p.key = 'manager.manage'
          ) THEN
            RAISE EXCEPTION 'manager_profile workspace is bound and cannot be changed' USING ERRCODE = '42501';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER manager_profile_workspace_binding_guard
        BEFORE UPDATE ON core.manager_profile
        FOR EACH ROW EXECUTE FUNCTION core.guard_manager_profile_workspace_binding()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER IF EXISTS manager_profile_workspace_binding_guard ON core.manager_profile');
    await queryRunner.query('DROP FUNCTION IF EXISTS core.guard_manager_profile_workspace_binding()');
    await queryRunner.query('ALTER POLICY "manager_profile_tenant" ON core.manager_profile USING (' + USING + ') WITH CHECK (' + LEGACY_WITH_CHECK + ')');
  }
}
