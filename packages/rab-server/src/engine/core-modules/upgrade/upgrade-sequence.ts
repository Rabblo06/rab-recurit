/**
 * OWNER-DB-ULTIMATE Part B3: the steps of a version, in order: its migrations step, then its upgrade commands by timestamp.
 * "Version X is complete" = the LAST step of X has a completed latest attempt (Twenty `upgrade-migration.service.ts:33-49`
 * isLastAttemptCompleted; there is no separate version-recorded row). Step names follow Twenty's
 * `<version>_<Class>_<timestamp>` (`upgrade-command-registry.service.ts:209-215`); the TypeORM migrations of a version are
 * one step, `<version>_TypeOrmMigrations`. Pure.
 */
import type { UpgradeCommand } from './upgrade-commands/upgrade-command';
import { UPGRADE_COMMANDS } from './upgrade-commands/registry';
import { majorMinorKey, parseVersion } from './upgrade-version';

export const MIGRATIONS_STEP = 'TypeOrmMigrations';
export const STEP_NAME_PATTERN = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})_[A-Za-z][A-Za-z0-9]{0,150}(_[0-9]{13})?$/;

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

export function commandsForVersion(version: string, registry: Readonly<Record<string, readonly UpgradeCommand[]>> = UPGRADE_COMMANDS): UpgradeCommand[] {
  return [...(registry[majorMinorKey(version)] ?? [])].sort((a, b) => a.timestamp - b.timestamp);
}

export function stepsForVersion(version: string, registry: Readonly<Record<string, readonly UpgradeCommand[]>> = UPGRADE_COMMANDS): string[] {
  return [migrationsStepName(version), ...commandsForVersion(version, registry).map((c) => commandStepName(version, c))];
}

export function lastStepOfVersion(version: string, registry: Readonly<Record<string, readonly UpgradeCommand[]>> = UPGRADE_COMMANDS): string {
  const steps = stepsForVersion(version, registry);
  return steps[steps.length - 1]!;
}

/** The version prefix of a step name (null when the name is not a step name). */
export function versionOfStep(name: string): string | null {
  return STEP_NAME_PATTERN.test(name) ? name.slice(0, name.indexOf('_')) : null;
}
