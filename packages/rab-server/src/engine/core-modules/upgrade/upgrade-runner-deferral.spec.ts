/**
 * Release 0.7.0 (#175 refresh review): a patch start's resume of its minor .0 (upgrade-runner.ts resumeMinorBeforeMigrations)
 * when the .0 command DEFERS (returns `{ deferred }`, like the C3 cutover with HWS off and nothing pending) while migrations
 * of the patch are pending. The logbook is an in-memory stand-in for core.upgrade_migration (the same attempt rule as
 * recordUpgradeMigration); the real-database version of these cases is cross-upgrade-resume.integration.spec.ts case 9.
 */
import type { UpgradeCommand } from './upgrade-commands/upgrade-command';
import type { UpgradeSession } from './upgrade-migration.service';
import { MinorReleaseResumeFailedError, UpgradeRun } from './upgrade-runner';
import { commandStepName } from './upgrade-sequence';

interface MockRow {
  name: string;
  status: 'completed' | 'failed';
  attempt: number;
  v: string;
  forced: boolean;
  error: string | null;
}
const mockLedger: MockRow[] = [];

jest.mock('./upgrade-migration.service', () => {
  const actual = jest.requireActual('./upgrade-migration.service');
  const last = (name: string) =>
    mockLedger
      .filter((r) => r.name === name)
      .sort((a, b) => b.attempt - a.attempt)[0];
  return {
    ...actual,
    withUpgradeScope: async (
      _session: unknown,
      _scope: string,
      fn: (q: unknown) => Promise<unknown>,
    ) => fn(async () => []),
    isLastAttemptCompleted: async (_q: unknown, input: { name: string }) =>
      last(input.name)?.status === 'completed',
    anyForcedInstanceAttempt: async (_q: unknown, name: string) =>
      mockLedger.some((r) => r.name === name && r.forced),
    upgradeLedgerExists: async () => true,
    markAsInstanceInitial: async () => false,
    recordUpgradeMigration: async (
      _q: unknown,
      input: {
        name: string;
        status: 'completed' | 'failed';
        executedByVersion: string;
        forced: boolean;
        error?: unknown;
      },
    ) => {
      const attempt =
        mockLedger.filter((r) => r.name === input.name).length + 1;
      mockLedger.push({
        name: input.name,
        status: input.status,
        attempt,
        v: input.executedByVersion,
        forced: input.forced,
        error:
          input.status === 'failed'
            ? actual.errorMessageForStorage(input.error ?? 'failed')
            : null,
      });
      return attempt;
    },
  };
});

const T = 1786995000123;
const REASON = 'probe: HWS runtime routing is OFF and nothing is pending';
let deferNow = true;
const probe: UpgradeCommand = {
  name: 'ProbeDeferCutover',
  timestamp: T,
  run: async () => (deferNow ? { deferred: REASON } : undefined),
};
const STEP = commandStepName('0.7.0', probe);
const session = {
  upgradeSession: true,
  query: async () => [],
} as unknown as UpgradeSession;
type Internals = {
  resumeMinorBeforeMigrations(
    s: UpgradeSession,
    minor: string,
    pending: readonly string[],
  ): Promise<void>;
  decision: unknown;
};

const patchRun = (force: boolean, lines: string[]) =>
  new UpgradeRun({
    codeVersion: '0.7.1',
    previousVersions: ['0.4.0', '0.5.0', '0.6.0', '0.7.0'],
    upgradeFrom: { '0.7.0': ['0.6.0'] },
    force,
    log: (l) => lines.push(l),
    registry: { '0-7': [probe] },
    host: {} as never,
  });
const internals = (r: UpgradeRun) => r as unknown as Internals;

describe('patch start: the .0 step DEFERS on the retry with the patch migrations pending (release 0.7.0)', () => {
  beforeEach(() => {
    mockLedger.length = 0;
    deferNow = true;
    // 0.7.0 started: its migrations step completed, its cutover deferred (no row).
    mockLedger.push({
      name: '0.7.0_TypeOrmMigrations',
      status: 'completed',
      attempt: 1,
      v: '0.7.0',
      forced: false,
      error: null,
    });
  });

  it('(a) unforced: MinorReleaseResumeFailedError flagged deferred (exit 66), nothing recorded', async () => {
    const lines: string[] = [];
    const r = patchRun(false, lines);
    const error = await internals(r)
      .resumeMinorBeforeMigrations(session, '0.7.0', [
        'PatchMigration1799999990001',
      ])
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(MinorReleaseResumeFailedError);
    expect(error).toMatchObject({ step: STEP, attempt: null, deferred: true });
    expect((error as Error).message).toMatch(
      /was deferred \(not recorded\) before any migration of this start/,
    );
    expect((error as Error).message).not.toMatch(/failed again/);
    expect(mockLedger.map((x) => x.name)).toEqual(['0.7.0_TypeOrmMigrations']);
    expect(r.report.recorded).toEqual([]);
    expect(r.report.deferred).toEqual([STEP]);
  });

  it('a failed (not deferred) retry keeps deferred = false on the error', async () => {
    const failing: UpgradeCommand = {
      name: 'ProbeFailCutover',
      timestamp: T + 1,
      run: async () => Promise.reject(new Error('boom')),
    };
    const r = new UpgradeRun({
      codeVersion: '0.7.1',
      previousVersions: ['0.4.0', '0.5.0', '0.6.0', '0.7.0'],
      upgradeFrom: { '0.7.0': ['0.6.0'] },
      force: false,
      log: () => undefined,
      registry: { '0-7': [failing] },
      host: {} as never,
    });
    const error = await internals(r)
      .resumeMinorBeforeMigrations(session, '0.7.0', [
        'PatchMigration1799999990001',
      ])
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toMatchObject({
      name: 'MinorReleaseResumeFailedError',
      deferred: false,
      attempt: 1,
    });
  });

  it('(b) --force: ONE forced marker row (DeferredUnderForce); afterApply records no patch migrations step and runs no workspace pass', async () => {
    const lines: string[] = [];
    const r = patchRun(true, lines);
    await internals(r).resumeMinorBeforeMigrations(session, '0.7.0', [
      'PatchMigration1799999990001',
    ]);
    expect(mockLedger.filter((x) => x.name === STEP)).toEqual([
      {
        name: STEP,
        status: 'failed',
        attempt: 1,
        v: '0.7.1',
        forced: true,
        error: `DeferredUnderForce: deferred under --force: ${REASON}`,
      },
    ]);
    expect(r.report.recorded).toEqual([
      { name: STEP, status: 'failed', attempt: 1 },
    ]);
    expect(r.report.commandFailure).toBeNull();
    expect(
      lines.some((l) =>
        l.includes(
          `WARNING: upgrade --force: ${STEP} was deferred again; recorded as a forced marker (attempt 1, DeferredUnderForce)`,
        ),
      ),
    ).toBe(true);
    // (the runner applies the migrations here) then afterApply:
    internals(r).decision = { kind: 'forced', reason: 'test' };
    await r.afterApply(session);
    expect(mockLedger.some((x) => x.name === '0.7.1_TypeOrmMigrations')).toBe(
      false,
    );
    expect(r.report.workspaces).toBeNull();
    expect(lines.some((l) => l.includes('0.7.1 complete'))).toBe(false);
  });

  it('(c) the cause resolved, nothing pending: the retry finds the marker and is recorded FORCED (#240 trace kept)', async () => {
    await internals(patchRun(true, [])).resumeMinorBeforeMigrations(
      session,
      '0.7.0',
      ['PatchMigration1799999990001'],
    );
    deferNow = false;
    const lines: string[] = [];
    const r = patchRun(false, lines);
    await internals(r).resumeMinorBeforeMigrations(session, '0.7.0', []);
    expect(
      lines.some((l) =>
        l.includes(
          `WARNING: ${STEP} runs on a schema that an earlier --force start moved past 0.7.0`,
        ),
      ),
    ).toBe(true);
    expect(
      mockLedger
        .filter((x) => x.name === STEP)
        .map(({ status, attempt, forced }) => ({ status, attempt, forced })),
    ).toEqual([
      { status: 'failed', attempt: 1, forced: true },
      { status: 'completed', attempt: 2, forced: true },
    ]);
  });

  it('nothing pending and the step defers: nothing recorded, the start stops (afterApply: no patch step, no workspace pass)', async () => {
    const r = patchRun(false, []);
    await internals(r).resumeMinorBeforeMigrations(session, '0.7.0', []);
    expect(mockLedger.map((x) => x.name)).toEqual(['0.7.0_TypeOrmMigrations']);
    internals(r).decision = { kind: 'continue', reason: 'test' };
    await r.afterApply(session);
    expect(mockLedger.map((x) => x.name)).toEqual(['0.7.0_TypeOrmMigrations']);
    expect(r.report.workspaces).toBeNull();
  });
});
