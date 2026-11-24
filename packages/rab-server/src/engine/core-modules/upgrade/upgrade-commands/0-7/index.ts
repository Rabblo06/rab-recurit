import type { UpgradeCommand } from '../upgrade-command';
import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';
import { ATTENDANCE_BREAKS_RECEIPTS } from './attendance-breaks-receipts';
import { ATTENDANCE_CORRECTION_INSERT_ONLY } from './attendance-correction-insert-only';
import { ATTENDANCE_STAFF_SCOPE } from './attendance-staff-scope';
import { createHwsCutoverCommand } from './hws-cutover';
import { STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE } from './staff-profile-shift-team-multi-role';
import { STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE } from './staff-profile-workspace-required-validate';

/**
 * Release 0.7.0's upgrade commands (OWNER-DB-ULTIMATE Part C3). Registered in ../registry.ts by the 0.7.0 release PR
 * ("switch C3 on"; owner decision 2026-11-15: C3 ships in its own release, Q8), together with the root package.json version
 * 0.7.0, CREWFLOW_PREVIOUS_VERSIONS + 0.6.0 and the reviewed CREWFLOW_UPGRADE_FROM_VERSIONS['0.7.0'] entry (every published
 * 0.6.x, owner decision 2026-11-18: 0.6.0). HWS_RUNTIME_ENABLED stays "false" in the production compose files and flips to
 * "true" only in the deploy change that bumps the production digest to the published 0.7.0 image (security review M1). The
 * command's SQL (migration HwsCutoverCopyFunctions1786721540000) was approved by the owner 2026-11-15 (SQL-DRAFTS.md §6).
 */
export const UPGRADE_COMMANDS_0_7: readonly UpgradeCommand[] = Object.freeze([createHwsCutoverCommand()]);

/**
 * Release 0.7.0's workspace commands, run per workspace AFTER the release's instance commands (so after the HwsCutover copy):
 *   - level 23: ValidateStaffProfileWorkspaceRequired (C3 owner decision Q3; DRAFT SQL, owner review first);
 *   - level 24: ShiftTeamSelectMultiRole (#205: the staff Teams list for a multi-role staff user; DRAFT SQL, owner review first);
 *   - level 25: AttendanceStaffScope (M4 §11 LOW: staff-own-or-manager predicate on attendance; DRAFT SQL, owner review first);
 *   - level 26: AttendanceCorrectionInsertOnly (S11: attendance_correction insert-only in the database; DRAFT SQL, owner review first);
 *   - level 27: AttendanceBreaksReceipts (M4 design §13 PR 2: attendance_break + attendance_sync_receipt; DRAFT SQL, owner review
 *     first; "[after 0.7.0 cutover]", owner decision 44: moves to the 0-8 bucket when the lead opens 0.8.0).
 * The cutover itself writes core rows, so it is an instance command, not one of these.
 */
export const WORKSPACE_UPGRADE_COMMANDS_0_7: readonly WorkspaceUpgradeCommand[] = Object.freeze([
  STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE,
  STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE,
  ATTENDANCE_STAFF_SCOPE,
  ATTENDANCE_CORRECTION_INSERT_ONLY,
  ATTENDANCE_BREAKS_RECEIPTS,
]);
