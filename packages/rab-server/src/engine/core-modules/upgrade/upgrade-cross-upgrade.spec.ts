/**
 * Owner decisions 2026-11-18 on the upgrade runner (follow-up to #219), pure (the database half is
 * cross-upgrade-resume.integration.spec.ts):
 *   (a) a MINOR release upgrades from an explicit, reviewed list of versions (CREWFLOW_UPGRADE_FROM_VERSIONS; Twenty keeps
 *       TWENTY_PREVIOUS_VERSIONS and TWENTY_CROSS_UPGRADE_SUPPORTED_VERSIONS = previous + current, re-implemented, not copied),
 *       e.g. 0.7.0 from any published 0.6.x; anything not on the list is refused with a clear message; the M-1 fold and the L-2
 *       ascending check stay;
 *   (b) a PATCH release resumes its minor .0: when an unforced start already moved the instance on to the .0 and every READY
 *       workspace has a logbook row, the patch continues and re-runs the .0's incomplete steps under their own names (Twenty
 *       upgrade-sequence-runner.service.ts:98-247, "Rerun the upgrade to resume from this step").
 */
import { outcomeOf } from '../../../database/typeorm/scripts/migrate/owner-login/migrate-on-start';
import type { UpgradeCommand } from './upgrade-commands/upgrade-command';
import { UPGRADE_COMMANDS } from './upgrade-commands/registry';
import { MinorReleaseResumeFailedError } from './upgrade-runner';
import { instanceStepsOfStart, instanceVersionsOfStart } from './upgrade-sequence';
import { upgradeStateOf } from './upgrade-status.service';
import { decideUpgradeStart, UpgradeStartFacts, UpgradeVersionTooOldError, versionsToCheck } from './upgrade-version-check';
import {
  AppVersionError,
  assertUpgradeFromList,
  CREWFLOW_PREVIOUS_VERSIONS,
  compareVersions,
  CREWFLOW_UPGRADE_FROM_VERSIONS,
  crossUpgradeSupportedVersions,
  isPatchRelease,
  readAppVersion,
  upgradeFromVersions,
} from './upgrade-version';

const PREV_070 = ['0.4.0', '0.5.0', '0.6.0', '0.6.1', '0.6.2'];
const UF_070 = { '0.7.0': ['0.6.0', '0.6.1', '0.6.2'] };
const PREV_071 = [...PREV_070, '0.7.0'];
const facts = (over: Partial<UpgradeStartFacts>): UpgradeStartFacts => ({
  codeVersion: '0.7.0',
  previousVersions: PREV_070,
  upgradeFrom: UF_070,
  fresh: false,
  force: false,
  ledgerExists: true,
  hasInstanceRows: true,
  complete: {},
  newerVersions: [],
  attribution: null,
  unrestrictedTarget: false,
  ...over,
});
const thrown = (fn: () => unknown): Error | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e as Error;
  }
};

describe('(a) a minor release upgrades from its reviewed list (CREWFLOW_UPGRADE_FROM_VERSIONS)', () => {
  it('0.7.0 accepts every 0.6.x on its list; the cross-upgrade-supported set is the list plus the code version (Twenty)', () => {
    expect(upgradeFromVersions('0.7.0', PREV_070, UF_070)).toEqual(['0.6.0', '0.6.1', '0.6.2']);
    expect(crossUpgradeSupportedVersions('0.7.0', PREV_070, UF_070)).toEqual(['0.6.0', '0.6.1', '0.6.2', '0.7.0']);
    // The caller also reads each accepted patch's .0 (M-1); here the .0 is already on the list.
    expect(versionsToCheck('0.7.0', PREV_070, UF_070)).toEqual(['0.6.0', '0.6.1', '0.6.2', '0.7.0']);
    // A shorter reviewed list is honoured exactly (the owner may leave a version out).
    expect(upgradeFromVersions('0.7.0', PREV_070, { '0.7.0': ['0.6.2'] })).toEqual(['0.6.2']);
  });

  it('a database that completed 0.6.0, 0.6.1 or 0.6.2 continues to 0.7.0 (no longer only the last published one)', () => {
    expect(decideUpgradeStart(facts({ complete: { '0.6.0': true } }))).toMatchObject({ kind: 'continue', from: '0.6.0' });
    expect(decideUpgradeStart(facts({ complete: { '0.6.0': true, '0.6.1': true } }))).toMatchObject({ kind: 'continue', from: '0.6.0' });
    expect(decideUpgradeStart(facts({ complete: { '0.6.0': true, '0.6.2': true } }))).toMatchObject({ kind: 'continue', from: '0.6.0' });
    // Before this change 0.7.0 accepted only 0.6.2 (the last entry): a database still at 0.6.0 was refused.
  });

  it('refuses anything not on the list (65) with a message that names the list; --force skips only that', () => {
    const error = thrown(() => decideUpgradeStart(facts({ complete: { '0.5.0': true, '0.6.0': false } })));
    expect(error).toBeInstanceOf(UpgradeVersionTooOldError);
    expect(error!.message).toContain('0.6.0, 0.6.1, 0.6.2');
    expect(error!.message).toContain('CREWFLOW_UPGRADE_FROM_VERSIONS');
    expect(error!.message).toContain('Nothing was applied');
    expect(outcomeOf(error)).toBe('behind');
    expect(() => decideUpgradeStart(facts({ complete: {} }))).toThrow(UpgradeVersionTooOldError);
    expect(decideUpgradeStart(facts({ complete: { '0.5.0': true }, force: true })).kind).toBe('forced');
    // A version left off a shorter list is refused although it is complete.
    expect(() => decideUpgradeStart(facts({ upgradeFrom: { '0.7.0': ['0.6.2'] }, complete: { '0.6.0': true, '0.6.1': true } }))).toThrow(UpgradeVersionTooOldError);
  });

  it('M-1 stays: an accepted patch counts only when its .0 is complete too (a workspace short of 0.6.0 → 65)', () => {
    expect(() => decideUpgradeStart(facts({ complete: { '0.6.2': true, '0.6.1': true, '0.6.0': false } }))).toThrow(UpgradeVersionTooOldError);
    expect(decideUpgradeStart(facts({ upgradeFrom: { '0.7.0': ['0.6.2'] }, complete: { '0.6.2': true, '0.6.0': true } }))).toMatchObject({ kind: 'continue', from: '0.6.2' });
    expect(versionsToCheck('0.7.0', PREV_070, { '0.7.0': ['0.6.2'] })).toEqual(['0.6.2', '0.6.0', '0.7.0']);
  });

  it('fail closed (config, 64) on a missing or invalid list, before any outcome (fresh and rollback included)', () => {
    const bad: Array<[Record<string, readonly string[]>, RegExp]> = [
      [{}, /is missing/],
      [{ '0.7.0': [] }, /is missing/],
      [{ '0.7.0': ['0.6.1', '0.6.0'] }, /strictly ascending/],
      [{ '0.7.0': ['0.6.0', '0.6.0'] }, /strictly ascending/],
      [{ '0.7.0': ['0.6.0', '0.6.3'] }, /not a published version/],
      [{ '0.7.0': ['0.6.0', '0.7.0'] }, /not older than 0\.7\.0/],
      [{ '0.7.0': ['0.6.0', 'x'] }, /MAJOR\.MINOR\.PATCH/],
      // An older line would skip that line's commands (0.6.0's workspace commands for a 0.5.0 database).
      [{ '0.7.0': ['0.5.0', '0.6.0'] }, /not on the previous minor line \(0\.6\.0\)/],
    ];
    for (const [upgradeFrom, message] of bad) {
      for (const over of [{}, { fresh: true }, { newerVersions: ['0.8.0'] }]) {
        const error = thrown(() => decideUpgradeStart(facts({ upgradeFrom, ...over })));
        expect([JSON.stringify(upgradeFrom), error?.name]).toEqual([JSON.stringify(upgradeFrom), 'AppVersionError']);
        expect(error!.message).toMatch(message);
        expect(outcomeOf(error)).toBe('config');
      }
      expect(() => versionsToCheck('0.7.0', PREV_070, upgradeFrom)).toThrow(AppVersionError);
    }
    // An inherited key is not a list (no prototype lookups).
    expect(() => upgradeFromVersions('0.7.0', PREV_070, Object.create({ '0.7.0': ['0.6.0'] }))).toThrow(/is missing/);
  });

  it('the adoption release lists exactly R254 / R256; a patch release needs no entry (its own minor line)', () => {
    expect(assertUpgradeFromList('0.6.0', ['0.4.0', '0.5.0'], ['0.4.0', '0.5.0'])).toEqual(['0.4.0', '0.5.0']);
    expect(() => assertUpgradeFromList('0.6.0', ['0.5.0'], ['0.4.0', '0.5.0'])).toThrow(/exactly the adoptable histories/);
    expect(upgradeFromVersions('0.7.1', PREV_071, {})).toEqual(['0.7.0']);
    expect(upgradeFromVersions('0.6.2', ['0.4.0', '0.5.0', '0.6.0', '0.6.1'], {})).toEqual(['0.6.0', '0.6.1']);
  });

  it('L-2 stays: an out-of-order published list refuses (64) before the upgrade-from list is read', () => {
    expect(() => decideUpgradeStart(facts({ previousVersions: ['0.4.0', '0.6.0', '0.5.0'], fresh: true }))).toThrow(/CREWFLOW_PREVIOUS_VERSIONS must be strictly ascending/);
  });

  it("release guard: this code's own version, and EVERY entry of the shipped map, validate against the shipped lists", () => {
    const shipped = readAppVersion({});
    expect(() => upgradeFromVersions(shipped, CREWFLOW_PREVIOUS_VERSIONS, CREWFLOW_UPGRADE_FROM_VERSIONS)).not.toThrow();
    if (!isPatchRelease(shipped)) expect(Object.keys(CREWFLOW_UPGRADE_FROM_VERSIONS)).toContain(shipped);
    for (const [key, list] of Object.entries(CREWFLOW_UPGRADE_FROM_VERSIONS)) {
      expect(isPatchRelease(key)).toBe(false);
      // Each entry against the versions published before its release (what that release's own start saw).
      const before = [...CREWFLOW_PREVIOUS_VERSIONS, shipped].filter((v) => compareVersions(v, key) < 0);
      expect(() => assertUpgradeFromList(key, list, before)).not.toThrow();
    }
  });
});

describe('(b) a patch release resumes its minor .0 (decideUpgradeStart)', () => {
  const at071 = (over: Partial<UpgradeStartFacts>) => decideUpgradeStart(facts({ codeVersion: '0.7.1', previousVersions: PREV_071, upgradeFrom: {}, ...over }));

  it('0.7.0 started unforced and incomplete (its cutover failed): 0.7.1 continues and resumes it under its own names', () => {
    const decision = at071({ complete: { '0.7.0': false }, minorReleaseResumable: true });
    expect(decision).toMatchObject({ kind: 'continue', from: '0.7.0' });
    expect(decision.reason).toMatch(/0\.7\.0 was already started by an unforced run .* 0\.7\.1 resumes its incomplete steps under their own names/);
  });

  it('not resumable (0.7.0 never started unforced, or a READY workspace has no logbook row): still 65; --force skips only that', () => {
    expect(() => at071({ complete: { '0.7.0': false } })).toThrow(UpgradeVersionTooOldError);
    expect(() => at071({ complete: { '0.7.0': false }, minorReleaseResumable: false })).toThrow(/a patch upgrades only from its own minor line/);
    expect(at071({ complete: { '0.7.0': false }, force: true }).kind).toBe('forced');
  });

  it('a failed .0 command retried before pending patch migrations refuses the start as a migration failure (66)', () => {
    expect(outcomeOf(new MinorReleaseResumeFailedError('x', '0.7.0_HwsCutover_1786721540100', 2))).toBe('migrationFailed');
  });

  it('a MINOR release never uses the resume rule (it is not a patch of anything)', () => {
    expect(() => decideUpgradeStart(facts({ complete: { '0.6.0': false }, minorReleaseResumable: true }))).toThrow(UpgradeVersionTooOldError);
  });

  it('a complete .0, a repeated patch start and a rollback behave as before', () => {
    expect(at071({ complete: { '0.7.0': true } })).toMatchObject({ kind: 'continue', from: '0.7.0' });
    expect(at071({ complete: { '0.7.0': false, '0.7.1': true } })).toMatchObject({ kind: 'continue', from: '0.7.1' });
    expect(at071({ complete: { '0.7.0': false }, newerVersions: ['0.8.0'], minorReleaseResumable: true }).kind).toBe('rollback');
  });
});

describe('(b) which instance steps one start runs, and what /healthz reads', () => {
  const probe: UpgradeCommand = { name: 'CutoverProbe', timestamp: 1786990000000, run: async () => undefined };
  const registry = { ...UPGRADE_COMMANDS, '0-7': [probe] };

  it('a minor release runs its own; a patch first its .0 (migrations step + commands), then its own migrations step', () => {
    expect(instanceVersionsOfStart('0.7.0')).toEqual(['0.7.0']);
    expect(instanceVersionsOfStart('0.7.1')).toEqual(['0.7.0', '0.7.1']);
    expect(instanceVersionsOfStart('0.7.12')).toEqual(['0.7.0', '0.7.12']);
    expect(instanceStepsOfStart('0.7.1', registry)).toEqual(['0.7.0_TypeOrmMigrations', '0.7.0_CutoverProbe_1786990000000', '0.7.1_TypeOrmMigrations']);
    expect(instanceStepsOfStart('0.7.0', registry)).toEqual(['0.7.0_TypeOrmMigrations', '0.7.0_CutoverProbe_1786990000000']);
    expect(() => instanceVersionsOfStart('0.7')).toThrow(AppVersionError);
  });

  it('/healthz: a patch whose .0 step is still failed reads failed, not ok (the status reads both versions)', () => {
    expect(upgradeStateOf({ ledgerExists: true, anyRow: true, newer: false, appComplete: false, appStepFailed: true })).toBe('failed');
    expect(upgradeStateOf({ ledgerExists: true, anyRow: true, newer: false, appComplete: true, appStepFailed: false })).toBe('ok');
  });
});
