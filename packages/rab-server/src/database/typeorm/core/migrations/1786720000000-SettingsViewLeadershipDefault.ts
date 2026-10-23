import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W6-E2E-04 — owner decision 2026-10-23: "Changing organisation settings (incl. turning off password sign-in) =
 * PLATFORM ADMIN ONLY." The mutations moved to the platform-admin routes (`/rest/v1/admin/organisations/:id/settings…`,
 * `OrganisationSettingsAdminService`) and the tenant mutation routes were removed. The tenant UI shows the settings
 * READ-ONLY, which needs a read grant: until now NO system role held `settings.view` (only fixtures did), so the read
 * routes (`GET /rest/v1/workspace`, `GET /rest/v1/workspace/security`) answered 403 to everyone.
 *
 * This grants `settings.view` — never `settings.edit` — to the organisation-level system roles `ceo` and `manager`
 * (Initial + Internal Managers) of every existing organisation, bumping each changed role's `permission_version`
 * (the auth-context cache key), the same mechanism as ManagerPayrollApproveDefault1786718900000 /
 * ManagerMarkPaidInitialManagerCalendar1786719300000. New organisations get it from `ROLE_DEFS` in code
 * (`manager.service.ts`); `permission-catalogue.spec.ts` keeps the two equal. venue_manager and staff are unchanged.
 *
 * ASSUMPTION FLAGGED FOR THE OWNER (permissions): which tenant roles may VIEW the settings is not part of the decision
 * text; CEO + Manager mirrors who the E2E lane expected to reach Settings → Security. Revert = this migration's down().
 *
 * No schema change, no new table, no RLS change: rows in `core.role_permission` only (written per organisation with the
 * tenant GUCs bound, as the FORCEd policies require). Not production-approved (production-migration-approval.ts).
 */
export const SYSTEM_ROLE_DEFAULT_ADDITIONS_1786720000000: Readonly<Record<string, readonly string[]>> = {
  ceo: ['settings.view'],
  manager: ['settings.view'],
};

export class SettingsViewLeadershipDefault1786720000000 implements MigrationInterface {
  name = 'SettingsViewLeadershipDefault1786720000000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DO $grant$
      DECLARE o record; v_perm uuid;
      BEGIN
        SELECT id INTO v_perm FROM core.permission WHERE key = 'settings.view';
        IF v_perm IS NULL THEN RAISE EXCEPTION 'SettingsViewLeadershipDefault1786720000000: permission settings.view missing'; END IF;
        FOR o IN SELECT id FROM core.organisation ORDER BY id LOOP
          PERFORM set_config('rab.organisation_id', o.id::text, true);
          PERFORM set_config('rab.workspace_id', '', true);
          WITH ins AS (
            INSERT INTO core.role_permission (role_id, permission_id, organisation_id)
            SELECT r.id, v_perm, r.organisation_id FROM core.role r
             WHERE r.organisation_id = o.id AND r.workspace_id IS NULL AND r.is_system AND r.key IN ('ceo', 'manager')
               AND NOT EXISTS (SELECT 1 FROM core.role_permission x WHERE x.role_id = r.id AND x.permission_id = v_perm)
            RETURNING role_id
          )
          UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT role_id FROM ins);
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $grant$;`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DO $revoke$
      DECLARE o record;
      BEGIN
        FOR o IN SELECT id FROM core.organisation ORDER BY id LOOP
          PERFORM set_config('rab.organisation_id', o.id::text, true);
          PERFORM set_config('rab.workspace_id', '', true);
          WITH del AS (
            DELETE FROM core.role_permission rp USING core.role r, core.permission p
             WHERE rp.role_id = r.id AND rp.permission_id = p.id AND p.key = 'settings.view'
               AND r.organisation_id = o.id AND r.workspace_id IS NULL AND r.is_system AND r.key IN ('ceo', 'manager')
            RETURNING rp.role_id
          )
          UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT role_id FROM del);
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $revoke$;`);
  }
}
