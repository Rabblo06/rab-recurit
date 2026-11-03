import { buildHandlerRegistry } from '../scheduler/processor-explorer';
import { SCAN_JOBS } from '../scheduler/scan-jobs';
import { buildDispatchBindings, DISPATCH_SCAN_JOBS, dispatchIntervalOf, resolveDispatchConfig, withGlobalDispatch } from './dispatch-wiring';
import { fakeTenant } from '../../__tests__/helpers/dispatch-fakes';

/** Phase D (D1/D2): mode resolution (defaults unchanged, fail closed) and how global mode is wired into the scan registry. */
const env = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });
const def = (jobName: string) => SCAN_JOBS.find((d) => d.jobName === jobName)!;

describe('resolveDispatchConfig', () => {
  it('defaults are today\'s behaviour: per_scope + poll, backstop 30 s, reconcile 900 s, batch 100', () => {
    expect(resolveDispatchConfig(env({}))).toEqual({ claimMode: 'per_scope', dispatchMode: 'poll', backstopSeconds: 30, reconcileSeconds: 900, claimBatch: 100 });
  });

  it('accepts the supported combinations (global+poll, global+event) and numeric strings from the raw environment', () => {
    expect(resolveDispatchConfig(env({ WORKER_CLAIM_MODE: 'global' })).claimMode).toBe('global');
    expect(
      resolveDispatchConfig(env({ WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_MODE: 'event', WORKER_DISPATCH_BACKSTOP_SECONDS: '45', WORKER_DISPATCH_RECONCILE_SECONDS: 60, WORKER_DISPATCH_CLAIM_BATCH: '200' })),
    ).toEqual({ claimMode: 'global', dispatchMode: 'event', backstopSeconds: 45, reconcileSeconds: 60, claimBatch: 200 });
  });

  it('refuses per_scope+event, unknown modes and out-of-range numbers (defence in depth behind env validation)', () => {
    expect(() => resolveDispatchConfig(env({ WORKER_DISPATCH_MODE: 'event' }))).toThrow(/event.*global/);
    expect(() => resolveDispatchConfig(env({ WORKER_CLAIM_MODE: 'GLOBAL' }))).toThrow(/WORKER_CLAIM_MODE/);
    expect(() => resolveDispatchConfig(env({ WORKER_DISPATCH_MODE: 'push' }))).toThrow(/WORKER_DISPATCH_MODE/);
    expect(() => resolveDispatchConfig(env({ WORKER_DISPATCH_BACKSTOP_SECONDS: 9 }))).toThrow(/BACKSTOP/);
    expect(() => resolveDispatchConfig(env({ WORKER_DISPATCH_BACKSTOP_SECONDS: 121 }))).toThrow(/BACKSTOP/);
    expect(() => resolveDispatchConfig(env({ WORKER_DISPATCH_RECONCILE_SECONDS: 59 }))).toThrow(/RECONCILE/);
    // Wave 3 (owner decision): the reconciliation interval is capped at 900 s, matching the server's environment config.
    expect(resolveDispatchConfig(env({ WORKER_DISPATCH_RECONCILE_SECONDS: 900 })).reconcileSeconds).toBe(900);
    expect(() => resolveDispatchConfig(env({ WORKER_DISPATCH_RECONCILE_SECONDS: 901 }))).toThrow(/RECONCILE_SECONDS must be a whole number 60–900/);
    expect(() => resolveDispatchConfig(env({ WORKER_DISPATCH_RECONCILE_SECONDS: 86_400 }))).toThrow(/RECONCILE/);
    expect(() => resolveDispatchConfig(env({ WORKER_DISPATCH_CLAIM_BATCH: 0 }))).toThrow(/CLAIM_BATCH/);
    expect(() => resolveDispatchConfig(env({ WORKER_DISPATCH_CLAIM_BATCH: 1.5 }))).toThrow(/CLAIM_BATCH/);
  });
});

describe('dispatch scan intervals', () => {
  it('maps exactly the four dispatch scans to their pointer queues', () => {
    expect(DISPATCH_SCAN_JOBS).toEqual({ 'email-dispatch': 'email', 'push-dispatch': 'push', 'realtime-outbox-publish': 'realtime', 'shift-statement-dispatch': 'statement' });
    for (const jobName of Object.keys(DISPATCH_SCAN_JOBS)) expect(def(jobName)).toBeDefined();
  });

  it('poll modes keep every scan interval; event mode turns the four dispatch scans into the backstop', () => {
    const perScope = resolveDispatchConfig(env({}));
    const globalPoll = resolveDispatchConfig(env({ WORKER_CLAIM_MODE: 'global' }));
    const event = resolveDispatchConfig(env({ WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_MODE: 'event', WORKER_DISPATCH_BACKSTOP_SECONDS: 30 }));
    for (const d of SCAN_JOBS) {
      expect(dispatchIntervalOf(d, 2_000, perScope)).toBe(2_000);
      expect(dispatchIntervalOf(d, 2_000, globalPoll)).toBe(2_000);
      expect(dispatchIntervalOf(d, 2_000, event)).toBe(d.jobName in DISPATCH_SCAN_JOBS ? 30_000 : 2_000);
    }
  });
});

describe('withGlobalDispatch', () => {
  const handlers = SCAN_JOBS.map((d) => ({ queue: d.queue, jobName: d.jobName, source: `T.${d.jobName}`, handler: jest.fn(async () => `legacy:${d.jobName}`) }));
  const registry = buildHandlerRegistry(handlers);

  it('routes ONLY the bound dispatch scans to the coordinator tick (with the cycle context); every other scan keeps its handler', async () => {
    const coordinator = { queues: ['email', 'statement'], tick: jest.fn(async () => true) };
    const wrapped = withGlobalDispatch(registry, coordinator as never);
    const ctx = { setStat: jest.fn() };
    await expect(wrapped.scan(def('email-dispatch'))(ctx)).resolves.toBe(true);
    expect(coordinator.tick).toHaveBeenCalledWith('email', ctx);
    await wrapped.scan(def('shift-statement-dispatch'))(ctx);
    expect(coordinator.tick).toHaveBeenLastCalledWith('statement', ctx);
    // push is not bound (PUSH_ENABLED=false): its original handler stays (and the scan itself is not registered anyway).
    await expect(wrapped.scan(def('push-dispatch'))()).resolves.toBe('legacy:push-dispatch');
    await expect(wrapped.scan(def('offer-expiry'))()).resolves.toBe('legacy:offer-expiry');
    expect(wrapped.get).toBe(registry.get);
    expect(wrapped.handlers).toBe(registry.handlers);
  });
});

describe('buildDispatchBindings', () => {
  const handlers = SCAN_JOBS.map((d) => ({ queue: d.queue, jobName: d.jobName, source: `T.${d.jobName}`, handler: jest.fn(async () => `legacy:${d.jobName}`) }));
  const registry = buildHandlerRegistry(handlers);
  const ORG = '00000000-0000-4000-8000-00000000000a';
  const R1 = '00000000-0000-4000-8000-000000000001';

  function deps(flags: { PUSH_ENABLED: boolean; REALTIME_ENABLED: boolean }) {
    const { tenant } = fakeTenant((sql) => (sql.includes('FROM core.email_outbox') ? [{ id: R1, organisation_id: ORG, status: 'PENDING', infrastructure_attempt_count: 0, max_infrastructure_attempts: 5, provider_call_started_at: null, dispatch_generation: 0 }] : []));
    return {
      tenantContext: tenant,
      emailQueue: { publish: jest.fn(async () => undefined), republish: jest.fn(async () => undefined) },
      emailService: { ambiguousDeliverySafeToRetry: false },
      pushQueue: { publish: jest.fn(), republish: jest.fn() },
      pushService: { ambiguousDeliverySafeToRetry: false },
      realtimePublish: jest.fn(),
      shiftStatementQueue: { name: 'rab-shift-statements', add: jest.fn() },
      environmentService: { get: (k: string) => ({ ...flags, NODE_ENV: 'test' } as Record<string, unknown>)[k] },
      logger: { log: jest.fn(), warn: jest.fn() },
    };
  }

  it('binds only the ENABLED dispatch queues, each with its ORIGINAL processor handler as the legacy sweep', async () => {
    const flags = { PUSH_ENABLED: false, REALTIME_ENABLED: true };
    const isEnabled = (d: { enabledBy?: string }) => d.enabledBy === undefined || (flags as Record<string, boolean>)[d.enabledBy] === true;
    const bindings = buildDispatchBindings(deps(flags) as never, registry, SCAN_JOBS, isEnabled as never);
    expect(bindings.map((b) => b.queue)).toEqual(['email', 'statement', 'realtime']);
    await expect(bindings[0]!.legacy()).resolves.toBe('legacy:email-dispatch');
  });

  it('the email binding publishes through the SAME queue service calls as the processor (attempt.0 publish for a first attempt)', async () => {
    const d = deps({ PUSH_ENABLED: false, REALTIME_ENABLED: false });
    const [email] = buildDispatchBindings(d as never, registry, SCAN_JOBS, () => true);
    await expect(email!.processScope({ organisationId: ORG, workspaceId: null, subjectIds: [R1], claims: [] })).resolves.toBe(1);
    expect(d.emailQueue.publish).toHaveBeenCalledWith(R1, ORG);
  });
});
