/**
 * OWNER-DB-ULTIMATE Part B3: the release version, Twenty's model. Twenty: `APP_VERSION` + `TWENTY_PREVIOUS_VERSIONS`
 * (twentyhq/twenty @ eedb0a73 `database/commands/run-instance-commands.command.ts:142-143`: the previous version is the
 * last entry of the previous-versions list). Re-implemented, not copied.
 *
 * The version is `MAJOR.MINOR.PATCH`, one per release, from the root `package.json` and baked into the image as
 * `CREWFLOW_APP_VERSION` (Dockerfile ARG → ENV). R254 = 0.4.0, R256 = 0.5.0, the first release with the logbook = 0.6.0.
 *
 * Pure apart from readAppVersion's file read; no side effects on import.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CREWFLOW_APP_VERSION_VAR = 'CREWFLOW_APP_VERSION';

/** Strict MAJOR.MINOR.PATCH without leading zeros (the same rule as the table's CHECK). */
export const VERSION_PATTERN = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;

/** Every published version before the current code's, oldest first (Twenty TWENTY_PREVIOUS_VERSIONS). Append only. */
export const CREWFLOW_PREVIOUS_VERSIONS: readonly string[] = Object.freeze(['0.4.0', '0.5.0']);

/** The adoption release (B3): the one version that accepts an R254 or R256 history with no logbook rows. */
export const ADOPTION_RELEASE_VERSION = '0.6.0';

/** B3 adoption: the release manifest id (release-floor.ts) → the version its one is_initial row records. */
export const ADOPTION_VERSION_BY_RELEASE: Readonly<Record<string, string>> = Object.freeze({ R254: '0.4.0', R256: '0.5.0' });

export class AppVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppVersionError';
  }
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(value: string): ParsedVersion {
  const m = VERSION_PATTERN.exec(value);
  if (!m) throw new AppVersionError(`not a MAJOR.MINOR.PATCH version: ${JSON.stringify(value.slice(0, 40))}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

/** -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return 0;
}

/** `<major>-<minor>`: the upgrade-commands folder of a version (Twenty `upgrade-version-command/<major-minor>/`). */
export function majorMinorKey(version: string): string {
  const v = parseVersion(version);
  return `${v.major}-${v.minor}`;
}

/**
 * The versions the code may upgrade FROM (B3). 0.6.0 is the adoption release and accepts both R254 (0.4.0) and R256
 * (0.5.0); from 0.7.0 on, strict: only the immediately previous version (the last CREWFLOW_PREVIOUS_VERSIONS entry).
 */
export function upgradeFromVersions(codeVersion: string, previous: readonly string[] = CREWFLOW_PREVIOUS_VERSIONS): string[] {
  if (codeVersion === ADOPTION_RELEASE_VERSION) return previous.filter((v) => Object.values(ADOPTION_VERSION_BY_RELEASE).includes(v));
  const last = previous[previous.length - 1];
  return last ? [last] : [];
}

/** The workspace root package.json (the one with `workspaces`), walking up from `start`. */
function findRootPackageJson(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { workspaces?: unknown };
        if (parsed.workspaces !== undefined) return candidate;
      } catch {
        // not JSON: keep walking
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * The code's release version: `CREWFLOW_APP_VERSION` (baked into the image) when set, otherwise the root package.json
 * `version`. Anything that is not a strict MAJOR.MINOR.PATCH refuses (fail closed): the upgrade check cannot run on an
 * unknown version. Security review I3: a set CREWFLOW_APP_VERSION that differs from the root package.json shipped with
 * the code refuses too (a runtime override could otherwise claim another release and skip or fake the version check).
 */
export function readAppVersion(env: Record<string, string | undefined> = process.env, start: string = __dirname): string {
  const baked = env[CREWFLOW_APP_VERSION_VAR]?.trim();
  const file = findRootPackageJson(start);
  if (baked) {
    if (!isVersion(baked)) throw new AppVersionError(`${CREWFLOW_APP_VERSION_VAR} must be MAJOR.MINOR.PATCH (no leading zeros). Refusing.`);
    // Review R3: fail closed when the shipped package.json cannot be found (nothing to compare the override with).
    if (!file) throw new AppVersionError(`${CREWFLOW_APP_VERSION_VAR} is set but this code's root package.json was not found, so the value cannot be verified. Refusing.`);
    const shipped = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
    if (shipped !== baked) {
      throw new AppVersionError(`${CREWFLOW_APP_VERSION_VAR} (${baked}) differs from this code's release version (${String(shipped).slice(0, 20)}). Remove the override. Refusing.`);
    }
    return baked;
  }
  if (!file) throw new AppVersionError(`${CREWFLOW_APP_VERSION_VAR} is not set and the root package.json was not found. Refusing.`);
  const version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
  if (!isVersion(version)) throw new AppVersionError(`the root package.json version is not MAJOR.MINOR.PATCH. Refusing.`);
  return version;
}
