import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Owner decision (2026-10-20, payroll approval): "any manager holding payroll.approve, within their own workspace —
 * Initial and Internal Managers each approve their own workspace's payroll". Both hold the org-level system role
 * `manager` (ManagerType.INTERNAL; the Initial Manager is an internal manager flagged `is_initial_manager`), so
 * `payroll.approve` becomes a default of that role — in code (`ROLE_DEFS[internal]`, which new organisations get through
 * ManagerService.ensureRole / the factories) and here, for every existing organisation.
 *
 * Additive only, same mechanism as PermissionCatalogueAndSystemRoleDefaults1786718000000: for every organisation (its
 * tenant context bound — role / role_permission are FORCE RLS) the system `manager` role gets the grant if it lacks it,
 * and its permission_version is bumped so cached authorisation snapshots die. NOT granted to `venue_manager`, `staff`
 * or `ceo` (the decision names Initial and Internal Managers only); custom / workspace roles are untouched (members are
 * capped by MEMBER_ROLE_ALLOWED_PERMISSIONS anyway). The flag itself is already in the catalogue (1786718000000).
 * Who may approve WHAT is still enforced by PayrollService (own workspace only, never own hours) and payroll_record RLS.
 */
export const SYSTEM_ROLE_DEFAULT_ADDITIONS_1786718900000: Readonly<Record<string, readonly string[]>> = {
  manager: ['payroll.approve'],
};

export class ManagerPayrollApproveDefault1786718900000 implements MigrationInterface {
  name = 'ManagerPayrollApproveDefault1786718900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $grant$
      DECLARE
        o record;
        v_perm uuid;
        v_roles integer := 0;
      BEGIN
        SELECT id INTO v_perm FROM core.permission WHERE key = 'payroll.approve';
        IF v_perm IS NULL THEN
          RAISE EXCEPTION 'ManagerPayrollApproveDefault1786718900000: permission payroll.approve missing from core.permission';
        END IF;
        FOR o IN SELECT id FROM core.organisation ORDER BY id LOOP
          PERFORM set_config('rab.organisation_id', o.id::text, true);
          PERFORM set_config('rab.workspace_id', '', true);
          WITH ins AS (
            INSERT INTO core.role_permission (role_id, permission_id, organisation_id)
            SELECT r.id, v_perm, r.organisation_id
              FROM core.role r
             WHERE r.organisation_id = o.id AND r.workspace_id IS NULL AND r.is_system AND r.key = 'manager'
               AND NOT EXISTS (SELECT 1 FROM core.role_permission x WHERE x.role_id = r.id AND x.permission_id = v_perm)
            RETURNING role_id
          )
          UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT role_id FROM ins);
          GET DIAGNOSTICS v_roles = ROW_COUNT;
          IF v_roles > 0 THEN RAISE NOTICE 'ManagerPayrollApproveDefault: organisation % manager role granted payroll.approve', o.id; END IF;
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $grant$;
    `);
  }

  /** Removes the grant again from system `manager` roles (an explicit revert of this decision), bumping their versions. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $revoke$
      DECLARE o record;
      BEGIN
        FOR o IN SELECT id FROM core.organisation ORDER BY id LOOP
          PERFORM set_config('rab.organisation_id', o.id::text, true);
          PERFORM set_config('rab.workspace_id', '', true);
          WITH del AS (
            DELETE FROM core.role_permission rp
             USING core.role r, core.permission p
             WHERE rp.role_id = r.id AND rp.permission_id = p.id AND p.key = 'payroll.approve'
               AND r.organisation_id = o.id AND r.workspace_id IS NULL AND r.is_system AND r.key = 'manager'
            RETURNING rp.role_id
          )
          UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT role_id FROM del);
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $revoke$;
    `);
  }
}
