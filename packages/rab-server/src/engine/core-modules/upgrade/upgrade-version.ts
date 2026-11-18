/**
 * OWNER-DB-ULTIMATE Part B3: the release version, Twenty's model. Twenty: `APP_VERSION` + `TWENTY_PREVIOUS_VERSIONS`, and the
 * versions an upgrade is supported from, `TWENTY_CROSS_UPGRADE_SUPPORTED_VERSIONS` = the previous versions plus the current one
 * (twentyhq/twenty @ eedb0a73 `engine/core-modules/upgrade/constants/twenty-cross-upgrade-supported-version.constant.ts`,
 * read by `upgrade-command-registry.service.ts:166-205`). Re-implemented, not copied.
 *
 * The version is `MAJOR.MINOR.PATCH`, one per release, from the root `package.json` and baked into the image as
 * `CREWFLOW_APP_VERSION` (Dockerfile ARG → ENV). R254 = 0.4.0, R256 = 0.5.0, the first release with the logbook = 0.6.0.
 *
 * Patch releases (owner decision 2026-11-18): a patch carries no command and resumes its minor .0's incomplete instance
 * commands under the .0's own step names. ORDER INVARIANT (review R1 of #240): those commands run BEFORE any migration of
 * the patch's start, on the .0's schema (its migrations step completed), never after the patch's own migrations; otherwise
 * the start refuses (65, nothing applied) unless --force. Exceptions (after every migration): a start with no instance row
 * (fresh install / unchecked local history) and that --force start. Implemented in upgrade-runner.ts.
 *
 * Pure apart from readAppVersion's file read; no side effects on import.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CREWFLOW_APP_VERSION_VAR = 'CREWFLOW_APP_VERSION';

/** Strict MAJOR.MINOR.PATCH without leading zeros (the same rule as the table's CHECK). */
export const VERSION_PATTERN = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;

/**
 * Every published version before the current code's, oldest first (Twenty TWENTY_PREVIOUS_VERSIONS). Append only, strictly
 * ascending, no duplicate (assertPreviousVersions; checked by every start decision). A backport patch on an OLDER line (say
 * 0.6.2 after 0.7.0) is never appended on main: it is built from that line's own branch, whose list ends at its own line.
 */
export const CREWFLOW_PREVIOUS_VERSIONS: readonly string[] = Object.freeze(['0.4.0', '0.5.0']);

/**
 * The versions each MINOR release (`M.m.0`) upgrades FROM: an explicit list, reviewed with that release (owner decision
 * 2026-11-18; Twenty keeps the same kind of explicit list as TWENTY_PREVIOUS_VERSIONS and derives
 * TWENTY_CROSS_UPGRADE_SUPPORTED_VERSIONS from it). Rules (assertUpgradeFromList; AppVersionError = config, exit 64):
 *   - every MINOR code version needs an entry; a missing one refuses every start (fail closed, like an unbumped version);
 *   - each entry is a published version (in CREWFLOW_PREVIOUS_VERSIONS), older than the release, strictly ascending;
 *   - the adoption release 0.6.0 lists exactly its two adoptable histories (R254 = 0.4.0, R256 = 0.5.0);
 *   - any other release lists only versions of the PREVIOUS minor line (e.g. 0.7.0: 0.6.0, 0.6.1, 0.6.2): a release runs only
 *     its own instance commands, so an upgrade from an older line would skip that line's commands. Patches carry no
 *     commands (upgrade-sequence.ts), so every published version of the previous line is safe to list;
 *   - a key is a minor release (`M.m.0`); a patch release has no entry (upgradeFromVersions: its own minor line).
 * Append the next release's entry in its release PR, together with the version bump and CREWFLOW_PREVIOUS_VERSIONS; never
 * edit a published release's entry.
 */
export const CREWFLOW_UPGRADE_FROM_VERSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '0.6.0': Object.freeze(['0.4.0', '0.5.0']),
});

export type UpgradeFromVersions = Readonly<Record<string, readonly string[]>>;

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

/**
 * Security review L-2: the published list must be valid versions, strictly ascending, with no duplicate. The upgrade-from
 * rules read its LAST entry (a minor release's list must stay on that entry's line) and, for a patch, the entries of its own
 * line; an out-of-order entry (a backport patch appended after a newer minor) would make either read the wrong version.
 * Throws AppVersionError (config, 64).
 */
export function assertPreviousVersions(previous: readonly string[]): void {
  for (let i = 0; i < previous.length; i += 1) {
    parseVersion(previous[i]!);
    if (i > 0 && compareVersions(previous[i - 1]!, previous[i]!) >= 0) {
      throw new AppVersionError(
        `CREWFLOW_PREVIOUS_VERSIONS must be strictly ascending with no duplicate: ${previous[i - 1]} is followed by ${previous[i]}. Refusing.`,
      );
    }
  }
}

/** `<major>-<minor>`: the upgrade-commands folder of a version (Twenty `upgrade-version-command/<major-minor>/`). */
export function majorMinorKey(version: string): string {
  const v = parseVersion(version);
  return `${v.major}-${v.minor}`;
}

/**
 * A PATCH release (PATCH > 0, e.g. 0.6.1). Upgrade commands are per minor release and belong to its `.0` (Twenty: the
 * commands live in `upgrade-version-command/<major-minor>/` and a patch runs none): a patch release carries NO upgrade
 * command, NO workspace command and NO structure level. Throws AppVersionError on anything that is not MAJOR.MINOR.PATCH.
 */
export function isPatchRelease(version: string): boolean {
  return parseVersion(version).patch > 0;
}

/** The minor release a version belongs to (`M.m.0`): the one release of that line that owns the `M-m` command bundle. */
export function minorReleaseOf(version: string): string {
  const v = parseVersion(version);
  return `${v.major}.${v.minor}.0`;
}

/**
 * Fail closed (config, 64): the reviewed upgrade-from list of the MINOR release `codeVersion` (see
 * CREWFLOW_UPGRADE_FROM_VERSIONS). Returns the list. Pure.
 */
export function assertUpgradeFromList(codeVersion: string, list: readonly string[] | undefined, previous: readonly string[]): readonly string[] {
  const where = `CREWFLOW_UPGRADE_FROM_VERSIONS['${codeVersion}']`;
  if (!Array.isArray(list) || list.length === 0) {
    throw new AppVersionError(`${where} is missing: every minor release lists the versions it upgrades from (an explicit, reviewed list). Refusing.`);
  }
  for (let i = 0; i < list.length; i += 1) {
    const v = list[i]!;
    parseVersion(v);
    if (i > 0 && compareVersions(list[i - 1]!, v) >= 0) throw new AppVersionError(`${where} must be strictly ascending with no duplicate: ${list[i - 1]} is followed by ${v}. Refusing.`);
    if (compareVersions(v, codeVersion) >= 0) throw new AppVersionError(`${where} lists ${v}, which is not older than ${codeVersion}. Refusing.`);
    if (!previous.includes(v)) throw new AppVersionError(`${where} lists ${v}, which is not a published version (CREWFLOW_PREVIOUS_VERSIONS). Refusing.`);
  }
  if (codeVersion === ADOPTION_RELEASE_VERSION) {
    const adoptable = [...Object.values(ADOPTION_VERSION_BY_RELEASE)].sort(compareVersions);
    if (list.join(',') !== adoptable.join(',')) {
      throw new AppVersionError(`${where} must be exactly the adoptable histories ${adoptable.join(', ')} (the adoption release). Refusing.`);
    }
    return list;
  }
  const last = previous[previous.length - 1];
  const line = last ? minorReleaseOf(last) : null;
  for (const v of list) {
    if (minorReleaseOf(v) !== line) {
      throw new AppVersionError(
        `${where} lists ${v}, which is not on the previous minor line (${line ?? 'none'}): ${codeVersion} runs only its own commands, so an upgrade from ${v} would skip the commands of the releases in between. Refusing.`,
      );
    }
  }
  return list;
}

/**
 * The versions the code may upgrade FROM (B3).
 *
 * A MINOR release (`M.m.0`, the adoption release 0.6.0 included) accepts exactly the versions on its reviewed list in
 * CREWFLOW_UPGRADE_FROM_VERSIONS (owner decision 2026-11-18: 0.7.0 upgrades from any published 0.6.x it lists; this replaces
 * the earlier "only the last CREWFLOW_PREVIOUS_VERSIONS entry" rule). A missing or invalid list refuses (AppVersionError, 64).
 *
 * A patch release M.m.p (p > 0) has no step of its own beyond its migrations step, so it accepts every EARLIER published
 * version of its own minor line (M.m.0 … M.m.(p-1)); with an append-only list that set already holds the last entry. It
 * never accepts another minor line: the minor release's own commands (and, for 0.6.x, the adoption) run only on the `.0`,
 * so a jump from the previous minor straight to a patch would skip them. Fail closed: a patch whose `.0` is not a
 * published previous version refuses (AppVersionError, config 64), like an unbumped version.
 */
export function upgradeFromVersions(
  codeVersion: string,
  previous: readonly string[] = CREWFLOW_PREVIOUS_VERSIONS,
  upgradeFrom: UpgradeFromVersions = CREWFLOW_UPGRADE_FROM_VERSIONS,
): string[] {
  if (isPatchRelease(codeVersion)) {
    const line = minorReleaseOf(codeVersion);
    if (!previous.includes(line)) {
      throw new AppVersionError(
        `the patch release ${codeVersion} needs its minor release ${line} in CREWFLOW_PREVIOUS_VERSIONS (a patch upgrades only from its own minor line). Refusing.`,
      );
    }
    return previous.filter((v) => minorReleaseOf(v) === line && compareVersions(v, codeVersion) < 0);
  }
  const own = Object.prototype.hasOwnProperty.call(upgradeFrom, codeVersion) ? upgradeFrom[codeVersion] : undefined;
  return [...assertUpgradeFromList(codeVersion, own, previous)];
}

/**
 * Twenty TWENTY_CROSS_UPGRADE_SUPPORTED_VERSIONS: the versions an upgrade to `codeVersion` is supported from, plus the code
 * version itself (a resumed or repeated start). Pure; throws as upgradeFromVersions.
 */
export function crossUpgradeSupportedVersions(
  codeVersion: string,
  previous: readonly string[] = CREWFLOW_PREVIOUS_VERSIONS,
  upgradeFrom: UpgradeFromVersions = CREWFLOW_UPGRADE_FROM_VERSIONS,
): string[] {
  return [...upgradeFromVersions(codeVersion, previous, upgradeFrom), codeVersion];
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
