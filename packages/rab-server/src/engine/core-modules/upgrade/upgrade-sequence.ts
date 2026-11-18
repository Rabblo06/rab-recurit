/**
 * OWNER-DB-ULTIMATE Part B3 / Part D: the steps of a version, in order: its migrations step, then its (instance) upgrade
 * commands by timestamp, then its WORKSPACE upgrade commands by timestamp (Twenty `upgrade-sequence-reader.service.ts:39-60`:
 * fast-instance, slow-instance, then workspace commands per version).
 * "Version X is complete" (Part B3, extended by Part D like Twenty `run-instance-commands.command.ts:124-168`): the last
 * INSTANCE step of X has a completed latest attempt, and, when X has workspace commands, every provisioned workspace's latest
 * attempt of X's last workspace command is completed. Step names follow Twenty's `<version>_<Class>_<timestamp>`
 * (`upgrade-command-registry.service.ts:209-215`); the TypeORM migrations of a version are one step,
 * `<version>_TypeOrmMigrations`. A patch release (e.g. 0.6.1) has that one step only: commands belong to the minor release.
 * Pure.
 */
import type { UpgradeCommand } from './upgrade-commands/upgrade-command';
import type { WorkspaceUpgradeCommand } from './upgrade-commands/workspace-upgrade-command';
import { UPGRADE_COMMANDS, WORKSPACE_UPGRADE_COMMANDS } from './upgrade-commands/registry';
import { assertRegistryKeys } from './upgrade-registry-key';
import { compareVersions, isPatchRelease, majorMinorKey, minorReleaseOf, parseVersion } from './upgrade-version';

export const MIGRATIONS_STEP = 'TypeOrmMigrations';
export const STEP_NAME_PATTERN = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})_[A-Za-z][A-Za-z0-9]{0,150}(_[0-9]{13})?$/;

export type InstanceRegistry = Readonly<Record<string, readonly UpgradeCommand[]>>;
export type WorkspaceRegistry = Readonly<Record<string, readonly WorkspaceUpgradeCommand[]>>;

export function migrationsStepName(version: string): string {
  parseVersion(version);
  return `${version}_${MIGRATIONS_STEP}`;
}

export function commandStepName(version: string, command: Pick<UpgradeCommand, 'name' | 'timestamp'>): string {
  parseVersion(version);
  if (!/^[A-Za-z][A-Za-z0-9]{0,150}$/.test(command.name) || !/^[0-9]{13}$/.test(String(command.timestamp))) {
    throw new Error(`upgrade command ${JSON.stringify(command.name)}: bad name or timestamp`);
  }
  return `${version}_${command.name}_${command.timestamp}`;
}

/**
 * The `M-m` bundle a version owns. Only the minor release `M.m.0` owns it: a PATCH release (`M.m.p`, p > 0) owns nothing, so
 * it never re-lists its minor's commands under its own prefix (re-listed structural commands would claim levels already
 * taken and every start would refuse). The registry keys are checked first (upgrade-registry-key.ts, typed errors), and the
 * version's shape too (AppVersionError).
 */
function bundleOf<T>(version: string, registry: Readonly<Record<string, readonly T[]>>): readonly T[] {
  assertRegistryKeys(registry);
  if (isPatchRelease(version)) return [];
  return registry[majorMinorKey(version)] ?? [];
}

export function commandsForVersion(version: string, registry: InstanceRegistry = UPGRADE_COMMANDS): UpgradeCommand[] {
  return [...bundleOf(version, registry)].sort((a, b) => a.timestamp - b.timestamp);
}

/** Part D: the workspace commands of a version, by timestamp (none for a patch release). */
export function workspaceCommandsForVersion(version: string, registry: WorkspaceRegistry = WORKSPACE_UPGRADE_COMMANDS): WorkspaceUpgradeCommand[] {
  return [...bundleOf(version, registry)].sort((a, b) => a.timestamp - b.timestamp);
}

/** The instance steps of a version (Part B): migrations, then the instance commands. */
export function instanceStepsForVersion(version: string, registry: InstanceRegistry = UPGRADE_COMMANDS): string[] {
  return [migrationsStepName(version), ...commandsForVersion(version, registry).map((c) => commandStepName(version, c))];
}

/**
 * The versions whose INSTANCE steps one start of `version` runs, in sequence order: a minor release only its own; a PATCH
 * release first its minor `.0`'s (owner decision 2026-11-18: any `.0` instance step whose latest attempt is not completed is
 * re-run under the `.0`'s own step name, recorded with executed_by_version = the patch; Twenty upgrade-sequence-runner
 * .service.ts:98-247 resumes from the failed step), then its own migrations step. Pure.
 */
export function instanceVersionsOfStart(version: string): string[] {
  return isPatchRelease(version) ? [minorReleaseOf(version), version] : [version];
}

/** Every instance step one start of `version` runs, in order (instanceVersionsOfStart): what /healthz reads for the app version. */
export function instanceStepsOfStart(version: string, registry: InstanceRegistry = UPGRADE_COMMANDS): string[] {
  return instanceVersionsOfStart(version).flatMap((v) => instanceStepsForVersion(v, registry));
}

/** Every step of a version: the instance steps, then the workspace commands (Part D). */
export function stepsForVersion(version: string, registry: InstanceRegistry = UPGRADE_COMMANDS, workspaceRegistry: WorkspaceRegistry = WORKSPACE_UPGRADE_COMMANDS): string[] {
  return [...instanceStepsForVersion(version, registry), ...workspaceCommandsForVersion(version, workspaceRegistry).map((c) => commandStepName(version, c))];
}

/** The last step of a version (instance or workspace): the cursor a NEW workspace starts at (Twenty getInitialCursorForNewWorkspace). */
export function lastStepOfVersion(version: string, registry: InstanceRegistry = UPGRADE_COMMANDS, workspaceRegistry: WorkspaceRegistry = WORKSPACE_UPGRADE_COMMANDS): string {
  const steps = stepsForVersion(version, registry, workspaceRegistry);
  return steps[steps.length - 1]!;
}

/** The last INSTANCE step of a version: what Part B's instance-level "complete" reads. */
export function lastInstanceStepOfVersion(version: string, registry: InstanceRegistry = UPGRADE_COMMANDS): string {
  const steps = instanceStepsForVersion(version, registry);
  return steps[steps.length - 1]!;
}

/** The last workspace step of a version, or null when it has no workspace command (Twenty getLastWorkspaceCommandForVersion). */
export function lastWorkspaceStepOfVersion(version: string, workspaceRegistry: WorkspaceRegistry = WORKSPACE_UPGRADE_COMMANDS): string | null {
  const commands = workspaceCommandsForVersion(version, workspaceRegistry);
  const last = commands[commands.length - 1];
  return last ? commandStepName(version, last) : null;
}

export interface SequenceStep {
  name: string;
  version: string;
  kind: 'instance' | 'workspace';
  /** Set for workspace steps. */
  command?: WorkspaceUpgradeCommand;
}

/** The full sequence over the given versions (sorted ascending, de-duplicated): Twenty getUpgradeSequence. */
export function sequenceForVersions(versions: readonly string[], registry: InstanceRegistry = UPGRADE_COMMANDS, workspaceRegistry: WorkspaceRegistry = WORKSPACE_UPGRADE_COMMANDS): SequenceStep[] {
  const sorted = [...new Set(versions)].sort(compareVersions);
  const out: SequenceStep[] = [];
  for (const version of sorted) {
    for (const name of instanceStepsForVersion(version, registry)) out.push({ name, version, kind: 'instance' });
    for (const command of workspaceCommandsForVersion(version, workspaceRegistry)) out.push({ name: commandStepName(version, command), version, kind: 'workspace', command });
  }
  const seen = new Set<string>();
  for (const s of out) {
    if (seen.has(s.name)) throw new Error(`upgrade sequence: duplicate step name ${s.name}`);
    seen.add(s.name);
  }
  return out;
}

/** The version prefix of a step name (null when the name is not a step name). */
export function versionOfStep(name: string): string | null {
  return STEP_NAME_PATTERN.test(name) ? name.slice(0, name.indexOf('_')) : null;
}
