import type { TimerTriggerArm } from '@rab/server/engine/core-modules/timer-trigger/timer-trigger-queue.service';
import { TimerTriggerKind } from '@rab/server/engine/worker-shared/timer-trigger.contract';
import { TIMER_TRIGGER_OUTCOMES_KEY, TIMER_TRIGGER_OUTCOMES_TTL_SECONDS } from '@rab/server/engine/worker-shared/timer-trigger.contract';
import { armShiftTimerTriggers, redisTimerTriggerOutcomeRecorder, ShiftArmCandidate } from './timer-trigger-arming';

/**
 * Phase D-Q4b: no-show / late clock-in arming from shift-monitor's existing discovery rows (no extra query). Pins the
 * horizon, the due times (the scans' own thresholds), the kind switch, the null-workspace skip and that a publish
 * failure is counted and never thrown into the scan.
 */
const NOW = Date.UTC(2026, 10, 4, 9, 0, 0);
const ORG = '11111111-1111-4111-8111-111111111111';
const WS = '33333333-3333-4333-8333-333333333333';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cand = (n: number, startOffsetMs: number, ws: string | null = WS): ShiftArmCandidate => ({ assignment_id: id(n), organisation_id: ORG, workspace_id: ws, starts_at: new Date(NOW + startOffsetMs) });

function producer(enabled: TimerTriggerKind[] = ['no-show', 'late-clock-in'], ok = true) {
  const armed: TimerTriggerArm[] = [];
  return {
    armed,
    enabled: (k: TimerTriggerKind) => enabled.includes(k),
    publishNow: jest.fn(async (arm: TimerTriggerArm) => {
      armed.push(arm);
      if (!ok) throw new Error('redis down');
      return true;
    }),
  };
}

const opts = { nowMs: NOW, horizonMs: 10 * 60_000, lateClockInGraceMinutes: 10 };

describe('armShiftTimerTriggers (D-Q4b)', () => {
  it('arms only assignments starting in the future within the horizon, with due = start + 30 min / start + grace', async () => {
    const p = producer();
    const result = await armShiftTimerTriggers(p, [cand(1, 5 * 60_000), cand(2, 11 * 60_000), cand(3, -60_000), cand(4, 10 * 60_000)], opts);
    expect(result).toEqual({ armed: 4, failed: 0 });
    expect(p.armed.map((a) => [a.kind, a.subjectId, a.dueAt.getTime() - NOW])).toEqual([
      ['no-show', id(1), 5 * 60_000 + 30 * 60_000],
      ['late-clock-in', id(1), 5 * 60_000 + 10 * 60_000],
      ['no-show', id(4), 10 * 60_000 + 30 * 60_000],
      ['late-clock-in', id(4), 10 * 60_000 + 10 * 60_000],
    ]);
    expect(p.armed.every((a) => a.organisationId === ORG && a.workspaceId === WS)).toBe(true);
  });

  it('a row without a workspace (unreachable by the workspace-scoped Worker) and a duplicate row are skipped', async () => {
    const p = producer();
    await armShiftTimerTriggers(p, [cand(1, 60_000, null), cand(2, 60_000), cand(2, 60_000)], opts);
    expect(p.armed.map((a) => a.subjectId)).toEqual([id(2), id(2)]);
  });

  it('only enabled kinds are armed; none enabled → nothing, no publish', async () => {
    const onlyLate = producer(['late-clock-in']);
    await armShiftTimerTriggers(onlyLate, [cand(1, 60_000)], opts);
    expect(onlyLate.armed.map((a) => a.kind)).toEqual(['late-clock-in']);
    const none = producer([]);
    expect(await armShiftTimerTriggers(none, [cand(1, 60_000)], opts)).toEqual({ armed: 0, failed: 0 });
    expect(none.publishNow).not.toHaveBeenCalled();
  });

  it('Redis down: every publish failure is counted, never thrown (the scans are the backstop)', async () => {
    const p = producer(['no-show', 'late-clock-in'], false);
    const recorded: string[] = [];
    await expect(armShiftTimerTriggers(p, [cand(1, 60_000)], { ...opts, recordOutcome: (k, o) => recorded.push(`${k}:${o}`) })).resolves.toEqual({ armed: 0, failed: 2 });
    expect(recorded).toEqual(['no-show:arm-failed', 'late-clock-in:arm-failed']);
  });
});

describe('redisTimerTriggerOutcomeRecorder (D-Q4b outcome counters)', () => {
  function fakeMulti(execResult: () => Promise<unknown>) {
    const calls: unknown[][] = [];
    const chain = {
      hincrby: (...a: unknown[]) => (calls.push(['hincrby', ...a]), chain),
      expire: (...a: unknown[]) => (calls.push(['expire', ...a]), chain),
      exec: () => execResult(),
    };
    return { calls, redis: { multi: () => chain } as never };
  }

  it('HINCRBY <kind>:<outcome> on the Worker-owned hash with its TTL refreshed — counts only, no ids', async () => {
    const { calls, redis } = fakeMulti(async () => []);
    redisTimerTriggerOutcomeRecorder(redis)('no-show', 'acted');
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([
      ['hincrby', TIMER_TRIGGER_OUTCOMES_KEY, 'no-show:acted', 1],
      ['expire', TIMER_TRIGGER_OUTCOMES_KEY, TIMER_TRIGGER_OUTCOMES_TTL_SECONDS],
    ]);
  });

  it('REDIS DOWN at fire time: a failing counter write never throws into the consumer and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { redis } = fakeMulti(() => Promise.reject(new Error('Connection is closed.')));
      expect(() => redisTimerTriggerOutcomeRecorder(redis)('offer-expiry', 'acted')).not.toThrow();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
