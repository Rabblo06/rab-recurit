import { validate } from '@rab/server/engine/core-modules/environment/env.validation';

import { isScanJobEnabled, resolveIntervalMs, SCAN_JOBS, schedulerIdOf } from './scan-jobs';
import { buildSchedulerPlan, enabledSchedulerIds, resolveWorkerSchedulerRole, SchedulerRoleError } from './scheduler-plan';
import { dispatchIntervalOf, resolveDispatchConfig } from '../wake/dispatch-config';

/**
 * O3 C2 (owner decision 2026-11-05, "exactly like Twenty"): the API's start-up registration and the Worker build the scan
 * schedule from the SAME plan, so the cadences the API registers are exactly the ones the Worker used to register.
 */
const base = { REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32), PG_DATABASE_URL: 'postgres://crewflow_owner:pg-secret@localhost:5432/rab' };
const envOf = (over: Record<string, string> = {}) => {
  const validated = validate({ ...base, ...over }) as unknown as Record<string, unknown>;
  return { get: (key: string) => validated[key] };
};

/** The fixed scheduler ids (`crewflow:<queue>:<jobName>`), unchanged by O3. */
const EXPECTED_IDS = [
  'crewflow:crewflow-scan-email:email-dispatch',
  'crewflow:crewflow-scan-maintenance:account-invite-cleanup',
  'crewflow:crewflow-scan-maintenance:ai-retention',
  'crewflow:crewflow-scan-maintenance:ai-stale-turn-sweep',
  'crewflow:crewflow-scan-maintenance:login-handoff-cleanup',
  'crewflow:crewflow-scan-maintenance:outbox-retention',
  'crewflow:crewflow-scan-maintenance:storage-cleanup',
  'crewflow:crewflow-scan-maintenance:token-cleanup',
  'crewflow:crewflow-scan-maintenance:workspace-provisioning-health',
  'crewflow:crewflow-scan-offers:manager-confirmation-timeout',
  'crewflow:crewflow-scan-offers:offer-expiry',
  'crewflow:crewflow-scan-offers:replacement-staff',
  'crewflow:crewflow-scan-push:push-dispatch',
  'crewflow:crewflow-scan-realtime:realtime-outbox-publish',
  'crewflow:crewflow-scan-reports:final-timesheet',
  'crewflow:crewflow-scan-reports:payroll-period-attention',
  'crewflow:crewflow-scan-reports:shift-report-scheduler',
  'crewflow:crewflow-scan-reports:shift-statement-dispatch',
  'crewflow:crewflow-scan-shifts:attendance-monitor',
  'crewflow:crewflow-scan-shifts:late-clock-in',
  'crewflow:crewflow-scan-shifts:shift-cancellation-followup',
  'crewflow:crewflow-scan-shifts:shift-monitor',
  'crewflow:crewflow-scan-shifts:shift-scan-combined',
];

describe('scheduler plan (O3 C2: one schedule for the API registration and the Worker)', () => {
  it('every scan keeps its fixed scheduler id; no duplicates', () => {
    const ids = SCAN_JOBS.map(schedulerIdOf);
    expect([...ids].sort()).toEqual(EXPECTED_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['defaults', {}],
    ['event dispatch (Phase D backstop)', { WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_MODE: 'event', WORKER_DISPATCH_BACKSTOP_SECONDS: '45' }],
    ['combined shift scan (Phase D-Q4a)', { WORKER_SHIFT_SCAN_MODE: 'combined' }],
    ['push + realtime on', { PUSH_ENABLED: 'true', REALTIME_ENABLED: 'true', PUSH_PROVIDER: 'FAKE' }],
  ])('identical to the Worker formula it replaces (interval, enable switch): %s', (_label, over) => {
    const env = envOf(over as Record<string, string>);
    const plan = buildSchedulerPlan(env);
    const dispatch = resolveDispatchConfig(env);
    for (const def of SCAN_JOBS) {
      expect(plan.intervalOf(def)).toBe(dispatchIntervalOf(def, resolveIntervalMs(def, env as never), dispatch));
      expect(plan.isEnabled(def)).toBe(isScanJobEnabled(def, env as never));
    }
    expect(plan.jobs).toBe(SCAN_JOBS);
  });

  it('event mode: the four dispatch scans tick at the backstop; combined mode: only the combined shift scan is enabled', () => {
    const event = buildSchedulerPlan(envOf({ WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_MODE: 'event', WORKER_DISPATCH_BACKSTOP_SECONDS: '45' }));
    expect(event.intervalOf(SCAN_JOBS.find((d) => d.jobName === 'email-dispatch')!)).toBe(45_000);
    const combined = buildSchedulerPlan(envOf({ WORKER_SHIFT_SCAN_MODE: 'combined' }));
    expect(combined.shiftScanMode).toBe('combined');
    const ids = enabledSchedulerIds(combined);
    expect(ids).toContain('crewflow:crewflow-scan-shifts:shift-scan-combined');
    expect(ids).not.toContain('crewflow:crewflow-scan-shifts:shift-monitor');
    expect(enabledSchedulerIds(buildSchedulerPlan(envOf()))).not.toContain('crewflow:crewflow-scan-shifts:shift-scan-combined');
  });

  it('prefix: crewflow:<NODE_ENV>:bull unless BULLMQ_PREFIX', () => {
    expect(buildSchedulerPlan(envOf()).prefix).toBe('crewflow:development:bull');
    expect(buildSchedulerPlan(envOf({ NODE_ENV: 'test' })).prefix).toBe('crewflow:test:bull');
    expect(buildSchedulerPlan(envOf({ BULLMQ_PREFIX: 'crewflow:qa:bull' })).prefix).toBe('crewflow:qa:bull');
  });

  it('fails closed on an invalid shift scan mode (nothing scheduled)', () => {
    const env = envOf();
    expect(() => buildSchedulerPlan({ get: (k) => (k === 'WORKER_SHIFT_SCAN_MODE' ? 'both' : env.get(k)) })).toThrow(/WORKER_SHIFT_SCAN_MODE/);
  });
});

describe('the Worker scheduler role (O3 C2)', () => {
  const role = (values: Record<string, unknown>) => resolveWorkerSchedulerRole({ get: (k) => values[k] });

  it('development/test: interval by default; bullmq registers unless DISABLE_CRON_JOBS_REGISTRATION=true', () => {
    expect(role({ NODE_ENV: 'development' })).toBe('interval');
    expect(role({ NODE_ENV: 'test', WORKER_SCHEDULER: 'interval' })).toBe('interval');
    expect(role({ NODE_ENV: 'development', WORKER_SCHEDULER: 'bullmq' })).toBe('register');
    expect(role({ NODE_ENV: 'development', WORKER_SCHEDULER: 'bullmq', DISABLE_CRON_JOBS_REGISTRATION: true })).toBe('consume');
    expect(role({ NODE_ENV: 'development', WORKER_SCHEDULER: 'bullmq', DISABLE_CRON_JOBS_REGISTRATION: 'true' })).toBe('consume');
  });

  it('production: bullmq by default; with DISABLE_CRON_JOBS_REGISTRATION=true the Worker only consumes (never registers)', () => {
    expect(role({ NODE_ENV: 'production' })).toBe('register');
    expect(role({ NODE_ENV: 'production', DISABLE_CRON_JOBS_REGISTRATION: true })).toBe('consume');
    expect(role({ NODE_ENV: 'production', WORKER_SCHEDULER: 'bullmq', DISABLE_CRON_JOBS_REGISTRATION: false })).toBe('register');
  });

  it('refuses: interval in production; interval with DISABLE_CRON_JOBS_REGISTRATION=true; invalid values', () => {
    expect(() => role({ NODE_ENV: 'production', WORKER_SCHEDULER: 'interval' })).toThrow(SchedulerRoleError);
    expect(() => role({ NODE_ENV: 'development', DISABLE_CRON_JOBS_REGISTRATION: true })).toThrow(/requires WORKER_SCHEDULER=bullmq/);
    expect(() => role({ NODE_ENV: 'development', WORKER_SCHEDULER: 'cron' })).toThrow(/WORKER_SCHEDULER must be exactly/);
    expect(() => role({ NODE_ENV: 'development', WORKER_SCHEDULER: 'bullmq', DISABLE_CRON_JOBS_REGISTRATION: 'yes' })).toThrow(/DISABLE_CRON_JOBS_REGISTRATION must be exactly/);
  });
});
