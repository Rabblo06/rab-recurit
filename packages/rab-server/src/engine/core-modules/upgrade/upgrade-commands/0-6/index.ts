import type { UpgradeCommand } from '../upgrade-command';
import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';
import { STAFF_PROFILE_MEMBER_SELECT } from './staff-profile-member-select';

/** Release 0.6.0's upgrade commands (none yet). Keep them ordered by timestamp. */
export const UPGRADE_COMMANDS_0_6: readonly UpgradeCommand[] = Object.freeze([]);

/**
 * Release 0.6.0's WORKSPACE upgrade commands (OWNER-DB-ULTIMATE Part D). 0.6.0 is also the release that adopts the existing
 * workspace-module history (every READY workspace at module 20 gets one is_initial row at the release's last INSTANCE step,
 * D-RUNNER.md §5), so every command below still runs for an adopted workspace; a workspace created on this code starts at
 * the release's last step and is built from the level-21 template instead.
 *   - level 21: StaffProfileMemberSelect (owner decision 0b, 2026-11-14).
 */
export const WORKSPACE_UPGRADE_COMMANDS_0_6: readonly WorkspaceUpgradeCommand[] = Object.freeze([STAFF_PROFILE_MEMBER_SELECT]);
