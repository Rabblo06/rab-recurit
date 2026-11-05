import { HealthCheckError } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { registerSecurityReadiness, resetSecurityReadinessForTests, securityReady, startSecurityPostureMonitoring } from './security-readiness';

/**
 * Owner-login architecture: Agent 3's semantic posture monitor and audit sink, wired by the API and the Worker. Drift turns
 * the existing /healthz unready; an invalid sink configuration refuses to start; no baseline = no monitor (said once).
 */
describe('security readiness (posture monitor → /healthz)', () => {
  afterEach(() => resetSecurityReadinessForTests());

  it('ready until a provider says otherwise; a throwing provider is not ready (fail closed)', () => {
    expect(securityReady()).toBe(true);
    let ok = true;
    registerSecurityReadiness(() => ok);
    expect(securityReady()).toBe(true);
    ok = false;
    expect(securityReady()).toBe(false);
    resetSecurityReadinessForTests();
    registerSecurityReadiness(() => {
      throw new Error('boom');
    });
    expect(securityReady()).toBe(false);
  });

  it('/healthz: the database ping AND the security condition; drift makes it fail with reason security-posture-drift', async () => {
    const checks: Array<() => unknown> = [];
    const health = {
      check: async (fns: Array<() => unknown>) => {
        checks.push(...fns);
        return Promise.all(fns.map((f) => f()));
      },
    };
    const db = { pingCheck: async () => ({ database: { status: 'up' } }) };
    const controller = new HealthController(health as never, db as never);
    await expect(controller.check()).resolves.toEqual([{ database: { status: 'up' } }, { security: { status: 'up' } }]);
    registerSecurityReadiness(() => false);
    let thrown: unknown;
    try {
      await controller.check();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HealthCheckError);
    expect((thrown as HealthCheckError).causes).toEqual({ security: { status: 'down', reason: 'security-posture-drift' } });
  });

  it('startSecurityPostureMonitoring: an invalid audit-sink configuration throws (the caller refuses to start); no baseline → no monitor', () => {
    const lines: string[] = [];
    expect(() => startSecurityPostureMonitoring({ dataSource: {} as never, baseline: undefined, processLabel: 'api process', env: { CREWFLOW_AUDIT_SINK: 'nonsense' }, log: (l) => lines.push(l) })).toThrow();
    const started = startSecurityPostureMonitoring({ dataSource: {} as never, baseline: undefined, processLabel: 'api process', env: {}, log: (l) => lines.push(l) });
    expect(started.monitor).toBeNull();
    expect(lines.join('\n')).toMatch(/no boot posture baseline was read/);
    expect(securityReady()).toBe(true);
  });

  it('with a baseline: the monitor is started, registered as readiness, and drift (a changed posture) turns readiness false', async () => {
    const baseline = { sha256: 'a'.repeat(64) } as never;
    const started = startSecurityPostureMonitoring({ dataSource: {} as never, baseline, processLabel: 'worker process', env: {}, log: () => undefined });
    try {
      expect(started.monitor).not.toBeNull();
      expect(securityReady()).toBe(true);
      // Simulate what checkOnce records on drift (the comparison itself is Agent 3's, tested in its own spec).
      (started.monitor as unknown as { state: { ready: boolean } }).state.ready = false;
      expect(securityReady()).toBe(false);
    } finally {
      started.stop();
    }
  });
});
