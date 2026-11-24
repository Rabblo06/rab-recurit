import type { UpgradeCommand } from '../upgrade-command';
import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';
import { createHwsCutoverCommand } from './hws-cutover';

/**
 * Release 0.7.0's upgrade commands (OWNER-DB-ULTIMATE Part C3). Registered in ../registry.ts by the 0.7.0 release PR
 * ("switch C3 on"; owner decision 2026-11-15: C3 ships in its own release, Q8), together with the root package.json version
 * 0.7.0, CREWFLOW_PREVIOUS_VERSIONS + 0.6.0 and the reviewed CREWFLOW_UPGRADE_FROM_VERSIONS['0.7.0'] entry (every published
 * 0.6.x, owner decision 2026-11-18: 0.6.0). HWS_RUNTIME_ENABLED stays "false" in the production compose files and flips to
 * "true" only in the deploy change that bumps the production digest to the published 0.7.0 image (security review M1). The
 * command's SQL (migration HwsCutoverCopyFunctions1786721540000) was approved by the owner 2026-11-15 (SQL-DRAFTS.md §6).
 */
export const UPGRADE_COMMANDS_0_7: readonly UpgradeCommand[] = Object.freeze([createHwsCutoverCommand()]);

/** Release 0.7.0's workspace commands: none from C3 (the cutover writes core rows, so it is an instance command). */
export const WORKSPACE_UPGRADE_COMMANDS_0_7: readonly WorkspaceUpgradeCommand[] = Object.freeze([]);
