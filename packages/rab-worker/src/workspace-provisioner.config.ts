/**
 * Phase A (pa-provisioner): start-up configuration of the workspace provisioner entrypoint (workspace-provisioner.main.ts).
 * Pure — reads only the environment object it is given, opens nothing. Errors name variables, never values.
 *
 * WHETHER IT PROVISIONS
 *   CREWFLOW_PROVISIONER_ENABLED  strict: "true" | "false" | unset/empty. Any other value refuses to start.
 *     "true"   provision. This is what the Worker bundle launcher sets on its provisioner child; the launcher starts that
 *              child unless the service itself sets CREWFLOW_PROVISIONER_ENABLED=false (unset = the pre-Phase-A
 *              behaviour, provisioner on; start-worker-bundle.cjs).
 *     "false"  never provision (an explicit opt-out wins over HWS_RUNTIME_ENABLED).
 *     unset    legacy standalone behaviour, unchanged: provision only when HWS_RUNTIME_ENABLED=true (the original gate; the
 *              nx `provision` target and the standalone integration specs rely on it).
 *   Not provisioning = exit 0 BEFORE any database or Redis connection is opened (it used to probe the privileged database
 *   identity and ping Redis first).
 *
 * ENABLED BUT HWS_RUNTIME_ENABLED IS NOT "true" — ASSUMPTION FLAGGED FOR THE OWNER: provision normally. HWS_RUNTIME_ENABLED
 * is runtime ROUTING (gate G4), not a provisioning switch. Production and QA run routing OFF and still need this
 * reconciler: it is the only path that builds `createFor` (Initial Manager) workspaces everywhere, and the only path that
 * builds ANY workspace in production, where server-path provisioning (core.provision_workspace) is not approved
 * (docker-compose.production.yml, WORKSPACE PROVISIONING PATH). Before Phase A the launcher made that work by forcing
 * HWS_RUNTIME_ENABLED=true on this child; it now passes the real value through and enables provisioning with the explicit
 * opt-in instead. Refusing (or idling) here would leave every new production workspace CREATING forever.
 *
 * HOW OFTEN
 *   WORKSPACE_PROVISIONER_INTERVAL_SECONDS  whole seconds, PROVISIONER_INTERVAL_MIN_SECONDS..PROVISIONER_INTERVAL_MAX_SECONDS,
 *   default PROVISIONER_INTERVAL_DEFAULT_SECONDS (PROVISIONER_INTERVAL_LEGACY_DEFAULT_SECONDS = the old fixed 5 s when
 *   enabled by the legacy HWS gate). Out of range or not a whole number refuses to start. Was a fixed 5 s.
 *   The launcher validates the same bounds (start-worker-bundle.cjs PROVISIONER_INTERVAL; launcher.test.cjs A7 reconciles
 *   the two). The maximum keeps a settled cycle inside the bundle health check's 5-minute provisioner window.
 */

export const PROVISIONER_INTERVAL_DEFAULT_SECONDS = 60;
/** The pre-Phase-A fixed cadence: still the default when provisioning is enabled by the legacy HWS_RUNTIME_ENABLED gate. */
export const PROVISIONER_INTERVAL_LEGACY_DEFAULT_SECONDS = 5;
export const PROVISIONER_INTERVAL_MIN_SECONDS = 5;
export const PROVISIONER_INTERVAL_MAX_SECONDS = 120;

export class ProvisionerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionerConfigError';
  }
}

export interface ProvisionerConfig {
  /** Whether this process provisions at all. False → exit 0 before opening any connection. */
  provision: boolean;
  /** Which switch enabled provisioning (start-up log only). Null when not provisioning. */
  enabledBy: 'CREWFLOW_PROVISIONER_ENABLED' | 'HWS_RUNTIME_ENABLED' | null;
  /** HWS_RUNTIME_ENABLED exactly as received (passed through by the launcher; informational here). */
  hwsRuntimeEnabled: string | null;
  intervalSeconds: number;
  intervalMs: number;
}

function parseSwitch(env: NodeJS.ProcessEnv): boolean | null {
  const raw = env.CREWFLOW_PROVISIONER_ENABLED;
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ProvisionerConfigError('CREWFLOW_PROVISIONER_ENABLED must be "true" or "false" (unset or empty = follow HWS_RUNTIME_ENABLED). Refusing to start.');
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

/** Throws ProvisionerConfigError for an invalid switch or interval (fail closed). */
export function resolveProvisionerConfig(env: NodeJS.ProcessEnv): ProvisionerConfig {
  const explicit = parseSwitch(env);
  const hws = env.HWS_RUNTIME_ENABLED ?? null;
  // Integration hardening: a standalone provisioner enabled by the legacy HWS gate keeps the old 5 s cadence unless the
  // interval is set; only the explicit switch gets the Phase A 60 s default.
  const legacyGate = explicit === null && hws === 'true';
  const intervalSeconds = parseInterval(env, legacyGate ? PROVISIONER_INTERVAL_LEGACY_DEFAULT_SECONDS : PROVISIONER_INTERVAL_DEFAULT_SECONDS);
  let provision: boolean;
  let enabledBy: ProvisionerConfig['enabledBy'];
  if (explicit === true) {
    provision = true;
    enabledBy = 'CREWFLOW_PROVISIONER_ENABLED';
  } else if (explicit === false) {
    provision = false;
    enabledBy = null;
  } else {
    provision = hws === 'true';
    enabledBy = provision ? 'HWS_RUNTIME_ENABLED' : null;
  }
  return { provision, enabledBy, hwsRuntimeEnabled: hws, intervalSeconds, intervalMs: intervalSeconds * 1000 };
}
