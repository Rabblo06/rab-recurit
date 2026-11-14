import type { UpgradeCommand } from '../upgrade-command';
import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';

/** Release 0.6.0's upgrade commands (none yet). Keep them ordered by timestamp. */
export const UPGRADE_COMMANDS_0_6: readonly UpgradeCommand[] = Object.freeze([]);

/**
 * Release 0.6.0's WORKSPACE upgrade commands (OWNER-DB-ULTIMATE Part D): none. 0.6.0 is the release that adopts the existing
 * workspace-module history (every READY workspace at module 20 gets one is_initial row; D-RUNNER.md §5).
 */
export const WORKSPACE_UPGRADE_COMMANDS_0_6: readonly WorkspaceUpgradeCommand[] = Object.freeze([]);
