import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recurring 403 root cause (2026-10-15, RECURRING_403_AUTHORIZATION_ROOT_CAUSE_REPORT.md).
 *
 * The permission catalogue (`core.permission`) was never created by the migration chain: only the dev-only `seed` CLI
 * (and the test factories) inserted the PermissionFlag rows, so a database built from migrations alone held 6 of the 43
 * keys. System roles are then created by intersecting their code defaults with whatever the catalogue holds (ManagerService
 * .ensureRole, StaffService.ensureStaffRole, the bootstrap-admin command), so every role on such a database silently lost
 * most of its permissions — a CEO kept 4 of 33 and every operational page answered 403. A long-lived database that had
 * once been seeded by hand hid this; every clean rebuild brought it back.
 *
 * This migration makes the catalogue part of the schema contract and repairs existing SYSTEM roles:
 *   1. Upserts every PermissionFlag key (frozen snapshot below — a new flag ships with its own migration; the
 *      permission-catalogue spec fails otherwise).
 *   2. For every organisation, grants each org-level system role (ceo, manager, venue_manager, staff) any of its CODE
 *      DEFAULTS it is missing, and bumps that role's permission_version so cached authorisation snapshots die. It only
 *      ADDS a role's own defaults: system roles are read-only in the role editor (RoleService), so a missing default can
 *      only be the catalogue defect, never an administrator's deliberate choice. Custom roles, workspace roles,
 *      platform_admin, memberships and users are not touched.
 *   3. Verifies: refuses to be recorded if any key is still missing from the catalogue.
 *
 * role / role_permission are FORCE RLS: each organisation is processed with its own tenant context bound, exactly like
 * BackfillCustomRoleObjectRulesUnderForcedRls1786717600000. Runs in phase B (bootstrap identity).
 */
export const PERMISSION_CATALOGUE_1786718000000: readonly string[] = [
  'staff.view',
  'staff.create',
  'staff.edit',
  'staff.deactivate',
  'staff.view_sensitive',
  'manager.manage',
  'user.manage_permissions',
  'user.reset_password',
  'venue.view',
  'venue.create',
  'venue_manager.create',
  'venue.edit',
  'schedule.view',
  'schedule.create',
  'schedule.publish',
  'schedule.bulk',
  'schedule.override_conflict',
  'offer.send',
  'offer.withdraw',
  'offer.respond',
  'offer.confirm',
  'attendance.clock',
  'attendance.view',
  'attendance.edit',
  'attendance.approve',
  'attendance.clock_override',
  'payroll.view',
  'payroll.calculate',
  'payroll.approve',
  'payroll.mark_paid',
  'payslip.view_own',
  'payslip.view_all',
  'review.create',
  'staffing_request.create',
  'staffing_request.approve',
  'report.view',
  'report.export',
  'audit.view',
  'settings.edit',
  'dashboard.view',
  'settings.view',
  'role.view',
  'role.manage',
];

export const SYSTEM_ROLE_DEFAULTS_1786718000000: Readonly<
  Record<string, readonly string[]>
> = {
  manager: [
    'staff.view',
    'staff.create',
    'staff.edit',
    'staff.deactivate',
    'staff.view_sensitive',
    'user.reset_password',
    'venue.view',
    'venue.create',
    'venue_manager.create',
    'venue.edit',
    'schedule.view',
    'schedule.create',
    'schedule.publish',
    'schedule.bulk',
    'schedule.override_conflict',
    'offer.send',
    'offer.withdraw',
    'offer.confirm',
    'attendance.view',
    'attendance.edit',
    'attendance.approve',
    'attendance.clock_override',
    'payroll.view',
    'payroll.calculate',
    'payslip.view_all',
    'review.create',
    'staffing_request.create',
    'staffing_request.approve',
    'report.view',
    'report.export',
    'audit.view',
    'role.view',
    'role.manage',
  ],
  venue_manager: [
    'staff.view',
    'venue.view',
    'schedule.view',
    'attendance.view',
    'review.create',
    'staffing_request.create',
    'report.view',
    'attendance.edit',
    'report.export',
  ],
  ceo: [
    'staff.view',
    'staff.create',
    'staff.edit',
    'staff.deactivate',
    'staff.view_sensitive',
    'user.reset_password',
    'manager.manage',
    'venue.view',
    'venue.create',
    'venue.edit',
    'schedule.view',
    'schedule.create',
    'schedule.publish',
    'schedule.bulk',
    'schedule.override_conflict',
    'offer.send',
    'offer.withdraw',
    'offer.confirm',
    'attendance.view',
    'attendance.edit',
    'attendance.approve',
    'attendance.clock_override',
    'payroll.view',
    'payroll.calculate',
    'payslip.view_all',
    'review.create',
    'staffing_request.create',
    'staffing_request.approve',
    'report.view',
    'report.export',
    'audit.view',
    'role.view',
    'role.manage',
  ],
  staff: ['offer.respond', 'payslip.view_own', 'attendance.clock'],
};

const sqlText = (values: readonly string[]) =>
  values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');

export class PermissionCatalogueAndSystemRoleDefaults1786718000000 implements MigrationInterface {
  name = 'PermissionCatalogueAndSystemRoleDefaults1786718000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO core.permission (key, resource, action)
      SELECT k, split_part(k, '.', 1), substr(k, length(split_part(k, '.', 1)) + 2)
        FROM unnest(ARRAY[${sqlText(PERMISSION_CATALOGUE_1786718000000)}]::text[]) AS k
      ON CONFLICT (key) DO NOTHING;
    `);

    const defaults = Object.entries(SYSTEM_ROLE_DEFAULTS_1786718000000)
      .flatMap(([roleKey, flags]) =>
        flags.map((flag) => `('${roleKey}', '${flag}')`),
      )
      .join(',\n            ');

    await queryRunner.query(`
      DO $repair$
      DECLARE
        o record;
        v_roles integer := 0;
        v_grants integer := 0;
        v_n integer;
      BEGIN
        FOR o IN SELECT id FROM core.organisation ORDER BY id LOOP
          PERFORM set_config('rab.organisation_id', o.id::text, true);
          PERFORM set_config('rab.workspace_id', '', true);

          CREATE TEMP TABLE IF NOT EXISTS pg_temp.repair_1786718000000 (role_id uuid) ON COMMIT DROP;
          TRUNCATE pg_temp.repair_1786718000000;

          WITH d(role_key, flag) AS (VALUES
            ${defaults}
          ), ins AS (
            INSERT INTO core.role_permission (role_id, permission_id, organisation_id)
            SELECT r.id, p.id, r.organisation_id
              FROM core.role r
              JOIN d ON d.role_key = r.key
              JOIN core.permission p ON p.key = d.flag
             WHERE r.organisation_id = o.id AND r.workspace_id IS NULL AND r.is_system
               AND NOT EXISTS (SELECT 1 FROM core.role_permission x WHERE x.role_id = r.id AND x.permission_id = p.id)
            RETURNING role_id
          )
          INSERT INTO pg_temp.repair_1786718000000 SELECT role_id FROM ins;
          GET DIAGNOSTICS v_n = ROW_COUNT;
          v_grants := v_grants + v_n;

          UPDATE core.role SET permission_version = permission_version + 1
           WHERE id IN (SELECT DISTINCT role_id FROM pg_temp.repair_1786718000000);
          GET DIAGNOSTICS v_n = ROW_COUNT;
          v_roles := v_roles + v_n;
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
        RAISE NOTICE 'PermissionCatalogueAndSystemRoleDefaults: % system role(s) repaired, % default grant(s) restored', v_roles, v_grants;
      END
      $repair$;
    `);

    const missing: Array<{ key: string }> = await queryRunner.query(
      `SELECT k AS key FROM unnest(ARRAY[${sqlText(PERMISSION_CATALOGUE_1786718000000)}]::text[]) AS k
        WHERE NOT EXISTS (SELECT 1 FROM core.permission p WHERE p.key = k)`,
    );
    if (missing.length > 0) {
      throw new Error(
        `PermissionCatalogueAndSystemRoleDefaults1786718000000: catalogue still missing ${missing.map((m) => m.key).join(', ')}`,
      );
    }
  }

  public async down(): Promise<void> {
    // Intentionally a no-op: removing catalogue rows or default grants would strip access from every role that relies
    // on them. A rollback of the code that needs these keys does not require removing them.
  }
}
