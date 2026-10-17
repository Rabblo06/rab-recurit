/** Frozen additive policy shipped with migration 1786718100000. No RLS bypass.
 * Capability GUCs are transaction-local and bound ONLY after resolving self and
 * locking the caller's confirmed assignment. Normal profile reads remain self-only.
 */
export function shiftTeamPolicy(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  return `CREATE POLICY staff_profile_shift_team_select ON "${schema}".staff_profile FOR SELECT USING (
    organisation_id = core.current_org() AND workspace_id = core.current_workspace()
    AND current_setting('rab.role', true) = 'staff'
    AND EXISTS (
      SELECT 1 FROM "${schema}".shift_assignment peer
      JOIN "${schema}".shift_assignment own ON own.shift_id = peer.shift_id
        AND own.organisation_id = peer.organisation_id AND own.workspace_id = peer.workspace_id
      JOIN "${schema}".shift s ON s.id = peer.shift_id
        AND s.organisation_id = peer.organisation_id AND s.workspace_id = peer.workspace_id
      WHERE peer.staff_profile_id = staff_profile.id
        AND peer.organisation_id = core.current_org() AND peer.workspace_id = core.current_workspace()
        AND peer.shift_id = NULLIF(current_setting('rab.team_shift_id', true), '')::uuid
        AND own.staff_profile_id = NULLIF(current_setting('rab.team_staff_id', true), '')::uuid
        AND own.status = 'confirmed' AND peer.status = 'confirmed'
        AND s.status NOT IN ('cancelled', 'completed')
    )
  )`;
}
