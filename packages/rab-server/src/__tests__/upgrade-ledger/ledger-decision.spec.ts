/**
 * B2 tests (OWNER-DB-ULTIMATE.md Part B3; UPGRADE-LEDGER-INTERFACE.md §2-§3): LV-3, the previous-version check as a PURE
 * decision (no database). Twenty reference (re-implemented, nothing copied), twentyhq/twenty @ eedb0a73
 * `database/commands/run-instance-commands.command.ts:124-168`:
 *   - previous version complete -> go; missing / incomplete -> refuse (65, `UpgradeVersionTooOldError`);
 *   - nothing recorded + an R254 / R256 history -> adoption (one is_initial row at 0.4.0 / 0.5.0);
 *   - nothing recorded + an older / unknown history -> refuse (65) on a restricted (production) target;
 *   - `--force` skips ONLY this check: never a version-bump refusal, and a complete version is still `continue`.
 * The integration counterparts (real databases) are ledger-upgrade LU-1/2/3/8.
 */
import { ADOPTION, b1, FIRST_LEDGER_VERSION, UpgradeStartFactsLike } from './ledger-contract';

const B1 = b1();
const describeIfB1 = B1 ? describe : describe.skip;

const TOO_OLD = 'UpgradeVersionTooOldError';

function refusal(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.name : 'non-error';
  }
}

describeIfB1('LV-3 the previous-version check (pure decideUpgradeStart)', () => {
  const V = FIRST_LEDGER_VERSION;
  const base: UpgradeStartFactsLike = Object.freeze({
    codeVersion: V,
    fresh: false,
    force: false,
    ledgerExists: true,
    hasInstanceRows: true,
    complete: {},
    newerVersions: [],
    attribution: null,
    unrestrictedTarget: false,
  });
  const decide = (over: Partial<UpgradeStartFactsLike>) => B1!.decide({ ...base, ...over });
  const r254 = { kind: 'release' as const, release: 'R254', beyond: [], remaining: 3 };
  const r256 = { kind: 'release' as const, release: 'R256', beyond: [], remaining: 1 };

  it('the code under test is the first ledger release (the adoption rules below are 0.6.0 rules)', () => {
    expect(B1!.currentVersion).toBe(V);
  });

  it('a previous version complete (0.4.0 or 0.5.0) -> continue from it', () => {
    expect(decide({ complete: { [ADOPTION.R254]: true } })).toMatchObject({ kind: 'continue', from: ADOPTION.R254 });
    expect(decide({ complete: { [ADOPTION.R256]: true } })).toMatchObject({ kind: 'continue', from: ADOPTION.R256 });
  });

  it('the code version itself already complete (a repeated start) -> continue', () => {
    expect(decide({ complete: { [V]: true } })).toMatchObject({ kind: 'continue', from: V });
  });

  it('logbook rows but no accepted previous version complete -> refused (65), also when they are explicitly false', () => {
    expect(refusal(() => decide({}))).toBe(TOO_OLD);
    expect(refusal(() => decide({ complete: { [ADOPTION.R254]: false, [ADOPTION.R256]: false, [V]: false } }))).toBe(TOO_OLD);
    // A version that is not an accepted previous one (a skipped release, 0.3.0) does not count.
    expect(refusal(() => decide({ complete: { '0.3.0': true } }))).toBe(TOO_OLD);
  });

  it('nothing recorded + an R254 / R256 history -> adoption with ONE is_initial row at 0.4.0 / 0.5.0', () => {
    for (const ledgerExists of [false, true]) {
      expect(decide({ ledgerExists, hasInstanceRows: false, attribution: r254 })).toMatchObject({ kind: 'adopt', initialVersion: ADOPTION.R254, initialName: `${ADOPTION.R254}_TypeOrmMigrations` });
      expect(decide({ ledgerExists, hasInstanceRows: false, attribution: r256 })).toMatchObject({ kind: 'adopt', initialVersion: ADOPTION.R256, initialName: `${ADOPTION.R256}_TypeOrmMigrations` });
    }
  });

  it('nothing recorded + an older / unknown / unattributed / non-adoptable history on a production target -> refused (65)', () => {
    for (const attribution of [
      { kind: 'older' as const, detail: 'R254 minus four' },
      { kind: 'unknown' as const, detail: 'a hole' },
      null,
      { kind: 'release' as const, release: 'R200', beyond: [], remaining: 9 },
    ]) {
      expect([attribution?.kind ?? 'null', refusal(() => decide({ ledgerExists: false, hasInstanceRows: false, attribution }))]).toEqual([attribution?.kind ?? 'null', TOO_OLD]);
    }
  });

  it('a local / test target leaves an unattributable history unchecked (no is_initial row), never adopts it', () => {
    expect(decide({ ledgerExists: false, hasInstanceRows: false, attribution: { kind: 'unknown', detail: 'x' }, unrestrictedTarget: true })).toMatchObject({ kind: 'unchecked' });
  });

  it('a fresh install skips the check; a newer version in the logbook is a rollback (nothing recorded)', () => {
    expect(decide({ fresh: true, ledgerExists: false, hasInstanceRows: false })).toMatchObject({ kind: 'fresh' });
    expect(decide({ newerVersions: ['9.9.0'] })).toMatchObject({ kind: 'rollback', newer: ['9.9.0'] });
  });

  it('--force skips ONLY the previous-version check', () => {
    // The refusals above become `forced` ...
    expect(decide({ force: true })).toMatchObject({ kind: 'forced' });
    expect(decide({ force: true, ledgerExists: false, hasInstanceRows: false, attribution: { kind: 'older', detail: 'x' } })).toMatchObject({ kind: 'forced' });
    // ... but a complete previous version is still an ordinary continue, an adoptable history still adopts, a fresh install
    // is still fresh and a rollback is still a rollback: force changes nothing else.
    expect(decide({ force: true, complete: { [ADOPTION.R256]: true } })).toMatchObject({ kind: 'continue' });
    expect(decide({ force: true, ledgerExists: false, hasInstanceRows: false, attribution: r256 })).toMatchObject({ kind: 'adopt' });
    expect(decide({ force: true, fresh: true })).toMatchObject({ kind: 'fresh' });
    expect(decide({ force: true, newerVersions: ['9.9.0'] })).toMatchObject({ kind: 'rollback' });
  });

  it('a code version not newer than the last published version is refused, also under --force (the bump check is not the previous-version check)', () => {
    for (const force of [false, true]) {
      const name = refusal(() => decide({ codeVersion: ADOPTION.R256, force, complete: { [ADOPTION.R256]: true } }));
      expect([force, name]).toEqual([force, 'AppVersionError']);
    }
  });

  it('after 0.6.0 only the immediately previous version is accepted, and nothing recorded never adopts again', () => {
    const previousVersions = ['0.4.0', '0.5.0', '0.6.0'];
    expect(B1!.decide({ ...base, codeVersion: '0.7.0', previousVersions, complete: { '0.6.0': true } })).toMatchObject({ kind: 'continue', from: '0.6.0' });
    expect(refusal(() => B1!.decide({ ...base, codeVersion: '0.7.0', previousVersions, complete: { '0.5.0': true } }))).toBe(TOO_OLD);
    expect(refusal(() => B1!.decide({ ...base, codeVersion: '0.7.0', previousVersions, ledgerExists: false, hasInstanceRows: false, attribution: r256 }))).toBe(TOO_OLD);
  });
});
