import * as Sentry from '@sentry/node';

/**
 * Phase B P8 (E6 gates 10, 14; inv-p8 §E): the READ-ONLY daily stuck-workspace alert of the ordinary Worker.
 *
 * Once the privileged worker provisioner is retired, a workspace is built only by its owner's own request
 * (POST /manager-workspaces, resumed / retried from the preparation screen). An owner who never comes back leaves the
 * workspace CREATING (or FAILED) for good, by design — this job is the ONLY signal. It never retries, never provisions and
 * never binds another user's context: it reads two integers from the counts-only SECURITY DEFINER
 * `core.worker_workspace_provisioning_health()` (migration ProvisioningHealth1786721220000) on the runtime
 * `crewflow_app` connection, and alerts when either is above zero:
 *   - Sentry.captureMessage at `warning` level (counts only — no id, name, organisation or e-mail ever exists here to leak)
 *     when Sentry is on (SENTRY_DSN set; `@rab/server/instrument` initialised it in this process);
 *   - always a logger.warn line, so the alert is visible with Sentry off.
 * Fails loudly (the scan's failure counter) if the function is missing — never a silent "all clear".
 *
 * Registration (owner decision C, 2026-10-29): SCAN_JOBS maintenance entry `workspace-provisioning-health`, constant 24 h
 * interval, processor method in maintenance.processors.ts. The runtime drift check drafted with it is deferred (parked in
 * docs/later/hws-prerequisites/).
 */

export const WORKSPACE_PROVISIONING_HEALTH_JOB = 'workspace-provisioning-health';
export const WORKSPACE_PROVISIONING_HEALTH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const WORKSPACE_PROVISIONING_HEALTH_SQL =
  'SELECT creating_over_10_min, failed FROM core.worker_workspace_provisioning_health()';

export interface WorkspaceProvisioningHealthResult {
  creatingOver10Min: number;
  failed: number;
  /** True when either count is above zero (the warn line was written, and Sentry was notified when it is on). */
  alerted: boolean;
  sentNotification: boolean;
}

/** The two side channels, injectable for tests. `captureMessage` is null when Sentry is off. */
export interface ProvisioningHealthAlertSinks {
  warn(message: string): void;
  captureMessage: ((message: string, context: { level: 'warning'; tags: Record<string, string>; extra: Record<string, number>; fingerprint: string[] }) => unknown) | null;
}

/** Real sinks: the Worker's logger, and Sentry only when this process actually initialised a client. */
export function defaultProvisioningHealthSinks(logger: { warn(message: string): void }): ProvisioningHealthAlertSinks {
  return {
    warn: (message) => logger.warn(message),
    captureMessage: Sentry.getClient() ? (message, context) => Sentry.captureMessage(message, context) : null,
  };
}

const UNDEFINED_FUNCTION = '42883';

const toCount = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error('workspace provisioning health: the health function returned a non-count value');
  return n;
};

export async function runWorkspaceProvisioningHealthCycle(
  runtimeDataSource: { query: (sql: string) => Promise<unknown> },
  sinks: ProvisioningHealthAlertSinks,
): Promise<WorkspaceProvisioningHealthResult> {
  let rows: Array<{ creating_over_10_min: unknown; failed: unknown }>;
  try {
    rows = (await runtimeDataSource.query(WORKSPACE_PROVISIONING_HEALTH_SQL)) as typeof rows;
  } catch (error) {
    const code = (error as { code?: string; driverError?: { code?: string } })?.driverError?.code ?? (error as { code?: string })?.code;
    if (code === UNDEFINED_FUNCTION) {
      throw new Error('workspace provisioning health: core.worker_workspace_provisioning_health() is missing (migration ProvisioningHealth1786721220000 not applied)');
    }
    throw error;
  }
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('workspace provisioning health: expected exactly one row');
  const creatingOver10Min = toCount(rows[0]!.creating_over_10_min);
  const failed = toCount(rows[0]!.failed);

  if (creatingOver10Min === 0 && failed === 0) return { creatingOver10Min, failed, alerted: false, sentNotification: false };

  sinks.warn(
    `workspace provisioning health: ${creatingOver10Min} workspace(s) CREATING for more than 10 minutes, ${failed} FAILED ` +
      '(counts only; each is resumed or retried only by its owner signing in to the preparation screen)',
  );
  let sentNotification = false;
  if (sinks.captureMessage) {
    sinks.captureMessage('Workspace provisioning: workspaces stuck CREATING or FAILED', {
      level: 'warning',
      tags: { job: WORKSPACE_PROVISIONING_HEALTH_JOB },
      extra: { creating_over_10_min: creatingOver10Min, failed },
      fingerprint: [WORKSPACE_PROVISIONING_HEALTH_JOB],
    });
    sentNotification = true;
  }
  return { creatingOver10Min, failed, alerted: true, sentNotification };
}
