/**
 * OWNER-DB-ULTIMATE Part B3 / Part D: the upgrade commands per release, keyed `<major>-<minor>` (Twenty
 * `upgrade-command-registry.service.ts:148-158` sorts each bundle by timestamp; a bundle holds instance AND workspace commands,
 * `:135-158`). A release with no folder has no commands. Append a folder per release; never edit a published release's list.
 */
import type { UpgradeCommand } from './upgrade-command';
import type { WorkspaceUpgradeCommand } from './workspace-upgrade-command';
import { UPGRADE_COMMANDS_0_6, WORKSPACE_UPGRADE_COMMANDS_0_6 } from './0-6';

export const UPGRADE_COMMANDS: Readonly<Record<string, readonly UpgradeCommand[]>> = Object.freeze({
  '0-6': UPGRADE_COMMANDS_0_6,
});

/** Part D: the workspace commands per release, run per workspace after that release's instance commands. */
export const WORKSPACE_UPGRADE_COMMANDS: Readonly<Record<string, readonly WorkspaceUpgradeCommand[]>> = Object.freeze({
  '0-6': WORKSPACE_UPGRADE_COMMANDS_0_6,
});
