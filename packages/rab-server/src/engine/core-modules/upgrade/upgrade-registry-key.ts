/**
 * The keys of the upgrade-command registries (`UPGRADE_COMMANDS`, `WORKSPACE_UPGRADE_COMMANDS`): `<major>-<minor>`, one
 * bundle per MINOR release, owned by its `.0` (Twenty `upgrade-version-command/<major-minor>/`; re-implemented, not copied).
 *
 * A patch release (e.g. 0.6.1) carries NO upgrade command and NO structure level, so a registry can never hold a bundle for
 * one: a key naming a patch (`0-6-1`) is a PatchReleaseCommandsError, any other key shape an UpgradeRegistryError. Every
 * reader of a registry checks its keys first (upgrade-sequence.ts, workspace-structure-level.ts), so such a registry
 * refuses every start before anything is applied (migrate-on-start outcomeOf: config, exit 64). Pure: no imports.
 */

/** A registry key that is not `<major>-<minor>`. Mapped to `config` (exit 64) in migrate-on-start.ts outcomeOf. */
export class UpgradeRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeRegistryError';
  }
}

/** Upgrade commands registered for a PATCH release (never allowed). Mapped to `config` (exit 64) in outcomeOf. */
export class PatchReleaseCommandsError extends UpgradeRegistryError {
  constructor(message: string) {
    super(message);
    this.name = 'PatchReleaseCommandsError';
  }
}

const NUMBER = '(0|[1-9][0-9]{0,3})';
const MINOR_KEY = new RegExp(`^${NUMBER}-${NUMBER}$`);
const THREE_PART_KEY = new RegExp(`^${NUMBER}-${NUMBER}-${NUMBER}$`);

/** The minor release (`M.m.0`) a registry key names. A patch key or any other shape throws (typed). */
export function registryKeyRelease(key: string): string {
  const m = MINOR_KEY.exec(key);
  if (m) return `${m[1]}.${m[2]}.0`;
  const shown = JSON.stringify(String(key).slice(0, 40));
  const three = THREE_PART_KEY.exec(key);
  if (three && three[3] !== '0') {
    throw new PatchReleaseCommandsError(
      `upgrade registry key ${shown} names a patch release: a patch release carries no upgrade commands (they belong to ${three[1]}-${three[2]}, the minor release). Refusing.`,
    );
  }
  throw new UpgradeRegistryError(`upgrade registry key ${shown} is not <major>-<minor>. Refusing.`);
}

/** Every key of a registry must name a minor release (see registryKeyRelease). */
export function assertRegistryKeys(registry: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(registry)) registryKeyRelease(key);
}
