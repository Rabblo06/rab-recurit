/**
 * Part C1 (OWNER-DB-ULTIMATE.md Part C, HWS-AUDIT.md §5.1): the ONE rule for what `HWS_RUNTIME_ENABLED` means, shared by the
 * environment class (environment-variables.ts, API + Worker + commands) and the standalone workspace provisioner
 * (rab-worker/src/workspace-provisioner.config.ts), which reads the raw environment before any Nest module exists.
 *
 *   "true"            → on
 *   "false"           → off
 *   unset (or empty)  → on in development and test; OFF in production (fail safe: production must not flip to the
 *                       workspace schemas before the C3 cutover has copied and verified the data). NODE_ENV unset counts
 *                       as development (the environment class's own default); any NODE_ENV value other than
 *                       development / test also means off.
 *   anything else     → returned unchanged, so `@IsBoolean()` refuses it and the process does not boot (no "yes", "1",
 *                       "TRUE": a typo never silently picks either mode).
 *
 * Pure: no I/O, never reads process.env itself.
 */
export function resolveHwsRuntimeEnabled(raw: unknown, nodeEnv: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return hwsRuntimeDefault(nodeEnv);
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return raw;
}

/** The value `HWS_RUNTIME_ENABLED` takes when it is not set, for a given NODE_ENV (unset/empty = development). */
export function hwsRuntimeDefault(nodeEnv: unknown): boolean {
  return nodeEnv === undefined || nodeEnv === null || nodeEnv === '' || nodeEnv === 'development' || nodeEnv === 'test';
}
