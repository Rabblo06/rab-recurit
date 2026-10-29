/**
 * Frozen SQL shipped with migration VenueTeamOrgAdmin1786721090000 (module v1.018; applied to `core` by that migration and
 * to every workspace schema by WorkspaceSchemaMigrator / the provisioner after module 17). Never edit after merge.
 *
 * Owner decision 2026-10-28: the existing Assigned Staff feature (venue_manager_staff, owner-assigned) is extended — not
 * duplicated — to organisation administrators: an effective holder of `manager.manage` in the row's organisation (the CEO
 * by default; a platform admin only through their own role or grant in their own organisation) may view, add and remove
 * the Staff a Venue Manager can see, in any workspace of that organisation, and may read that workspace's Staff while
 * choosing them ("picker only"). The workspace owner's policy (`venue_manager_staff_owner`) and the Venue Manager's own
 * policies are unchanged; nothing is dropped or loosened for anyone else.
 *
 * Both policies are additionally gated on `rab.admin_scope = 'venue_team'`, which only VenueManagerService's org-admin
 * Assigned Staff methods bind (transaction-local). Every other request of the same administrator — the general Staff list
 * included — keeps exactly its previous visibility. The flag narrows accidental reach; it is not a boundary against a
 * compromised runtime connection (the same trust level as `rab.actor_type` / `rab.team_shift_id`).
 *
 * The permission predicate mirrors PermissionsService.userHasPermissionTx exactly, so the database and the service can
 * never disagree: a per-user override decides first (`revoke` denies, `grant` allows; the primary key (user_id,
 * permission_id) allows at most one), otherwise a role visible under RLS must carry `manager.manage`. Both lookups are
 * additionally pinned to the bound organisation.
 *
 *   - venue_manager_staff_org_admin   FOR ALL     bound org + bound workspace + admin scope + effective manager.manage;
 *                                                  WITH CHECK also requires the target profile to be a Venue Manager of
 *                                                  that same workspace (same rule as the owner policy)
 *   - staff_profile_org_admin_picker  FOR SELECT  bound org + bound workspace + admin scope + effective manager.manage
 */
export function venueTeamOrgAdminSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const q = (table: string) => `"${schema}".${table}`;
  const override = (effect: string) => `(EXISTS (
        SELECT 1 FROM (core.user_permission_override upo JOIN core.permission op ON (op.id = upo.permission_id))
        WHERE (upo.user_id = core.current_uid()) AND (upo.organisation_id = core.current_org())
          AND (op.key = 'manager.manage'::text) AND (upo.effect = '${effect}'::text)))`;
  const viaRole = `(EXISTS (
        SELECT 1 FROM (((core.user_role ur JOIN core.role r ON (r.id = ur.role_id))
          JOIN core.role_permission rp ON (rp.role_id = ur.role_id)) JOIN core.permission p ON (p.id = rp.permission_id))
        WHERE (ur.user_id = core.current_uid()) AND (ur.organisation_id = core.current_org()) AND (p.key = 'manager.manage'::text)))`;
  const orgAdmin = (table: string) => `(${table}.organisation_id = core.current_org()) AND (${table}.workspace_id = core.current_workspace())
      AND (current_setting('rab.admin_scope'::text, true) = 'venue_team'::text)
      AND (NOT ${override('revoke')}) AND (${override('grant')} OR ${viaRole})`;
  const targetIsVenueManager = `(EXISTS (
      SELECT 1 FROM core.manager_profile tp
      WHERE (tp.id = venue_manager_staff.manager_profile_id) AND (tp.type = 'venue'::text)
        AND (tp.organisation_id = core.current_org()) AND (tp.workspace_id = core.current_workspace())))`;
  return `
DROP POLICY IF EXISTS venue_manager_staff_org_admin ON ${q('venue_manager_staff')};
DROP POLICY IF EXISTS staff_profile_org_admin_picker ON ${q('staff_profile')};
CREATE POLICY venue_manager_staff_org_admin ON ${q('venue_manager_staff')} AS PERMISSIVE FOR ALL TO PUBLIC USING (${orgAdmin('venue_manager_staff')}) WITH CHECK (${orgAdmin('venue_manager_staff')} AND ${targetIsVenueManager});
CREATE POLICY staff_profile_org_admin_picker ON ${q('staff_profile')} AS PERMISSIVE FOR SELECT TO PUBLIC USING (${orgAdmin('staff_profile')});
`;
}
