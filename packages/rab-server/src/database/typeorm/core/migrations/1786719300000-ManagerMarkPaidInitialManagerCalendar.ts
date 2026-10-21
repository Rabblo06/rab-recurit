import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Owner decisions 2026-10-21:
 *  1. `payroll.mark_paid` becomes a default of the system `manager` role (Initial + Internal Managers) — in code
 *     (`ROLE_DEFS[internal]`) and here for every existing organisation, bumping the role's permission_version. Not
 *     granted to venue_manager / staff / ceo. Scope is unchanged: own workspace only, never one's own pay
 *     (PayrollRunService + payslip_update WITH CHECK).
 *  2. The agency payment calendar may be imported/replaced ONLY by the organisation's current Initial Manager
 *     (`manager_profile.is_initial_manager`, not superseded, type internal). The write policies of `payroll_calendar`
 *     and `payroll_calendar_period` are re-created with that predicate; reads are unchanged. The service checks the same
 *     designation (plus `payroll.calculate`), so `payroll.calculate` alone is no longer sufficient.
 * Same mechanism as ManagerPayrollApproveDefault1786718900000 for (1).
 */
export const SYSTEM_ROLE_DEFAULT_ADDITIONS_1786719300000: Readonly<Record<string, readonly string[]>> = {
  manager: ['payroll.mark_paid'],
};

const INITIAL_MANAGER = `(EXISTS (SELECT 1 FROM core.manager_profile mp WHERE (mp.user_id = core.current_uid())
  AND (mp.organisation_id = core.current_org()) AND (mp.type = 'internal'::text) AND mp.is_initial_manager AND (mp.superseded_at IS NULL)))`;
const ANY_MANAGER = `(EXISTS (SELECT 1 FROM core.manager_profile mp WHERE (mp.user_id = core.current_uid())
  AND (mp.organisation_id = core.current_org()) AND (mp.type <> 'venue'::text)))`;

function writePolicies(t: string, predicate: string): string {
  return `
DROP POLICY IF EXISTS ${t}_insert ON core.${t};
CREATE POLICY ${t}_insert ON core.${t} AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK ((organisation_id = core.current_org()) AND ${predicate});
DROP POLICY IF EXISTS ${t}_update ON core.${t};
CREATE POLICY ${t}_update ON core.${t} AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING ((organisation_id = core.current_org()) AND ${predicate}) WITH CHECK ((organisation_id = core.current_org()) AND ${predicate});`;
}

export class ManagerMarkPaidInitialManagerCalendar1786719300000 implements MigrationInterface {
  name = 'ManagerMarkPaidInitialManagerCalendar1786719300000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DO $grant$
      DECLARE o record; v_perm uuid; v_roles integer := 0;
      BEGIN
        SELECT id INTO v_perm FROM core.permission WHERE key = 'payroll.mark_paid';
        IF v_perm IS NULL THEN RAISE EXCEPTION 'ManagerMarkPaidInitialManagerCalendar1786719300000: permission payroll.mark_paid missing'; END IF;
        FOR o IN SELECT id FROM core.organisation ORDER BY id LOOP
          PERFORM set_config('rab.organisation_id', o.id::text, true);
          PERFORM set_config('rab.workspace_id', '', true);
          WITH ins AS (
            INSERT INTO core.role_permission (role_id, permission_id, organisation_id)
            SELECT r.id, v_perm, r.organisation_id FROM core.role r
             WHERE r.organisation_id = o.id AND r.workspace_id IS NULL AND r.is_system AND r.key = 'manager'
               AND NOT EXISTS (SELECT 1 FROM core.role_permission x WHERE x.role_id = r.id AND x.permission_id = v_perm)
            RETURNING role_id
          )
          UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT role_id FROM ins);
          GET DIAGNOSTICS v_roles = ROW_COUNT;
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        PERFORM set_config('rab.workspace_id', '', true);
      END
      $grant$;`);
    for (const t of ['payroll_calendar', 'payroll_calendar_period']) await runner.query(writePolicies(t, INITIAL_MANAGER));
  }

  async down(runner: QueryRunner): Promise<void> {
    for (const t of ['payroll_calendar', 'payroll_calendar_period']) await runner.query(writePolicies(t, ANY_MANAGER));
    await runner.query(`
      DO $revoke$
      DECLARE o record;
      BEGIN
        FOR o IN SELECT id FROM core.organisation ORDER BY id LOOP
          PERFORM set_config('rab.organisation_id', o.id::text, true);
          PERFORM set_config('rab.workspace_id', '', true);
          WITH del AS (
            DELETE FROM core.role_permission rp USING core.role r, core.permission p
             WHERE rp.role_id = r.id AND rp.permission_id = p.id AND p.key = 'payroll.mark_paid'
               AND r.organisation_id = o.id AND r.workspace_id IS NULL AND r.is_system AND r.key = 'manager'
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
