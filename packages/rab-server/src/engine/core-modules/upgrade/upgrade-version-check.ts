/**
 * OWNER-DB-ULTIMATE Part B3: the previous-version check, Twenty's model (twentyhq/twenty @ eedb0a73
 * `database/commands/run-instance-commands.command.ts:124-168`, re-implemented, not copied):
 *   - `--force` skips ONLY this check (:127-133) and the run records forced = true;
 *   - a fresh install skips it (:135-140, "no provisioned workspace");
 *   - the previous version is the last TWENTY_PREVIOUS_VERSIONS entry (:142-143); 0.6.0, the adoption release, accepts
 *     0.4.0 (R254) and 0.5.0 (R256) (upgrade-version.ts upgradeFromVersions);
 *   - Twenty skips the check when there is nothing recorded (:145-152); Crewflow's analogue is the ONE-TIME adoption of an
 *     R254 / R256 history (B3): one is_initial row at 0.4.0 / 0.5.0, then the upgrade in the same start; only 0.6.0 adopts;
 *   - otherwise "version X is complete" (the last step of X has a completed latest attempt) must hold for an accepted
 *     previous version, or for the code's own version (a resumed or repeated start), else refuse (:154-167): exit 65,
 *     nothing applied.
 * Pure: the caller reads the facts on the locked session first.
 */
import type { LedgerAttribution } from '../../../database/typeorm/scripts/migrate/owner-login/release-floor';
import { ADOPTION_RELEASE_VERSION, ADOPTION_VERSION_BY_RELEASE, AppVersionError, compareVersions, CREWFLOW_PREVIOUS_VERSIONS, upgradeFromVersions } from './upgrade-version';
import { migrationsStepName } from './upgrade-sequence';

/** Refused by the previous-version check. Mapped to outcome `behind` (exit 65) in migrate-on-start.ts outcomeOf. */
export class UpgradeVersionTooOldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeVersionTooOldError';
  }
}

export interface UpgradeStartFacts {
  codeVersion: string;
  /** A proven fresh install (EMPTY / BOOTSTRAP-PARTIAL / fresh proof): no check, like Twenty :135-140. */
  fresh: boolean;
  /** Only from the manual `upgrade --force` command. */
  force: boolean;
  /** Whether core.upgrade_migration exists now (before this run's migrations). */
  ledgerExists: boolean;
  /** Whether it holds any instance row. */
  hasInstanceRows: boolean;
  /** version → "the last step of that version has a completed latest attempt", for every version asked about. */
  complete: Readonly<Record<string, boolean>>;
  /** Versions on instance rows that are newer than the code (an image rollback). */
  newerVersions: readonly string[];
  /** The release attribution of core.migrations (release-floor.ts attributeLedger), or null when not computed. */
  attribution: LedgerAttribution | null;
  /** Targets the release floor does not restrict (local / test): an unattributable history is allowed, unrecorded. */
  unrestrictedTarget: boolean;
  previousVersions?: readonly string[];
}

export type UpgradeStartDecision =
  | { kind: 'fresh'; reason: string }
  | { kind: 'adopt'; initialName: string; initialVersion: string; reason: string }
  | { kind: 'continue'; from: string; reason: string }
  | { kind: 'rollback'; newer: string[]; reason: string }
  | { kind: 'forced'; reason: string }
  | { kind: 'unchecked'; reason: string };

/** The versions whose completeness the decision needs (the caller reads exactly these). */
export function versionsToCheck(codeVersion: string, previous: readonly string[] = CREWFLOW_PREVIOUS_VERSIONS): string[] {
  return [...new Set([...upgradeFromVersions(codeVersion, previous), codeVersion])];
}

export function decideUpgradeStart(f: UpgradeStartFacts): UpgradeStartDecision {
  const previous = f.previousVersions ?? CREWFLOW_PREVIOUS_VERSIONS;
  const last = previous[previous.length - 1];
  if (last && compareVersions(f.codeVersion, last) <= 0) {
    throw new AppVersionError(
      `the code version ${f.codeVersion} is not newer than the last published version ${last}: the release version was not bumped. Refusing.`,
    );
  }
  if (f.newerVersions.length) {
    return { kind: 'rollback', newer: [...f.newerVersions], reason: `the logbook holds newer version(s) ${f.newerVersions.join(', ')} than this image (${f.codeVersion}): rollback, nothing recorded` };
  }
  if (f.fresh) return { kind: 'fresh', reason: 'fresh install: no previous-version check' };

  const from = upgradeFromVersions(f.codeVersion, previous);
  if (f.ledgerExists && f.hasInstanceRows) {
    const done = [...from, f.codeVersion].find((v) => f.complete[v] === true);
    if (done) return { kind: 'continue', from: done, reason: done === f.codeVersion ? `${done} is already complete` : `previous version ${done} is complete` };
    if (f.force) return { kind: 'forced', reason: `--force: the previous-version check is skipped (none of ${from.join(', ')} is complete)` };
    throw new UpgradeVersionTooOldError(
      `the database has not completed ${from.join(' or ')} (needed before ${f.codeVersion}). Upgrade through the missing release first, or run the manual command \`upgrade --force\` (not recommended). Nothing was applied.`,
    );
  }

  // No instance row yet: Twenty's "nothing recorded" case. Only the adoption release adopts (B3).
  const attribution = f.attribution;
  if (f.codeVersion === ADOPTION_RELEASE_VERSION && attribution?.kind === 'release') {
    const version = ADOPTION_VERSION_BY_RELEASE[attribution.release];
    if (version) {
      return {
        kind: 'adopt',
        initialName: migrationsStepName(version),
        initialVersion: version,
        reason: `adopting a ${attribution.release} history as ${version} (one is_initial row)${attribution.beyond.length ? `, resuming ${attribution.beyond.length} later migration(s)` : ''}`,
      };
    }
  }
  if (f.force) return { kind: 'forced', reason: '--force: an unadoptable history, the previous-version check is skipped (no is_initial row)' };
  if (f.unrestrictedTarget) return { kind: 'unchecked', reason: 'local / test target: an unattributable history is allowed (as the release floor), no is_initial row' };
  const what =
    f.codeVersion !== ADOPTION_RELEASE_VERSION
      ? `only ${ADOPTION_RELEASE_VERSION} adopts a database without logbook rows (strict from then on)`
      : attribution === null
        ? 'its migration history could not be attributed'
        : attribution.kind === 'release'
          ? `its history ${attribution.release} is not an adoptable release`
          : `its migration history is ${attribution.kind} (${attribution.detail})`;
  throw new UpgradeVersionTooOldError(`refusing to upgrade this database to ${f.codeVersion}: ${what}. Nothing was applied.`);
}
