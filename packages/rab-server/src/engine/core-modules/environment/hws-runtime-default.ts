import { isProductionRuntime } from '../throttler/rate-limit-bypass';

/**
 * Part C1 (OWNER-DB-ULTIMATE.md Part C, HWS-AUDIT.md §5.1): the ONE rule for what `HWS_RUNTIME_ENABLED` means, shared by the
 * environment class (environment-variables.ts, API + Worker + commands) and the standalone workspace provisioner
 * (rab-worker/src/workspace-provisioner.config.ts), which reads the raw environment before any Nest module exists.
 *
 *   "true"            → on
 *   "false"           → off
 *   unset (or empty)  → on in development and test; OFF in production (fail safe: production must not flip to the
 *                       workspace schemas before the C3 cutover has copied and verified the data). Production = ANY
 *                       production signal: NODE_ENV, RAB_RUNTIME_ENV or DB_TARGET equal to "production" (trimmed, any
 *                       case; the repo's one predicate, throttler/rate-limit-bypass.ts isProductionRuntime), so a
 *                       half-declared production (e.g. NODE_ENV=development with DB_TARGET=production) is still off.
 *                       Otherwise NODE_ENV unset counts as development (the environment class's own default); any NODE_ENV
 *                       value other than development / test also means off.
 *   anything else     → returned unchanged, so `@IsBoolean()` refuses it and the process does not boot (no "yes", "1",
 *                       "TRUE": a typo never silently picks either mode).
 *
 * Pure: no I/O, never reads process.env itself; callers pass the WHOLE raw environment.
 */
export function resolveHwsRuntimeEnabled(raw: unknown, env: Readonly<Record<string, unknown>> | null | undefined): unknown {
  if (raw === undefined || raw === null || raw === '') return hwsRuntimeDefault(env);
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return raw;
}

const PRODUCTION_SIGNALS = ['NODE_ENV', 'RAB_RUNTIME_ENV', 'DB_TARGET'] as const;

/** The value `HWS_RUNTIME_ENABLED` takes when it is not set, for a given raw environment. */
export function hwsRuntimeDefault(env: Readonly<Record<string, unknown>> | null | undefined): boolean {
  const signals: Record<string, string | undefined> = {};
  for (const name of PRODUCTION_SIGNALS) {
    const value = env?.[name];
    signals[name] = typeof value === 'string' ? value : undefined;
  }
  // A non-string production signal cannot be read safely: treat it as production (fail safe, off).
  if (PRODUCTION_SIGNALS.some((name) => env?.[name] !== undefined && env?.[name] !== null && typeof env?.[name] !== 'string')) return false;
  if (isProductionRuntime(signals)) return false;
  const nodeEnv = signals.NODE_ENV;
  return nodeEnv === undefined || nodeEnv === '' || nodeEnv === 'development' || nodeEnv === 'test';
}
