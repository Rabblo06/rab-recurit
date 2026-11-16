import type { UpgradeCommand } from '../upgrade-command';
import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';
import { createHwsCutoverCommand } from './hws-cutover';

/**
 * Release 0.7.0's upgrade commands — PROVISIONAL (OWNER-DB-ULTIMATE Part C3). NOT registered in ../registry.ts yet: the
 * release that carries the HWS cutover, the version bump and the activation are the lead's / owner's call, after the owner
 * chooses A′ vs B′ and approves the SQL (SQL-DRAFTS.md "FOR OWNER REVIEW — C3"). Activation = one registry line
 * (`'0-7': UPGRADE_COMMANDS_0_7`) + the root package.json version + CREWFLOW_PREVIOUS_VERSIONS.
 */
export const UPGRADE_COMMANDS_0_7: readonly UpgradeCommand[] = Object.freeze([createHwsCutoverCommand()]);

/** Release 0.7.0's workspace commands: none from C3 (the cutover writes core rows, so it is an instance command). */
export const WORKSPACE_UPGRADE_COMMANDS_0_7: readonly WorkspaceUpgradeCommand[] = Object.freeze([]);
