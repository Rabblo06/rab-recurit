/**
 * Phase X U-1: the upgrade floor (release-floor.ts), the named refusals that feed outcomeOf (SU-07), the non-transactional
 * list (SU-03) and the warning-only entity-cache epoch bump (SU-04). Database-free; the runner on real databases (fresh,
 * R254, R256, a resume, older, unknown, AHEAD) is release-floor.integration.spec.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { STARTUP_EXIT_CODES } from '../../../../owner-login/runtime-db-config';
import { MigrationSessionDatabaseError, MigrationsStillPendingError } from '../locked-migration-runner';
import { bumpEntityCacheAfterUpgrade, codeMigrationNames, outcomeOf } from './migrate-on-start';
import {
  assertSupportedUpgradeStart,
  attributeLedger,
  manifestDigest,
  manifestProblems,
  ReleaseManifest,
  RELEASE_MANIFESTS,
  SUPPORTED_UPGRADE_FROM,
  supportedListProblems,
  UnsupportedUpgradeStartError,
} from './release-floor';
import { NON_TRANSACTIONAL_MIGRATIONS } from './upgrade-failure-policy';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'core', 'migrations');
const CODE = codeMigrationNames();
const byId = (id: string) => RELEASE_MANIFESTS.find((m) => m.id === id)!;
const R254 = byId('R254').names;
const R256 = byId('R256').names;
const prod = { target: 'production' as const, fresh: false, code: CODE };

describe('the frozen release manifests', () => {
  it('each recorded set matches its count, last name and sha256 (nobody edited a published release)', () => {
    for (const m of RELEASE_MANIFESTS) expect(manifestProblems(m)).toEqual([]);
    expect(byId('R254')).toMatchObject({ count: 254, last: 'WorkspaceGrantParityGuards1786721430000' });
    expect(byId('R256')).toMatchObject({ count: 256, last: 'RefreshTokenReplacedByIndex1786721450000' });
    expect(manifestDigest(R254)).toBe('9571219e4b4737def2d981c80f914cd234d91a53a8197a85673a9ec0839bbfbb');
  });

  it('each release is an ordered prefix of the next; R256 = R254 + the two index migrations', () => {
    for (let i = 1; i < RELEASE_MANIFESTS.length; i += 1) {
      const [older, newer] = [RELEASE_MANIFESTS[i - 1]!.names, RELEASE_MANIFESTS[i]!.names];
      expect(newer.slice(0, older.length)).toEqual(older);
    }
    expect(R256.slice(254)).toEqual(['OutboxClaimIndexes1786721440000', 'RefreshTokenReplacedByIndex1786721450000']);
    expect(R254).toContain('HwsHistoricalRowsPrivilegedCopy1786719520000'); // the ROW_COPY trio is inside the floor
    expect(R254.some((n) => n.endsWith('1786721330000'))).toBe(false); // the gated migration never shipped
  });

  it("every release is an ordered prefix of this code's migrations directory (this branch: the newest release equals it)", () => {
    for (const m of RELEASE_MANIFESTS) expect(CODE.slice(0, m.count)).toEqual([...m.names]);
    // Today (Phase X U-1) main has exactly R256. A later migration keeps this prefix test green; it does not need a manifest
    // until it is published in a release.
    expect(RELEASE_MANIFESTS[RELEASE_MANIFESTS.length - 1]!.names.length).toBeLessThanOrEqual(CODE.length);
  });

  it('every manifest at or after the oldest supported release is supported (a newer manifest added without its entry would refuse its databases)', () => {
    // Review note (PR #93): SUPPORTED_UPGRADE_FROM is an exact list. The floor (its oldest entry) moves only by owner decision;
    // everything newer than it must be listed, in manifest order.
    expect(supportedListProblems(RELEASE_MANIFESTS, SUPPORTED_UPGRADE_FROM)).toEqual([]);
    // The check itself can fail: a newer R258 manifest without its supported entry is reported.
    const r258: ReleaseManifest = { ...byId('R256'), id: 'R258' };
    expect(supportedListProblems([...RELEASE_MANIFESTS, r258], SUPPORTED_UPGRADE_FROM)).toEqual(['R258 is newer than the floor but not supported']);
    expect(supportedListProblems([...RELEASE_MANIFESTS, r258], [...SUPPORTED_UPGRADE_FROM, 'R258'])).toEqual([]);
    expect(supportedListProblems(RELEASE_MANIFESTS, ['R256'])).toEqual([]); // moving the floor up (owner decision) stays consistent
    expect(supportedListProblems(RELEASE_MANIFESTS, ['R999'])).toEqual(['the floor R999 is not a recorded release']);
  });

  it('the supported upgrade window is R254 and later (owner decision P1-2) and names only recorded releases', () => {
    expect(SUPPORTED_UPGRADE_FROM).toEqual(['R254', 'R256']);
    for (const id of SUPPORTED_UPGRADE_FROM) expect(byId(id)).toBeDefined();
  });

  it('a tampered manifest is reported', () => {
    const bad: ReleaseManifest = { ...byId('R254'), names: [...R254.slice(0, 253), 'Other1786721430000'] };
    expect(manifestProblems(bad).join(' ')).toMatch(/last name|sha256/);
  });
});

describe('attributeLedger', () => {
  const shuffled = (names: readonly string[]) => [...names].reverse();
  it('R254 exactly, in any ledger order', () => {
    expect(attributeLedger(shuffled(R254), CODE)).toEqual({ kind: 'release', release: 'R254', beyond: [], remaining: CODE.length - 254 });
  });
  it('R256 exactly', () => {
    expect(attributeLedger(R256, CODE)).toMatchObject({ kind: 'release', release: 'R256', beyond: [] });
  });
  it('between R254 and R256 (a resumed upgrade): R254 plus a contiguous run', () => {
    expect(attributeLedger([...R254, R256[254]!], CODE)).toEqual({ kind: 'release', release: 'R254', beyond: [R256[254]], remaining: CODE.length - 255 });
  });
  it('a hole after the release is unknown (not something TypeORM leaves behind)', () => {
    expect(attributeLedger([...R254, R256[255]!], CODE)).toMatchObject({ kind: 'unknown', detail: expect.stringMatching(/not contiguously.*OutboxClaimIndexes1786721440000/) });
  });
  it("the code's order does not matter (a DataSource's glob order is not TypeORM's run order): run order is by timestamp", () => {
    // Regression (found by the integration spec): the loaded migrations came in another order, so a hole looked contiguous.
    const scrambled = [...CODE].reverse();
    expect(attributeLedger([...R254, R256[255]!], scrambled)).toMatchObject({ kind: 'unknown' });
    expect(attributeLedger([...R254, R256[254]!], scrambled)).toMatchObject({ kind: 'release', release: 'R254', beyond: [R256[254]] });
  });
  it('older than R254: a prefix, or a holed subset of it', () => {
    expect(attributeLedger(R254.slice(0, 186), CODE)).toMatchObject({ kind: 'older' });
    expect(attributeLedger(R254.filter((_, i) => i !== 10), CODE)).toMatchObject({ kind: 'older' });
    expect(attributeLedger([], CODE)).toMatchObject({ kind: 'older' });
  });
  it('a name no release and no code knows is unknown', () => {
    expect(attributeLedger([...R254.slice(0, 100), 'SomethingElse1786700000001'], CODE)).toMatchObject({ kind: 'unknown' });
    expect(attributeLedger([...R254, 'SomethingElse1786800000000'], CODE)).toMatchObject({ kind: 'unknown', detail: expect.stringMatching(/unknown to this code/) });
  });
});

describe('assertSupportedUpgradeStart: the decision table', () => {
  const refuses = (input: Parameters<typeof assertSupportedUpgradeStart>[0], why: RegExp) => {
    let error: unknown;
    try {
      assertSupportedUpgradeStart(input);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnsupportedUpgradeStartError);
    expect((error as Error).name).toBe('UnsupportedUpgradeStartError');
    expect((error as Error).message).toMatch(why);
    expect((error as Error).message).toMatch(/Nothing was applied.*OWNER-LOGIN-RECOVERY\.md/);
  };

  it('a proven fresh install is allowed in every state that can be fresh (EMPTY, BOOTSTRAP-PARTIAL, CHAIN-PARTIAL)', () => {
    for (const state of ['EMPTY', 'BOOTSTRAP-PARTIAL', 'CHAIN-PARTIAL'] as const) {
      expect(assertSupportedUpgradeStart({ ...prod, state, fresh: true, applied: state === 'CHAIN-PARTIAL' ? R254.slice(0, 40) : [] })).toMatchObject({ allowed: true, release: null });
    }
  });

  it('CURRENT and AHEAD are allowed (nothing pending; AHEAD = an image rollback, C-1)', () => {
    expect(assertSupportedUpgradeStart({ ...prod, state: 'CURRENT', applied: CODE }).reason).toMatch(/CURRENT/);
    expect(assertSupportedUpgradeStart({ ...prod, state: 'AHEAD', applied: [...CODE, 'Newer1799999999999'] }).reason).toMatch(/AHEAD/);
  });

  it('an existing R254 database upgrades (the published v0.4.0 / cd7c7e32 / 4c38aa1a set)', () => {
    const d = assertSupportedUpgradeStart({ ...prod, state: 'CHAIN-PARTIAL', applied: R254 });
    expect(d).toMatchObject({ allowed: true, release: 'R254' });
    // Derived from the chain, not a literal: every migration added after R254 is one more to apply (the two R256 index
    // migrations, then XP-09's TokenCleanupRotationOrder1786721460000, then whatever comes next).
    const remaining = CODE.length - R254.length;
    expect(remaining).toBeGreaterThanOrEqual(R256.length - R254.length);
    expect(d.reason).toContain(`contains R254; ${remaining} migration(s) to apply`);
  });

  it('a partial upgrade past R254 resumes', () => {
    expect(assertSupportedUpgradeStart({ ...prod, state: 'CHAIN-PARTIAL', applied: [...R254, R256[254]!] }).reason).toMatch(/resuming a partial upgrade/);
  });

  it('older, holed and unknown histories refuse with the named error', () => {
    refuses({ ...prod, state: 'CHAIN-PARTIAL', applied: R254.slice(0, 186) }, /older than every supported release/);
    refuses({ ...prod, state: 'CHAIN-PARTIAL', applied: R254.filter((n) => !n.endsWith('1786720960000')) }, /older than every supported release/);
    refuses({ ...prod, state: 'CHAIN-PARTIAL', applied: [...R254, R256[255]!] }, /not a supported release .*not contiguously/);
  });

  it('a database that claims to be empty but is not a proven fresh install refuses (fail closed); FOREIGN too', () => {
    refuses({ ...prod, state: 'EMPTY', applied: [] }, /EMPTY database that is not a proven fresh install/);
    refuses({ ...prod, state: 'BOOTSTRAP-PARTIAL', applied: [] }, /BOOTSTRAP-PARTIAL/);
    refuses({ ...prod, state: 'FOREIGN', applied: ['X1786000000000'] }, /FOREIGN/);
  });

  it('a release outside the supported window refuses', () => {
    refuses({ ...prod, state: 'CHAIN-PARTIAL', applied: R254, supported: ['R256'] }, /R254, which is not a supported upgrade start/);
  });

  it('a broken manifest refuses every non-fresh upgrade (fail closed)', () => {
    const broken: ReleaseManifest[] = [{ ...byId('R254'), sha256: '0'.repeat(64) }];
    refuses({ ...prod, state: 'CHAIN-PARTIAL', applied: R254, manifests: broken }, /manifest is not intact/);
  });

  it('local and test targets are unrestricted, exactly like N1; an unknown or staging target is checked', () => {
    for (const target of ['local', 'test'] as const) {
      expect(assertSupportedUpgradeStart({ ...prod, target, state: 'CHAIN-PARTIAL', applied: R254.slice(0, 3) }).reason).toMatch(/production targets only/);
    }
    refuses({ ...prod, target: undefined, state: 'CHAIN-PARTIAL', applied: R254.slice(0, 3) }, /DB_TARGET=<unknown>/);
    refuses({ ...prod, target: 'staging' as never, state: 'CHAIN-PARTIAL', applied: R254.slice(0, 3) }, /older/);
  });
});

describe('error → startup outcome (SU-07: every refusal is a named class)', () => {
  it('the floor refusal is `behind` (exit 65): fail closed under every CREWFLOW_UPGRADE_FAILURE policy', () => {
    const e = new UnsupportedUpgradeStartError('x');
    expect(outcomeOf(e)).toBe('behind');
    expect(STARTUP_EXIT_CODES.behind).toBe(65);
    // migrate-on-start offers only `migrationFailed` to the C3 assessment; anything else returns serve:false.
    expect(outcomeOf(e)).not.toBe('migrationFailed');
  });

  it('the two former plain-Error refusals are named and fail closed (were `migrationFailed`, which could serve under continue)', () => {
    const mismatch = new MigrationSessionDatabaseError('other', 'crewflow');
    expect(mismatch.name).toBe('MigrationSessionDatabaseError');
    expect(mismatch.message).toBe('the migration session is connected to database "other", not the guarded "crewflow". Refusing.');
    expect(outcomeOf(mismatch)).toBe('identity');
    const still = new MigrationsStillPendingError(['A1786000000000']);
    expect(still.message).toBe('1 migration(s) are still pending after the run: A1786000000000');
    expect(outcomeOf(still)).toBe('postCheck');
    expect([STARTUP_EXIT_CODES.identity, STARTUP_EXIT_CODES.postCheck]).toEqual([67, 68]);
  });

  it('the runner refuses the old way only on the legacy path: N1 stays there, the floor replaces it for the owner login', () => {
    const src = readFileSync(join(__dirname, '..', 'locked-migration-runner.ts'), 'utf8');
    const owner = src.slice(src.indexOf('if (ownerLogin) {\n      // Classify first'), src.indexOf('} else {\n      assertProductionMigrationApproval'));
    expect(owner).toContain('assertSupportedUpgradeStart(');
    expect(owner).not.toContain('assertProductionMigrationApproval(');
    expect(src).toMatch(/\} else \{\n\s+assertProductionMigrationApproval\(\{ target: guarded\.target, pendingMigrationNames: pendingBefore \}\);/);
    expect(src).not.toMatch(/throw new Error\(`the migration session is connected/);
    expect(src).not.toMatch(/throw new Error\(`\$\{still\.length\} migration/);
  });
});

describe('NON_TRANSACTIONAL_MIGRATIONS (SU-03): derived from the migration sources', () => {
  it('equals the set of migrations that declare `transaction = false` (ten, 1786721430000 included)', () => {
    const fromSources = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{13}-[^.]+\.ts$/.test(f))
      .filter((f) => /^\s*(public\s+|readonly\s+)*transaction\s*=\s*false\s*;/m.test(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
      .map((f) => Number(f.slice(0, 13)))
      .sort((a, b) => a - b);
    expect([...NON_TRANSACTIONAL_MIGRATIONS].sort((a, b) => a - b)).toEqual(fromSources);
    expect(NON_TRANSACTIONAL_MIGRATIONS).toHaveLength(10);
    expect(NON_TRANSACTIONAL_MIGRATIONS).toContain(1786721430000);
  });
});

describe('the entity-cache epoch bump after an applying run (SU-04, warning only)', () => {
  const env = { REDIS_URL: 'redis://127.0.0.1:1/0', NODE_ENV: 'production' };
  it('bumps only the allow-listed namespace, once, after something was applied', async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const r = await bumpEntityCacheAfterUpgrade({ applied: ['A1786000000000'], env, log: (l) => lines.push(l), flush: async (ns) => void calls.push(ns) });
    expect(r).toBe('bumped');
    expect(calls).toEqual(['entitycache']);
  });

  it('does nothing when nothing was applied (CURRENT, AHEAD, a refused run)', async () => {
    const flush = jest.fn(async () => undefined);
    expect(await bumpEntityCacheAfterUpgrade({ applied: [], env, log: () => undefined, flush })).toBe('skipped-nothing-applied');
    expect(flush).not.toHaveBeenCalled();
  });

  it('without REDIS_URL: a warning, no flush, the start continues', async () => {
    const lines: string[] = [];
    const flush = jest.fn(async () => undefined);
    expect(await bumpEntityCacheAfterUpgrade({ applied: ['A1786000000000'], env: { NODE_ENV: 'production' }, log: (l) => lines.push(l), flush })).toBe('skipped-no-redis');
    expect(flush).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/WARNING: REDIS_URL is not set/);
  });

  it('a failing or hanging Redis is a warning, never a throw, and never echoes a URL', async () => {
    const lines: string[] = [];
    const failing = async () => {
      throw new Error('connect ECONNREFUSED redis://user:secret@10.0.0.1:6379');
    };
    expect(await bumpEntityCacheAfterUpgrade({ applied: ['A1786000000000'], env, log: (l) => lines.push(l), flush: failing })).toBe('warning');
    expect(lines.join('\n')).toMatch(/WARNING: the entity-cache epoch bump after the upgrade failed .*continuing the start/);
    expect(lines.join('\n')).not.toMatch(/secret/);
    const hanging = () => new Promise<void>(() => undefined);
    expect(await bumpEntityCacheAfterUpgrade({ applied: ['A1786000000000'], env, log: (l) => lines.push(l), flush: hanging, timeoutMs: 20 })).toBe('warning');
  });

  it('the real flush is allow-listed: any other namespace is refused before Redis is touched', async () => {
    const { runCacheFlush } = await import('../../cache-flush');
    await expect(runCacheFlush('bull', env)).rejects.toThrow(/not flushable/);
  });
});
