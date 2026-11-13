/**
 * OWNER-DB-ULTIMATE Part B3: the upgrade commands per release, keyed `<major>-<minor>` (Twenty
 * `upgrade-command-registry.service.ts:148-158` sorts each bundle by timestamp). A release with no folder has no commands.
 * Append a folder per release; never edit a published release's list.
 */
import type { UpgradeCommand } from './upgrade-command';
import { UPGRADE_COMMANDS_0_6 } from './0-6';

export const UPGRADE_COMMANDS: Readonly<Record<string, readonly UpgradeCommand[]>> = Object.freeze({
  '0-6': UPGRADE_COMMANDS_0_6,
});
