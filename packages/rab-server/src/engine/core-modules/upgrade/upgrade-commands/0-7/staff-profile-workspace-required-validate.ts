import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';

/**
 * Release 0.7.0, workspace structure level 23 (OWNER-DB-ULTIMATE Part C3, owner decision Q3, 2026-11-15: "VALIDATE
 * staff_profile_workspace_required as the last step of a verified copy"). DRAFT — NEW SQL, owner SQL review FIRST
 * (docs/plans/phase-x3/SQL-DRAFTS.md §6.7 / the Q3 draft PR); never edited after merge once approved.
 *
 * Why a structural Part D command and not a step inside the cutover (SQL-DRAFTS §6.7): `validated=` is part of the workspace
 * fingerprint (workspace-schema-fingerprint.ts), so validating inside the instance cutover would move every cut-over
 * workspace off its structure level's declared fingerprint, and the runner would block it at its next structure check. As a
 * workspace command it is a structure level of its own: release 0.7.0 runs it per workspace AFTER the release's instance
 * commands (the HwsCutover copy, Twenty's order: instance steps, then workspace steps), in the same start, and
 * core.provision_workspace is re-created through level 23 (migration
 * WorkspaceStaffProfileWorkspaceRequiredValidated1786721570000) so new workspaces are built at the same structure.
 *
 * What it does: one `ALTER TABLE <schema>.staff_profile VALIDATE CONSTRAINT staff_profile_workspace_required`. The constraint
 * (`CHECK (workspace_id IS NOT NULL)`) comes NOT VALID from the frozen template (it mirrors core's
 * StaffProfileWorkspaceRequired1786676000000, where legacy rows predated it). A NOT VALID CHECK is still enforced on every
 * INSERT / UPDATE; VALIDATE only scans the rows already there once and flips `convalidated`.
 *   - It cannot change data, drops nothing (`mayDrop` unset) and is idempotent: validating a valid constraint is a no-op.
 *   - Lock: SHARE UPDATE EXCLUSIVE on this workspace's staff_profile only (reads and writes continue), one sequential scan.
 *   - Fail closed: the validation scan reads every row WITHOUT row-level security, so a row with workspace_id NULL makes it
 *     fail (23514); the runner rolls the step back, records it failed and blocks the workspace (503) — never served at a level
 *     it did not reach. No row can violate it in practice: `staff_profile_workspace_bound` (validated since the template)
 *     already requires `workspace_id IS NOT NULL AND workspace_id = <this workspace>`. A data pre-check is deliberately not
 *     declared: it would run under FORCE RLS bound to this workspace and could never see a NULL workspace_id row.
 * Twenty has no equivalent (no RLS, no NOT VALID legacy constraints in workspace schemas): a Crewflow addition.
 */
export const STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE_TIMESTAMP = 1786721570000;

export const STAFF_PROFILE_WORKSPACE_REQUIRED_CONSTRAINT = 'staff_profile_workspace_required';

/** The command body for one validated `workspace_<32 hex>` schema. */
export function staffProfileWorkspaceRequiredValidateSql(schemaName: string): string {
  // sql-injection-reviewed: schemaName is the runner-derived, regex-validated `workspace_<32 hex>` name; the rest is frozen text.
  return `ALTER TABLE ${schemaName}.staff_profile VALIDATE CONSTRAINT ${STAFF_PROFILE_WORKSPACE_REQUIRED_CONSTRAINT}`;
}

/**
 * Expected `core.workspace_schema_fingerprint_v2` of a level-23 workspace per PostgreSQL major. Measured (not derived): a
 * level-22 workspace + this command, a workspace built by the TypeScript provisioner and one built by the level-23
 * core.provision_workspace must all equal it (ws-staff-profile-workspace-required.integration.spec.ts; GitHub CI's
 * `owner-login (<major>, fingerprints)` jobs for 16 / 17 / 18). An undeclared major makes
 * WorkspaceStaffProfileWorkspaceRequiredValidated1786721570000 refuse (exit 66): fail closed.
 */
export const STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE_FINGERPRINTS_V2: Readonly<Partial<Record<16 | 17 | 18, string>>> = Object.freeze({
  16: '8e71e2e04feb6d84f335e037baded18c20e36a7b429dff30df969499ea503143',
  17: '699f304205a2d969ab8045394172f3f23b2ba289b015b2ce62914291c8462793',
  18: '2c34f05380590f559c432c27bb93a694aedcab6432c221f359c67e851bd06371',
});

export const STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE_PROVISION_LITERAL = 'db:provision_workspace@WorkspaceStaffProfileWorkspaceRequiredValidated1786721570000';

export const STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE: WorkspaceUpgradeCommand = Object.freeze({
  kind: 'workspace',
  name: 'ValidateStaffProfileWorkspaceRequired',
  timestamp: STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE_TIMESTAMP,
  sql: staffProfileWorkspaceRequiredValidateSql,
  structure: Object.freeze({
    level: 23,
    fingerprints: STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE_FINGERPRINTS_V2,
    provisionFunctionLiteral: STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE_PROVISION_LITERAL,
  }),
});
