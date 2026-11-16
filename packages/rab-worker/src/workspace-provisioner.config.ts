/**
 * The interval of the Worker's IN-PROCESS workspace provisioning loop (owner-login architecture, T4). Pure: reads only the
 * environment object it is given, opens nothing. Errors name variables, never values.
 *
 *   WORKSPACE_PROVISIONER_INTERVAL_SECONDS  whole seconds, PROVISIONER_INTERVAL_MIN_SECONDS..PROVISIONER_INTERVAL_MAX_SECONDS,
 *   default PROVISIONER_INTERVAL_DEFAULT_SECONDS. Out of range or not a whole number refuses to start (fail closed). The
 *   maximum keeps a settled cycle inside the health check's 5-minute provisioner window.
 *
 * X5.1: the superseded standalone provisioner process (workspace-provisioner.main.ts, nx target `rab-worker:provision`) and
 * its start-up switch (resolveProvisionerConfig: CREWFLOW_PROVISIONER_ENABLED / the legacy HWS_RUNTIME_ENABLED gate) were
 * removed. The Worker always provisions in-process; CREWFLOW_PROVISIONER_* stays refused on the Worker
 * (never-in-runtime-env.ts).
 */

export const PROVISIONER_INTERVAL_DEFAULT_SECONDS = 60;
export const PROVISIONER_INTERVAL_MIN_SECONDS = 5;
export const PROVISIONER_INTERVAL_MAX_SECONDS = 120;

export class ProvisionerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionerConfigError';
  }
}

function parseInterval(env: NodeJS.ProcessEnv, defaultSeconds: number): number {
  const raw = env.WORKSPACE_PROVISIONER_INTERVAL_SECONDS;
  if (raw === undefined || raw.trim() === '') return defaultSeconds;
  const text = raw.trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < PROVISIONER_INTERVAL_MIN_SECONDS || n > PROVISIONER_INTERVAL_MAX_SECONDS) {
    throw new ProvisionerConfigError(
      `WORKSPACE_PROVISIONER_INTERVAL_SECONDS must be a whole number of seconds from ${PROVISIONER_INTERVAL_MIN_SECONDS} to ${PROVISIONER_INTERVAL_MAX_SECONDS}. Refusing to start.`,
    );
  }
  return n;
}

/**
 * Owner-login architecture (T4): the Worker runs workspace provisioning IN-PROCESS, always — it is the only path that builds
 * `createFor` workspaces everywhere and any workspace in production. There is no on/off switch (CREWFLOW_PROVISIONER_* is
 * refused on the Worker); only the interval: WORKSPACE_PROVISIONER_INTERVAL_SECONDS (5..120, default 60; production and QA
 * compose pin 5 for onboarding). Throws ProvisionerConfigError (names only).
 */
export function resolveInProcessProvisioningInterval(env: NodeJS.ProcessEnv): { intervalSeconds: number; intervalMs: number } {
  const intervalSeconds = parseInterval(env, PROVISIONER_INTERVAL_DEFAULT_SECONDS);
  return { intervalSeconds, intervalMs: intervalSeconds * 1000 };
}
