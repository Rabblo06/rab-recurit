import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import {
  defaultProvisioningHealthSinks,
  ProvisioningHealthAlertSinks,
  runWorkspaceProvisioningHealthCycle,
  WORKSPACE_PROVISIONING_HEALTH_INTERVAL_MS,
  WORKSPACE_PROVISIONING_HEALTH_JOB,
  WORKSPACE_PROVISIONING_HEALTH_SQL,
} from './workspace-provisioning-health.job';

/**
 * Phase B P8 — the daily stuck-workspace alert, against a FAKE counts-only function (the real one is migration
 * ProvisioningHealth1786721220000; the database-backed test is
 * src/__tests__/integration/workspace-provisioning-health.integration.spec.ts).
 */
describe('workspace provisioning health job (Phase B P8)', () => {
  const fakeFunction = (row: Record<string, unknown> | null, error?: unknown) => ({
    calls: [] as string[],
    async query(sql: string) {
      this.calls.push(sql);
      if (error) throw error;
      return row ? [row] : [];
    },
  });
  const sinks = (sentryOn: boolean) => {
    const warn = jest.fn();
    const captureMessage = jest.fn();
    const value: ProvisioningHealthAlertSinks = { warn, captureMessage: sentryOn ? captureMessage : null };
    return { value, warn, captureMessage };
  };

  it('is a 24 h job reading only the counts-only definer (no table, no id, no tenant context)', async () => {
    expect(WORKSPACE_PROVISIONING_HEALTH_INTERVAL_MS).toBe(86_400_000);
    expect(WORKSPACE_PROVISIONING_HEALTH_SQL).toBe('SELECT creating_over_10_min, failed FROM core.worker_workspace_provisioning_health()');
    const db = fakeFunction({ creating_over_10_min: 0, failed: 0 });
    await runWorkspaceProvisioningHealthCycle(db, sinks(true).value);
    expect(db.calls).toEqual([WORKSPACE_PROVISIONING_HEALTH_SQL]);
  });

  it('both counts zero: no warn line, no Sentry event', async () => {
    const s = sinks(true);
    await expect(runWorkspaceProvisioningHealthCycle(fakeFunction({ creating_over_10_min: 0, failed: 0 }), s.value)).resolves.toEqual({
      creatingOver10Min: 0, failed: 0, alerted: false, sentNotification: false,
    });
    expect(s.warn).not.toHaveBeenCalled();
    expect(s.captureMessage).not.toHaveBeenCalled();
  });

  it.each([
    [3, 0],
    [0, 2],
    [4, 1],
  ])('creating=%i failed=%i: Sentry warning with counts only + a warn line', async (creating, failed) => {
    const s = sinks(true);
    const result = await runWorkspaceProvisioningHealthCycle(fakeFunction({ creating_over_10_min: creating, failed }), s.value);
    expect(result).toEqual({ creatingOver10Min: creating, failed, alerted: true, sentNotification: true });
    expect(s.captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = s.captureMessage.mock.calls[0]!;
    expect(message).toBe('Workspace provisioning: workspaces stuck CREATING or FAILED');
    expect(context).toEqual({
      level: 'warning',
      tags: { job: WORKSPACE_PROVISIONING_HEALTH_JOB },
      extra: { creating_over_10_min: creating, failed },
      fingerprint: [WORKSPACE_PROVISIONING_HEALTH_JOB],
    });
    expect(s.warn).toHaveBeenCalledTimes(1);
    expect(s.warn.mock.calls[0]![0]).toContain(`${creating} workspace(s) CREATING for more than 10 minutes, ${failed} FAILED`);
  });

  it('default sinks: Sentry is used only when this process initialised a client (never in this unit test) — compile-time wiring check', () => {
    const logger = new Logger('test');
    const real = defaultProvisioningHealthSinks(logger);
    expect(real.captureMessage).toBeNull();
    // Type-level only: the processor passes the Worker's runtime DataSource and its Nest Logger.
    const wire = (runtimeDataSource: DataSource) => runWorkspaceProvisioningHealthCycle(runtimeDataSource, real);
    expect(typeof wire).toBe('function');
  });

  it('Sentry off: the warn line only', async () => {
    const s = sinks(false);
    const result = await runWorkspaceProvisioningHealthCycle(fakeFunction({ creating_over_10_min: 1, failed: 1 }), s.value);
    expect(result).toMatchObject({ alerted: true, sentNotification: false });
    expect(s.warn).toHaveBeenCalledTimes(1);
  });

  it('the alert never carries anything but the two counts', async () => {
    const s = sinks(true);
    await runWorkspaceProvisioningHealthCycle(fakeFunction({ creating_over_10_min: 2, failed: 5 }), s.value);
    const payload = JSON.stringify([s.captureMessage.mock.calls, s.warn.mock.calls]);
    expect(payload).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}-|subdomain|organisation_id|owner_user_id|email/i);
  });

  it('fails loudly — never an "all clear" — when the function is missing, returns no row, or returns a non-count', async () => {
    const s = sinks(true);
    await expect(runWorkspaceProvisioningHealthCycle(fakeFunction(null, Object.assign(new Error('x'), { code: '42883' })), s.value)).rejects.toThrow(
      /worker_workspace_provisioning_health\(\) is missing/,
    );
    await expect(runWorkspaceProvisioningHealthCycle(fakeFunction(null), s.value)).rejects.toThrow(/exactly one row/);
    await expect(runWorkspaceProvisioningHealthCycle(fakeFunction({ creating_over_10_min: -1, failed: 0 }), s.value)).rejects.toThrow(/non-count/);
    const other = Object.assign(new Error('connection lost'), { code: '08006' });
    await expect(runWorkspaceProvisioningHealthCycle(fakeFunction(null, other), s.value)).rejects.toBe(other);
    expect(s.captureMessage).not.toHaveBeenCalled();
  });
});
