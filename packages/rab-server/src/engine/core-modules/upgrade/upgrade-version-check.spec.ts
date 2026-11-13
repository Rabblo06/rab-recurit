import type { LedgerAttribution } from '../../../database/typeorm/scripts/migrate/owner-login/release-floor';
import { decideUpgradeStart, UpgradeStartFacts, UpgradeVersionTooOldError } from './upgrade-version-check';
import { AppVersionError } from './upgrade-version';

const base = (over: Partial<UpgradeStartFacts> = {}): UpgradeStartFacts => ({
  codeVersion: '0.6.0',
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
const release = (id: string): LedgerAttribution => ({ kind: 'release', release: id, beyond: [], remaining: 3 });

describe('decideUpgradeStart (Twenty run-instance-commands.command.ts:124-168)', () => {
  it('a fresh install skips the check', () => {
    expect(decideUpgradeStart(base({ fresh: true, ledgerExists: false, hasInstanceRows: false })).kind).toBe('fresh');
  });

  it('adopts an R254 / R256 history once, only in 0.6.0', () => {
    const r254 = decideUpgradeStart(base({ ledgerExists: false, hasInstanceRows: false, attribution: release('R254') }));
    expect(r254).toMatchObject({ kind: 'adopt', initialName: '0.4.0_TypeOrmMigrations', initialVersion: '0.4.0' });
    const r256 = decideUpgradeStart(base({ ledgerExists: true, hasInstanceRows: false, attribution: release('R256') }));
    expect(r256).toMatchObject({ kind: 'adopt', initialVersion: '0.5.0' });
    expect(() =>
      decideUpgradeStart(
        base({ codeVersion: '0.7.0', previousVersions: ['0.4.0', '0.5.0', '0.6.0'], ledgerExists: false, hasInstanceRows: false, attribution: release('R256') }),
      ),
    ).toThrow(UpgradeVersionTooOldError);
  });

  it('refuses an unknown or older history (production), allows it unrecorded on local / test, and --force skips it', () => {
    const unknown: LedgerAttribution = { kind: 'unknown', detail: 'holes' };
    expect(() => decideUpgradeStart(base({ hasInstanceRows: false, attribution: unknown }))).toThrow(UpgradeVersionTooOldError);
    expect(decideUpgradeStart(base({ hasInstanceRows: false, attribution: unknown, unrestrictedTarget: true })).kind).toBe('unchecked');
    expect(decideUpgradeStart(base({ hasInstanceRows: false, attribution: unknown, force: true })).kind).toBe('forced');
  });

  it('continues when an accepted previous version (or this version) is complete', () => {
    expect(decideUpgradeStart(base({ complete: { '0.4.0': true } }))).toMatchObject({ kind: 'continue', from: '0.4.0' });
    expect(decideUpgradeStart(base({ complete: { '0.6.0': true } }))).toMatchObject({ kind: 'continue', from: '0.6.0' });
  });

  it('strict from 0.7.0: a skipped release refuses (65) and --force skips only that', () => {
    const facts = base({ codeVersion: '0.7.0', previousVersions: ['0.4.0', '0.5.0', '0.6.0'], complete: { '0.5.0': true, '0.6.0': false } });
    expect(() => decideUpgradeStart(facts)).toThrow(UpgradeVersionTooOldError);
    expect(decideUpgradeStart({ ...facts, force: true }).kind).toBe('forced');
  });

  it('a newer version in the logbook is a rollback (nothing recorded), even under --force', () => {
    expect(decideUpgradeStart(base({ newerVersions: ['0.7.0'] })).kind).toBe('rollback');
    expect(decideUpgradeStart(base({ newerVersions: ['0.7.0'], force: true })).kind).toBe('rollback');
  });

  it('refuses (config) when the code version was not bumped past the last published version', () => {
    expect(() => decideUpgradeStart(base({ codeVersion: '0.5.0' }))).toThrow(AppVersionError);
    expect(() => decideUpgradeStart(base({ codeVersion: '0.1.0' }))).toThrow(AppVersionError);
  });
});
