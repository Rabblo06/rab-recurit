import { MigrationInterface, QueryRunner } from 'typeorm';
import { venueManagerStaffAssignmentSql } from '../../workspace-schema/v1/venue-manager-staff-assignment';

/**
 * Owner-assigned Venue Manager teams (owner decision 2026-10-16). See `venueManagerStaffAssignmentSql` for the policy set.
 * Additive columns (`is_favourite`, `is_emergency`, default false) plus a policy swap; no row is changed or deleted.
 * Applied to core and to every provisioned workspace schema that has the table.
 */
export class VenueManagerStaffAssignment1786718200000 implements MigrationInterface {
  name = 'VenueManagerStaffAssignment1786718200000';

  private async schemas(runner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await runner.query(`
      SELECT n.nspname AS schema_name FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'venue_manager_staff' AND c.relkind = 'r'
      WHERE n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$'
    `);
    return rows.map((row) => row.schema_name);
  }

  async up(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) await runner.query(venueManagerStaffAssignmentSql(schema));
  }

  /** Restores the previous single Venue-Manager-only policy; the tag columns are kept (dropping them would lose data). */
  async down(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) {
      const t = `"${schema}".venue_manager_staff`;
      const local = (table: string) => (schema === 'core' ? `core.${table}` : `"${schema}".${table}`);
      const vm = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS (SELECT 1 FROM (core.manager_profile mp JOIN ${local('manager_venue')} mv ON (mv.manager_profile_id = mp.id)) JOIN ${local('venue')} v ON (v.id = mv.venue_id) WHERE (mp.id = venue_manager_staff.manager_profile_id) AND (mp.user_id = core.current_uid()) AND (mp.type = 'venue'::text) AND (mp.workspace_id = core.current_workspace()) AND (mp.organisation_id = core.current_org()) AND (mv.workspace_id = core.current_workspace()) AND (mv.organisation_id = core.current_org()) AND (v.workspace_id = core.current_workspace()) AND (v.organisation_id = core.current_org())))`;
      await runner.query(`
        DROP POLICY IF EXISTS venue_manager_staff_vm_select ON ${t};
        DROP POLICY IF EXISTS venue_manager_staff_vm_update ON ${t};
        DROP POLICY IF EXISTS venue_manager_staff_owner ON ${t};
        CREATE POLICY venue_manager_staff_scope ON ${t} AS PERMISSIVE FOR ALL TO PUBLIC USING (${vm})
          WITH CHECK (${vm} AND (EXISTS (SELECT 1 FROM (core.user_role ur JOIN core.role r ON (r.id = ur.role_id)) WHERE (ur.user_id = core.current_uid()) AND (r.key = 'venue_manager'::text))));
      `);
    }
  }
}
