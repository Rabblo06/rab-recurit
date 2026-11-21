import type { UpgradeCommand } from '../upgrade-command';
import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';
import { ATTENDANCE_CORRECTION_INSERT_ONLY } from './attendance-correction-insert-only';
import { ATTENDANCE_STAFF_SCOPE } from './attendance-staff-scope';
import { createHwsCutoverCommand } from './hws-cutover';
import { STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE } from './staff-profile-shift-team-multi-role';
import { STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE } from './staff-profile-workspace-required-validate';

/**
 * Release 0.7.0's upgrade commands (OWNER-DB-ULTIMATE Part C3). Registered in ../registry.ts by the 0.7.0 release PR
 * ("switch C3 on"; owner decision 2026-11-15: C3 ships in its own release, Q8), together with the root package.json version
 * 0.7.0, CREWFLOW_PREVIOUS_VERSIONS + 0.6.0 and HWS_RUNTIME_ENABLED=true in the production compose files. The command's SQL
 * (migration HwsCutoverCopyFunctions1786721540000) was approved by the owner 2026-11-15 (SQL-DRAFTS.md §6).
 */
export const UPGRADE_COMMANDS_0_7: readonly UpgradeCommand[] = Object.freeze([createHwsCutoverCommand()]);

/**
 * Release 0.7.0's workspace commands, run per workspace AFTER the release's instance commands (so after the HwsCutover copy):
 *   - level 23: ValidateStaffProfileWorkspaceRequired (C3 owner decision Q3; DRAFT SQL, owner review first);
 *   - level 24: ShiftTeamSelectMultiRole (#205: the staff Teams list for a multi-role staff user; DRAFT SQL, owner review first);
 *   - level 25: AttendanceStaffScope (M4 §11 LOW: staff-own-or-manager predicate on attendance; DRAFT SQL, owner review first);
 *   - level 26: AttendanceCorrectionInsertOnly (S11: attendance_correction insert-only in the database; DRAFT SQL, owner review first).
 * The cutover itself writes core rows, so it is an instance command, not one of these.
 */
export const WORKSPACE_UPGRADE_COMMANDS_0_7: readonly WorkspaceUpgradeCommand[] = Object.freeze([
  STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE,
  STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE,
  ATTENDANCE_STAFF_SCOPE,
  ATTENDANCE_CORRECTION_INSERT_ONLY,
]);
