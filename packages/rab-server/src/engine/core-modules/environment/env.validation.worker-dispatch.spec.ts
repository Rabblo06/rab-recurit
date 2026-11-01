import { validate } from './env.validation';

/**
 * Phase D (D1/D2) Worker dispatch flags — interface contract: WORKER_CLAIM_MODE per_scope|global (default per_scope),
 * WORKER_DISPATCH_MODE poll|event (default poll), backstop 10–120 s (default 30), legacy reconciliation 60–900 s
 * (default 900; owner 2026-11-01: a longer interval needs separate approval, no override), claim batch 1–200 (default 100). event without global refuses to boot. The "global ⇒ the live role is
 * crewflow_worker" rule needs the database and lives in the boot gate (database-boot-gate-rules.ts).
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('worker dispatch environment variables (Phase D)', () => {
  it('defaults: per_scope claims, poll dispatch, 30 s backstop, 900 s reconciliation, batch 100 — other defaults unchanged', () => {
    const env = validate({ ...base });
    expect(env).toMatchObject({
      WORKER_CLAIM_MODE: 'per_scope',
      WORKER_DISPATCH_MODE: 'poll',
      WORKER_DISPATCH_BACKSTOP_SECONDS: 30,
      WORKER_DISPATCH_RECONCILE_SECONDS: 900,
      WORKER_DISPATCH_CLAIM_BATCH: 100,
      WORKER_SCHEDULER: 'interval',
      REALTIME_ENABLED: false,
      PUSH_ENABLED: false,
    });
  });

  it('accepts the supported combinations: per_scope+poll, global+poll, global+event', () => {
    expect(validate({ ...base, WORKER_CLAIM_MODE: 'per_scope', WORKER_DISPATCH_MODE: 'poll' })).toBeDefined();
    expect(validate({ ...base, WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_MODE: 'poll' }).WORKER_CLAIM_MODE).toBe('global');
    expect(validate({ ...base, WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_MODE: 'event' }).WORKER_DISPATCH_MODE).toBe('event');
  });

  it('refuses event dispatch without global claims (explicit per_scope or the default)', () => {
    expect(() => validate({ ...base, WORKER_DISPATCH_MODE: 'event' })).toThrow(/WORKER_DISPATCH_MODE=event requires WORKER_CLAIM_MODE=global/);
    expect(() => validate({ ...base, WORKER_CLAIM_MODE: 'per_scope', WORKER_DISPATCH_MODE: 'event' })).toThrow(
      /WORKER_DISPATCH_MODE=event requires WORKER_CLAIM_MODE=global/,
    );
  });

  it.each(['Global', 'perscope', 'per-scope', 'true', 'global '])('refuses WORKER_CLAIM_MODE=%p', (value) => {
    expect(() => validate({ ...base, WORKER_CLAIM_MODE: value })).toThrow(/WORKER_CLAIM_MODE/);
  });

  it.each(['Event', 'listen', 'notify', 'poll '])('refuses WORKER_DISPATCH_MODE=%p', (value) => {
    expect(() => validate({ ...base, WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_MODE: value })).toThrow(/WORKER_DISPATCH_MODE/);
  });

  it.each([
    ['WORKER_DISPATCH_BACKSTOP_SECONDS', ['9', '121', '0', '30.5', 'abc']],
    ['WORKER_DISPATCH_RECONCILE_SECONDS', ['59', '901', '3600', '86400', '0', 'x']],
    ['WORKER_DISPATCH_CLAIM_BATCH', ['0', '201', '-1', '1.5', 'many']],
  ] as const)('refuses out-of-range %s', (name, values) => {
    for (const value of values) expect(() => validate({ ...base, [name]: value })).toThrow(new RegExp(name));
  });

  it('WORKER_DISPATCH_RECONCILE_SECONDS above 900 refuses to boot with a message naming the 900 s maximum (no override)', () => {
    expect(() => validate({ ...base, WORKER_DISPATCH_RECONCILE_SECONDS: '901' })).toThrow(/WORKER_DISPATCH_RECONCILE_SECONDS must be at most 900/);
    expect(() => validate({ ...base, WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_RECONCILE_SECONDS: '86400' })).toThrow(/at most 900/);
  });

  it('accepts the range bounds', () => {
    const low = validate({ ...base, WORKER_DISPATCH_BACKSTOP_SECONDS: '10', WORKER_DISPATCH_RECONCILE_SECONDS: '60', WORKER_DISPATCH_CLAIM_BATCH: '1' });
    expect(low).toMatchObject({ WORKER_DISPATCH_BACKSTOP_SECONDS: 10, WORKER_DISPATCH_RECONCILE_SECONDS: 60, WORKER_DISPATCH_CLAIM_BATCH: 1 });
    const high = validate({ ...base, WORKER_DISPATCH_BACKSTOP_SECONDS: '120', WORKER_DISPATCH_RECONCILE_SECONDS: '900', WORKER_DISPATCH_CLAIM_BATCH: '200' });
    expect(high).toMatchObject({ WORKER_DISPATCH_BACKSTOP_SECONDS: 120, WORKER_DISPATCH_RECONCILE_SECONDS: 900, WORKER_DISPATCH_CLAIM_BATCH: 200 });
  });
});
