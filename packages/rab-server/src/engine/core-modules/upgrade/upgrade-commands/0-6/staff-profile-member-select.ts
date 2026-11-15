import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';

/**
 * Release 0.6.0, workspace structure level 21 (OWNER-DB-ULTIMATE Part D, owner decision 0b, 2026-11-14): the workspace-schema
 * copy of `core.staff_profile`'s `staff_profile_member_select` (WorkspaceMemberRoles1786714500000). A custom workspace-member
 * role of THIS workspace that grants `staff.view` lets its active member SELECT the workspace's staff rows; nothing else
 * changes. `core.member_holds_workspace_permission` is the existing SECURITY INVOKER helper (EXECUTE already granted to the
 * runtime), so the policy never widens what the caller's own RLS on the membership / role tables lets them read. System
 * roles (Venue Managers, Staff) never satisfy it (`r.is_system = false`), and a role of another workspace never does
 * (`r.workspace_id = p_workspace`). Field-level hiding (money, contact data) stays in the service layer
 * (MemberAccessPolicyService projection; role writes refuse revealing a field the editor lacks the authority for).
 *
 * FROZEN (owner-reviewed SQL, docs/plans/phase-x3/WS-COMMANDS.md "FOR OWNER REVIEW — 0b release"): never edited after merge.
 * The same text is folded into core.provision_workspace by WorkspaceStaffMemberSelect1786721480000, so new workspaces are built
 * at level 21 and an existing one is brought to it by the workspace command runner; both must equal the declared fingerprints.
 *
 * Idempotent (D-RUNNER.md §4): the policy is created only when the table has no policy of that name. A policy of that name
 * with any other definition is left as it is and the post-step fingerprint check refuses the workspace (fail closed).
 * Additive only (no DROP), so `mayDrop` is not declared. Twenty has no equivalent (its permissions are not RLS policies).
 */
export const STAFF_PROFILE_MEMBER_SELECT_TIMESTAMP = 1786721480000;

/** The owner-approved policy statement, for one validated `workspace_<32 hex>` schema. */
export function staffProfileMemberSelectPolicySql(schemaName: string): string {
  // sql-injection-reviewed: schemaName is the runner-derived, regex-validated `workspace_<32 hex>` name; the rest is frozen text.
  return `CREATE POLICY staff_profile_member_select ON ${schemaName}.staff_profile AS PERMISSIVE FOR SELECT TO PUBLIC
    USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace()
           AND core.member_holds_workspace_permission(workspace_id, 'staff.view'))`;
}

/** The command body: the policy, guarded so a re-run (a crash after COMMIT) changes nothing. */
export function staffProfileMemberSelectSql(schemaName: string): string {
  // sql-injection-reviewed: schemaName is the runner-derived, regex-validated `workspace_<32 hex>` name; the rest is frozen text.
  return `DO $member_select$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
                  WHERE p.polrelid = '${schemaName}.staff_profile'::pg_catalog.regclass
                    AND p.polname = 'staff_profile_member_select') THEN
    ${staffProfileMemberSelectPolicySql(schemaName)};
  END IF;
END
$member_select$`;
}

/**
 * Expected `core.workspace_schema_fingerprint_v2` of a level-21 workspace, per PostgreSQL major (fingerprint v2, D-RUNNER.md
 * §9.1: every level above 20 is declared and compared with v2). Asserted by ws-staff-member-select.integration.spec.ts: a
 * workspace upgraded by the runner, one built by the TypeScript provisioner and one built by core.provision_workspace must all
 * equal it.
 *   16: generated 2026-11-14 on a throwaway postgres:16 owner-login ci-db (two frozen-template workspaces + this command, both
 *       equal; then reproduced by the runner, the TypeScript provisioner and core.provision_workspace).
 *   17 / 18: generated 2026-11-14 the same way on throwaway postgres:17-alpine / postgres:18-alpine clusters (InstaBox worker).
 */
export const STAFF_PROFILE_MEMBER_SELECT_FINGERPRINTS_V2: Readonly<Partial<Record<16 | 17 | 18, string>>> = Object.freeze({
  16: 'c08328e05b67e7b36511c80583ae97f1d3ff61a34017d9bc4574119d729e23e5',
  17: '32186b1cae783c4af34401a5b1937fcfb9bcea6d5d4b2c0a282853328c8e8a21',
  18: 'd52951bc8ef20f4aaec8d29052181e3fe2ad211e1454d8e5a368914461e35e31',
});

export const STAFF_PROFILE_MEMBER_SELECT_PROVISION_LITERAL = 'db:provision_workspace@WorkspaceStaffMemberSelect1786721480000';

export const STAFF_PROFILE_MEMBER_SELECT: WorkspaceUpgradeCommand = Object.freeze({
  kind: 'workspace',
  name: 'StaffProfileMemberSelect',
  timestamp: STAFF_PROFILE_MEMBER_SELECT_TIMESTAMP,
  sql: staffProfileMemberSelectSql,
  structure: Object.freeze({
    level: 21,
    fingerprints: STAFF_PROFILE_MEMBER_SELECT_FINGERPRINTS_V2,
    provisionFunctionLiteral: STAFF_PROFILE_MEMBER_SELECT_PROVISION_LITERAL,
  }),
});
