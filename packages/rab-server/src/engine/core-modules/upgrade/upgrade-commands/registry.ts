/**
 * OWNER-DB-ULTIMATE Part B3 / Part D: the upgrade commands per release, keyed `<major>-<minor>` (Twenty
 * `upgrade-command-registry.service.ts:148-158` sorts each bundle by timestamp; a bundle holds instance AND workspace commands,
 * `:135-158`). A release with no folder has no commands. Append a folder per release; never edit a published release's list.
 */
import type { UpgradeCommand } from './upgrade-command';
import type { WorkspaceUpgradeCommand } from './workspace-upgrade-command';
import { UPGRADE_COMMANDS_0_6, WORKSPACE_UPGRADE_COMMANDS_0_6 } from './0-6';
import { UPGRADE_COMMANDS_0_7, WORKSPACE_UPGRADE_COMMANDS_0_7 } from './0-7';

export const UPGRADE_COMMANDS: Readonly<Record<string, readonly UpgradeCommand[]>> = Object.freeze({
  '0-6': UPGRADE_COMMANDS_0_6,
  // Release 0.7.0 (owner decision 2026-11-15, Part C3 Q8): the HWS cutover copy step, switched on in its own release.
  '0-7': UPGRADE_COMMANDS_0_7,
});

/** Part D: the workspace commands per release, run per workspace after that release's instance commands. */
export const WORKSPACE_UPGRADE_COMMANDS: Readonly<Record<string, readonly WorkspaceUpgradeCommand[]>> = Object.freeze({
  '0-6': WORKSPACE_UPGRADE_COMMANDS_0_6,
  '0-7': WORKSPACE_UPGRADE_COMMANDS_0_7,
});
