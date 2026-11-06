import { DelayedError, UnrecoverableError } from 'bullmq';

import { TimerTriggerKind, TimerTriggerOutcome } from '@rab/server/engine/worker-shared/timer-trigger.contract';
import { decideTimerTrigger, handleTimerTrigger, TimerTriggerHandlerDeps, TimerTriggerJobLike } from './timer-trigger.handler';

/**
 * Phase D-Q4b consumer contract, without a database: the decision query's result is scripted. Pins the order of checks
 * (fail closed → disabled → decide → early/redelay → shadow/on), that shadow never calls the action, that an invalid
 * payload or a disabled kind never touches the database, and the re-delay-once rule. The real database behaviour (RLS,
 * the compare-and-sets, cross-tenant refusal) is in dq4b-timer-triggers.integration.spec.ts.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const WS = '33333333-3333-4333-8333-333333333333';
const SUBJECT = '44444444-4444-4444-8444-444444444444';
const DUE = Date.UTC(2026, 10, 4, 12, 0, 0);

type Row = Record<string, unknown>;

function harness(opts: { mode?: 'off' | 'shadow' | 'on'; rows?: Row[]; enabled?: (k: TimerTriggerKind) => boolean; acted?: boolean } = {}) {
  const queries: string[] = [];
  const manager = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      return sql.startsWith('SET TRANSACTION') ? [] : (opts.rows ?? []);
    }),
  };
  const outcomes: Array<[TimerTriggerKind, TimerTriggerOutcome]> = [];
  const action = jest.fn(async () => opts.acted ?? true);
  const runScoped = jest.fn(async (_org: string, _ws: string, fn: (m: never) => Promise<unknown>) => fn(manager as never));
  const logs: string[] = [];
  const deps: TimerTriggerHandlerDeps = {
    mode: opts.mode ?? 'on',
    enabled: opts.enabled ?? (() => true),
    runScoped: runScoped as never,
    actions: { 'offer-expiry': action, 'manager-confirmation': action, 'no-show': action, 'late-clock-in': action },
    lateClockInGraceMinutes: 10,
    recordOutcome: (k, o) => outcomes.push([k, o]),
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
    now: () => 1_000_000,
  };
  return { deps, manager, queries, outcomes, action, runScoped, logs };
}

function job(over: Partial<TimerTriggerJobLike> & { data?: unknown } = {}): TimerTriggerJobLike & { moveToDelayed: jest.Mock } {
  return {
    id: 'j1',
    name: 'offer-expiry-trigger',
    data: { organisationId: ORG, workspaceId: WS, subjectId: SUBJECT, dueAtEpochMs: DUE },
    attemptsStarted: 1,
    moveToDelayed: jest.fn(async () => undefined),
    ...over,
  } as never;
}

const offerRow = (over: Row = {}): Row => ({ status: 'pending', offer_kind: 'standard', expires_at: new Date(DUE), staff_accepted_at: null, db_now: new Date(DUE + 1_000), ...over });

describe('handleTimerTrigger (D-Q4b consumer)', () => {
  it.each<[string, Partial<TimerTriggerJobLike>]>([
    ['an unknown job name', { name: 'offer-expiry' }],
    ['an extra payload key', { data: { organisationId: ORG, workspaceId: WS, subjectId: SUBJECT, dueAtEpochMs: DUE, userId: SUBJECT } }],
    ['a non-UUID organisation', { data: { organisationId: 'x', workspaceId: WS, subjectId: SUBJECT, dueAtEpochMs: DUE } }],
    ['a missing workspace', { data: { organisationId: ORG, workspaceId: null, subjectId: SUBJECT, dueAtEpochMs: DUE } }],
  ])('FAIL CLOSED: %s → UnrecoverableError, no database access, no action', async (_label, over) => {
    const h = harness();
    await expect(handleTimerTrigger(job(over), 't', h.deps)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.runScoped).not.toHaveBeenCalled();
    expect(h.action).not.toHaveBeenCalled();
  });

  it('a kind not enabled on this Worker (or mode off) is acknowledged as `disabled` with no database access', async () => {
    for (const h of [harness({ mode: 'off' }), harness({ enabled: (k) => k !== 'offer-expiry' })]) {
      await expect(handleTimerTrigger(job(), 't', h.deps)).resolves.toEqual({ outcome: 'disabled' });
      expect(h.runScoped).not.toHaveBeenCalled();
      expect(h.outcomes).toEqual([['offer-expiry', 'disabled']]);
    }
  });

  it('the decision runs bound to the PAYLOAD organisation/workspace, READ ONLY first', async () => {
    const h = harness({ rows: [offerRow()] });
    await handleTimerTrigger(job(), 't', h.deps);
    expect(h.runScoped).toHaveBeenCalledWith(ORG, WS, expect.any(Function));
    expect(h.queries[0]).toBe('SET TRANSACTION READ ONLY');
  });

  it('SHADOW: a due subject is counted `would-act` and logged; the action (any write) never runs', async () => {
    const h = harness({ mode: 'shadow', rows: [offerRow()] });
    await expect(handleTimerTrigger(job(), 't', h.deps)).resolves.toEqual({ outcome: 'would-act' });
    expect(h.action).not.toHaveBeenCalled();
    expect(h.logs.join('\n')).toMatch(/\(shadow\) offer-expiry would act/);
    expect(h.queries.filter((q) => !/^SET TRANSACTION READ ONLY$/.test(q)).every((q) => /^\s*SELECT/i.test(q))).toBe(true);
  });

  it('ON: a due subject runs the shared per-candidate action → `acted`; an action that matched nothing → `noop`', async () => {
    const h = harness({ rows: [offerRow()] });
    await expect(handleTimerTrigger(job(), 't', h.deps)).resolves.toEqual({ outcome: 'acted' });
    expect(h.action).toHaveBeenCalledWith({ organisationId: ORG, workspaceId: WS, subjectId: SUBJECT, dueAtEpochMs: DUE });
    const h2 = harness({ rows: [offerRow()], acted: false });
    await expect(handleTimerTrigger(job(), 't', h2.deps)).resolves.toEqual({ outcome: 'noop' });
  });

  it.each<[string, Row[] | undefined, TimerTriggerOutcome]>([
    ['not visible under RLS (forged / wrong scope / deleted)', [], 'noop'],
    ['already resolved (accepted)', [offerRow({ status: 'staff_accepted' })], 'noop'],
    ['STALE: expires_at differs from the payload', [offerRow({ expires_at: new Date(DUE + 60_000), db_now: new Date(DUE + 120_000) })], 'stale'],
    ['EARLY by more than 5 min', [offerRow({ db_now: new Date(DUE - 6 * 60_000) })], 'early'],
  ])('%s → %s, no action', async (_label, rows, outcome) => {
    const h = harness({ rows });
    await expect(handleTimerTrigger(job(), 't', h.deps)).resolves.toEqual({ outcome });
    expect(h.action).not.toHaveBeenCalled();
  });

  it('EARLY by ≤ 5 min on the first start: re-delayed ONCE to due + 1 s (DelayedError); on a later start: `early`, no re-delay', async () => {
    const h = harness({ rows: [offerRow({ db_now: new Date(DUE - 30_000) })] });
    const first = job();
    await expect(handleTimerTrigger(first, 'tok', h.deps)).rejects.toBeInstanceOf(DelayedError);
    expect(first.moveToDelayed).toHaveBeenCalledWith(1_000_000 + 30_000 + 1_000, 'tok');
    expect(h.outcomes).toEqual([['offer-expiry', 'redelayed']]);
    const again = job({ attemptsStarted: 2 });
    await expect(handleTimerTrigger(again, 'tok', h.deps)).resolves.toEqual({ outcome: 'early' });
    expect(again.moveToDelayed).not.toHaveBeenCalled();
    expect(h.action).not.toHaveBeenCalled();
  });

  it('a database error propagates (BullMQ retries; the backstop scan is unchanged)', async () => {
    const h = harness();
    h.manager.query.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(handleTimerTrigger(job(), 't', h.deps)).rejects.toThrow('connection terminated');
    expect(h.action).not.toHaveBeenCalled();
  });
});

describe('decideTimerTrigger: due time per kind, from the row (never the payload)', () => {
  const payload = (dueAtEpochMs: number) => ({ organisationId: ORG, workspaceId: WS, subjectId: SUBJECT, dueAtEpochMs });
  const settings = { lateClockInGraceMinutes: 10 };
  const run = (rows: Row[], kind: TimerTriggerKind, due: number) => decideTimerTrigger(harness({ rows }).manager as never, kind, payload(due), settings);

  it('manager-confirmation: due at the database-computed approval DEADLINE (owner rule 2026-11-06); every kind incl. standby; other statuses and cancelled shifts are no-ops', async () => {
    const row = { status: 'staff_accepted', shift_status: 'offered', deadline_at: new Date(DUE), db_now: new Date(DUE + 1_000) };
    await expect(run([row], 'manager-confirmation', DUE)).resolves.toMatchObject({ outcome: 'due', dueAtEpochMs: DUE });
    // A standby acceptance is withdrawn at its own deadline too (it is never confirmed by the system).
    await expect(run([{ ...row }], 'manager-confirmation', DUE)).resolves.toMatchObject({ outcome: 'due' });
    await expect(run([{ ...row, status: 'manager_confirmed' }], 'manager-confirmation', DUE)).resolves.toEqual({ outcome: 'noop' });
    await expect(run([{ ...row, shift_status: 'cancelled' }], 'manager-confirmation', DUE)).resolves.toEqual({ outcome: 'noop' });
    // The deadline moved (the window was re-timed) → the old trigger is stale.
    await expect(run([{ ...row, deadline_at: new Date(DUE + 5_000) }], 'manager-confirmation', DUE)).resolves.toMatchObject({ outcome: 'stale' });
    // Early → re-delay is decided by the handler; here just 'early'.
    await expect(run([{ ...row, db_now: new Date(DUE - 1_000) }], 'manager-confirmation', DUE)).resolves.toMatchObject({ outcome: 'early' });
  });

  const assignment = (over: Row = {}): Row => ({
    status: 'confirmed', shift_status: 'offered', checked_in: false, has_attendance: false, already_claimed: false, starts_at: new Date(DUE - 30 * 60_000), db_now: new Date(DUE + 1_000), ...over,
  });

  it('no-show: effective start + 30 min; clocked in, checked in, cancelled, already flagged → no-op; rescheduled → stale', async () => {
    await expect(run([assignment()], 'no-show', DUE)).resolves.toMatchObject({ outcome: 'due' });
    for (const over of [{ has_attendance: true }, { checked_in: true }, { shift_status: 'cancelled' }, { status: 'no_show' }, { already_claimed: true }]) {
      await expect(run([assignment(over)], 'no-show', DUE)).resolves.toEqual({ outcome: 'noop' });
    }
    await expect(run([assignment({ starts_at: new Date(DUE) })], 'no-show', DUE)).resolves.toMatchObject({ outcome: 'stale' });
  });

  it('late-clock-in: effective start + LATE_CLOCK_IN_GRACE_MINUTES; a checked-in-but-not-clocked-in assignment is still late', async () => {
    const row = assignment({ starts_at: new Date(DUE - 10 * 60_000) });
    await expect(run([row], 'late-clock-in', DUE)).resolves.toMatchObject({ outcome: 'due' });
    await expect(run([{ ...row, checked_in: true }], 'late-clock-in', DUE)).resolves.toMatchObject({ outcome: 'due' });
    await expect(run([{ ...row, has_attendance: true }], 'late-clock-in', DUE)).resolves.toEqual({ outcome: 'noop' });
  });
});
