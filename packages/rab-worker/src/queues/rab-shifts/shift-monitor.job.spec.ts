import { runShiftMonitorCycle } from './shift-monitor.job';

/**
 * Phase D (D6) — the measured re-load loop (cost harness d0-baseline idle-O200, pg_stat_statements: Shift, ShiftAssignment,
 * User and StaffProfile entity loads ≈ 920/min EACH + `INSERT … core.worker_event … ON CONFLICT DO NOTHING` ≈ 460/min) is
 * the shift monitor's reminder path: every 5 min it re-discovers every confirmed assignment starting within 24 h and, for
 * each, loads the 4 entities (Pass A's `first`), loads them AGAIN per applicable window, and INSERTs the window's
 * worker_event — which conflicts (the window was claimed on an earlier tick) and returns nothing.
 *
 * The short-circuit: one read of the assignment's effective start + which of its window event keys already exist. When
 * EVERY window that applies right now already has its worker_event row, the existing code could only reach `continue` for
 * each of them (the UNIQUE claim returns null), so the candidate is skipped before any entity load. Otherwise — a window
 * still unclaimed, the no-show path (shift started), or the assignment not visible — the existing code runs unchanged.
 */
const ORG = '00000000-0000-4000-8000-00000000000a';
const WS = '00000000-0000-4000-8000-0000000000a1';
const SA = '00000000-0000-4000-8000-0000000000b1';
const HOUR = 3_600_000;

function harness(opts: { startsInMs: number; claimed: string[]; period?: string | null; visible?: boolean }) {
  const statements: string[] = [];
  const findOne = jest.fn(async () => null);
  const startsAt = new Date(Date.now() + opts.startsInMs);
  const endsAt = new Date(startsAt.getTime() + 8 * HOUR);
  const respond = (sql: string, params: unknown[] = []): unknown => {
    statements.push(sql);
    if (sql.includes('worker_list_workspaces')) return pageServed++ === 0 ? [{ workspace_id: WS, organisation_id: ORG }] : [];
    if (sql.includes('UNION ALL')) return [{ assignment_id: SA, organisation_id: ORG, workspace_id: WS, starts_at: startsAt.toISOString() }];
    if (sql.includes('FROM core.worker_event we')) {
      if (opts.visible === false) return [];
      const keys = params[1] as string[];
      return [{ period: opts.period ?? null, starts_at: startsAt, ends_at: endsAt, claimed: keys.filter((k) => opts.claimed.includes(k)) }];
    }
    if (sql.startsWith('INSERT INTO core.worker_event')) return [];
    return [];
  };
  let pageServed = 0;
  const manager = { query: async (sql: string, params?: unknown[]) => respond(sql, params), findOne };
  const tenant = { runInTenantContext: async <T>(_ctx: unknown, fn: (m: unknown) => Promise<T>) => fn(manager) };
  const dataSource = { transaction: async <T>(fn: (m: unknown) => Promise<T>) => fn(manager) };
  const notifications = { notify: jest.fn() };
  const audit = { record: jest.fn() };
  return { statements, findOne, run: () => runShiftMonitorCycle(dataSource as never, tenant as never, notifications as never, audit as never, 15) };
}

describe('shift monitor — D6 idempotency short-circuit', () => {
  it('every applicable window already claimed → no entity load and no worker_event INSERT (one read instead)', async () => {
    // 1 h before start: the 24 h and 2 h windows apply (30 min and the 15-min clock-in window do not yet).
    const h = harness({ startsInMs: HOUR, claimed: [`shift-reminder-24h:${SA}`, `shift-reminder-2h:${SA}`] });
    await expect(h.run()).resolves.toMatchObject({ remindersSent: 0, noShowsFlagged: 0 });
    expect(h.findOne).not.toHaveBeenCalled();
    expect(h.statements.filter((s) => s.startsWith('INSERT INTO core.worker_event'))).toHaveLength(0);
    expect(h.statements.filter((s) => s.includes('FROM core.worker_event we'))).toHaveLength(1);
  });

  it('a window that applies but is NOT claimed yet → the existing path runs (entities loaded, Pass A, claim)', async () => {
    const h = harness({ startsInMs: HOUR, claimed: [`shift-reminder-24h:${SA}`] });
    await h.run();
    expect(h.findOne).toHaveBeenCalled();
  });

  it('more than 24 h away (no window applies yet) → skipped without loads, exactly like the existing code\'s empty loop', async () => {
    const h = harness({ startsInMs: 24 * HOUR + 5 * 60_000, claimed: [] });
    await h.run();
    expect(h.findOne).not.toHaveBeenCalled();
  });

  it('the shift already started (no-show path) → existing code, unchanged', async () => {
    const h = harness({ startsInMs: -2 * HOUR, claimed: [] });
    await h.run();
    expect(h.findOne).toHaveBeenCalled();
  });

  it('the assignment is not visible in its scope → existing code (which returns nothing) runs, nothing skipped silently', async () => {
    const h = harness({ startsInMs: HOUR, claimed: [], visible: false });
    await h.run();
    expect(h.findOne).toHaveBeenCalled();
  });

  it('the effective start honours assignment.period exactly as effectiveAssignmentTime does', async () => {
    // The parent shift starts in 1 h but this assignment's own period starts in 30 h: no window applies → skipped.
    const from = new Date(Date.now() + 30 * HOUR).toISOString();
    const to = new Date(Date.now() + 38 * HOUR).toISOString();
    const h = harness({ startsInMs: HOUR, claimed: [], period: `["${from}","${to}")` });
    await h.run();
    expect(h.findOne).not.toHaveBeenCalled();
  });
});
