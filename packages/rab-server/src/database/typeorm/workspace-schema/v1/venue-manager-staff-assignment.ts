/**
 * Frozen SQL shipped with migration 1786718200000 (and applied by the provisioner after the V1 template).
 *
 * Owner decision 2026-10-16: the workspace's Manager (the workspace OWNER) decides which Staff each of their Venue
 * Managers may see and select. The Venue Manager only reads their own team rows and may change their own per-row
 * tags (favourite / emergency cover); they can no longer add or remove team members.
 *
 * Replaces the single `venue_manager_staff_scope` FOR ALL policy (Venue Manager only) with:
 *   - venue_manager_staff_vm_select  FOR SELECT  the calling Venue Manager's own rows (unchanged predicate)
 *   - venue_manager_staff_vm_update  FOR UPDATE  same rows; the service only ever writes is_favourite / is_emergency
 *   - venue_manager_staff_owner      FOR ALL     the owner of the row's workspace; WITH CHECK also requires the manager
 *                                                 profile to be a Venue Manager of that same workspace
 * The composite FKs (manager/staff × organisation × workspace) still pin both sides to the row's workspace.
 */
export function venueManagerStaffAssignmentSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const t = `"${schema}".venue_manager_staff`;
  const local = (table: string) => (schema === 'core' ? `core.${table}` : `"${schema}".${table}`);
  const vmOwnRow = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS (
      SELECT 1 FROM (core.manager_profile mp JOIN ${local('manager_venue')} mv ON (mv.manager_profile_id = mp.id))
        JOIN ${local('venue')} v ON (v.id = mv.venue_id)
      WHERE (mp.id = venue_manager_staff.manager_profile_id) AND (mp.user_id = core.current_uid()) AND (mp.type = 'venue'::text)
        AND (mp.workspace_id = core.current_workspace()) AND (mp.organisation_id = core.current_org())
        AND (mv.workspace_id = core.current_workspace()) AND (mv.organisation_id = core.current_org())
        AND (v.workspace_id = core.current_workspace()) AND (v.organisation_id = core.current_org())))`;
  const workspaceOwner = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS (
      SELECT 1 FROM core.manager_workspace w
      WHERE (w.id = venue_manager_staff.workspace_id) AND (w.organisation_id = core.current_org())
        AND (w.owner_user_id = core.current_uid())))`;
  const targetIsVenueManager = `(EXISTS (
      SELECT 1 FROM core.manager_profile tp
      WHERE (tp.id = venue_manager_staff.manager_profile_id) AND (tp.type = 'venue'::text)
        AND (tp.organisation_id = core.current_org()) AND (tp.workspace_id = core.current_workspace())))`;
  return `
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS is_favourite boolean NOT NULL DEFAULT false;
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS is_emergency boolean NOT NULL DEFAULT false;
DROP POLICY IF EXISTS venue_manager_staff_scope ON ${t};
DROP POLICY IF EXISTS venue_manager_staff_vm_select ON ${t};
DROP POLICY IF EXISTS venue_manager_staff_vm_update ON ${t};
DROP POLICY IF EXISTS venue_manager_staff_owner ON ${t};
CREATE POLICY venue_manager_staff_vm_select ON ${t} AS PERMISSIVE FOR SELECT TO PUBLIC USING (${vmOwnRow});
CREATE POLICY venue_manager_staff_vm_update ON ${t} AS PERMISSIVE FOR UPDATE TO PUBLIC USING (${vmOwnRow}) WITH CHECK (${vmOwnRow});
CREATE POLICY venue_manager_staff_owner ON ${t} AS PERMISSIVE FOR ALL TO PUBLIC USING (${workspaceOwner}) WITH CHECK (${workspaceOwner} AND ${targetIsVenueManager});
`;
}
