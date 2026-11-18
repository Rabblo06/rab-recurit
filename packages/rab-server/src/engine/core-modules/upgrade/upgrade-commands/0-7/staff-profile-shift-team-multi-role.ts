import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';

/**
 * Release 0.7.0, workspace structure level 24 (#205: the staff same-shift Teams list for a staff user who also holds another
 * role). DRAFT — NEW SQL, owner SQL review FIRST; never edited after merge once approved. Depends on #175 (0.7.0 release
 * registration) and #177 (level 23), both drafts awaiting the owner.
 *
 * The bug (layer 4 of #205): the additive RLS policy `staff_profile_shift_team_select` (ShiftTeamReadScope1786718100000,
 * frozen in the template as v1/shift-team-policy.ts) tests `current_setting('rab.role', true) = 'staff'`. `rab.role` is the
 * session's server-resolved role keys joined with commas (TenantContextService binds AuthContext.role =
 * security.roles.join(',')), so the equality is true only for a user whose ONLY role is staff. #205 fixed the service check
 * (layer 2); with this policy unchanged a `manager,staff` caller gets 200 but the database hides every teammate (fail closed:
 * fewer names, never more).
 *
 * What it does: one `ALTER POLICY staff_profile_shift_team_select ON <schema>.staff_profile USING (...)` whose predicate is
 * the frozen one with ONLY the role test changed to membership:
 *   `'staff' = ANY (pg_catalog.string_to_array(current_setting('rab.role', true), ','))`
 *   - an unset `rab.role` → string_to_array(NULL) = NULL → no row (fail closed); '' → '{}' → false;
 *   - role keys cannot contain a comma (system keys are fixed; custom keys are `custom_` + a [a-z0-9_] slug), so no key can
 *     fake membership, and `= ANY` compares whole elements (`custom_staff`, `staffing` never match `staff`);
 *   - every other line of the predicate (tenant binding, the confirmed-assignment capability GUCs, shift status) is copied
 *     unchanged; FOR SELECT, PERMISSIVE, TO PUBLIC and the absent WITH CHECK are unchanged (ALTER POLICY ... USING changes
 *     only the USING expression).
 *   - Idempotent: re-running it stores the same expression. A missing policy makes it fail (42704): the runner rolls the step
 *     back and blocks the workspace (fail closed). It drops nothing (`mayDrop` unset): ALTER POLICY updates pg_policy in
 *     place.
 *   - Lock: ACCESS EXCLUSIVE on this workspace's staff_profile for the catalog update only (no scan, no data change).
 * The same statement on `core.staff_profile` (the HWS-off copy) and in core.provision_workspace (new workspaces) is in
 * migration StaffShiftTeamMultiRole1786721590000.
 */
export const STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE_TIMESTAMP = 1786721590000;

export const SHIFT_TEAM_SELECT_POLICY = 'staff_profile_shift_team_select';

/** The role test of the frozen policy (v1/shift-team-policy.ts) and its replacement. */
export const SHIFT_TEAM_ROLE_EQUALITY = "current_setting('rab.role', true) = 'staff'";
export const SHIFT_TEAM_ROLE_MEMBERSHIP = "'staff' = ANY (pg_catalog.string_to_array(current_setting('rab.role', true), ','))";

function checkedSchema(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  return schema;
}

/** ALTER POLICY with the given role test; every other line is the frozen v1/shift-team-policy.ts predicate. */
function shiftTeamSelectAlterSql(schema: string, roleTest: string): string {
  // sql-injection-reviewed: schema is 'core' or a regex-validated `workspace_<32 hex>` name; roleTest is one of the two constants above.
  const s = checkedSchema(schema);
  return `ALTER POLICY ${SHIFT_TEAM_SELECT_POLICY} ON "${s}".staff_profile USING (
    organisation_id = core.current_org() AND workspace_id = core.current_workspace()
    AND ${roleTest}
    AND EXISTS (
      SELECT 1 FROM "${s}".shift_assignment peer
      JOIN "${s}".shift_assignment own ON own.shift_id = peer.shift_id
        AND own.organisation_id = peer.organisation_id AND own.workspace_id = peer.workspace_id
      JOIN "${s}".shift s ON s.id = peer.shift_id
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

/** The command body (and the core / provision statement): `staff` is one of the caller's roles. */
export function shiftTeamSelectMultiRoleSql(schema: string): string {
  return shiftTeamSelectAlterSql(schema, SHIFT_TEAM_ROLE_MEMBERSHIP);
}

/** down() only (core): the frozen 1786718100000 predicate back (`staff` is the caller's only role). */
export function shiftTeamSelectSingleRoleSql(schema: string): string {
  return shiftTeamSelectAlterSql(schema, SHIFT_TEAM_ROLE_EQUALITY);
}

/**
 * Expected `core.workspace_schema_fingerprint_v2` of a level-24 workspace per PostgreSQL major. Measured (not derived): a
 * level-23 workspace + this command, a workspace built by the TypeScript provisioner and one built by the level-24
 * core.provision_workspace must all equal it (ws-shift-team-multi-role.integration.spec.ts `[l24-fp]`; the per-major
 * `generate-workspace-fingerprints.ts` ci run for 16 / 17 / 18). Measured 2026-11-18 on throwaway postgres:16/17/18-alpine
 * clusters (InstaBox): the level-23 -> 24 upgrade path, reproduced by the TypeScript provisioner and core.provision_workspace. An undeclared major makes StaffShiftTeamMultiRole1786721590000
 * refuse (exit 66): fail closed.
 */
export const STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE_FINGERPRINTS_V2: Readonly<Partial<Record<16 | 17 | 18, string>>> = Object.freeze({
  16: '9a0a761d355fd4731ac4f163b441e7fd1dda27c6f6e1c6435e581d5eea4bedfc',
  17: '022cf67bc6a967d0a32705cb92968e39e8c37f5ab1c93e8cc6f77ad48721c440',
  18: '2c8d82028b7dc5e1820393cd599d30ca720c6a0ac2622ff0deaced7d8ec20487',
});

export const STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE_PROVISION_LITERAL = 'db:provision_workspace@StaffShiftTeamMultiRole1786721590000';

export const STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE: WorkspaceUpgradeCommand = Object.freeze({
  kind: 'workspace',
  name: 'ShiftTeamSelectMultiRole',
  timestamp: STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE_TIMESTAMP,
  sql: shiftTeamSelectMultiRoleSql,
  structure: Object.freeze({
    level: 24,
    fingerprints: STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE_FINGERPRINTS_V2,
    provisionFunctionLiteral: STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE_PROVISION_LITERAL,
  }),
});
