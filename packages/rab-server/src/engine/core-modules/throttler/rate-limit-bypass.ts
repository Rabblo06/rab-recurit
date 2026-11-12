/**
 * X1.2 (cleanup audit XA-01 / DUP-03): the ONE switch that turns rate limiting off, `RAB_DISABLE_RATE_LIMIT=true`.
 *
 * Before X1.2 the same predicate was copied into three limiters: skip while `JEST_WORKER_ID` was set and
 * `RAB_DISABLE_RATE_LIMIT !== 'false'`. That was a hidden bypass: `JEST_WORKER_ID` is an ordinary environment variable, not
 * proof of a Jest run, so a service environment carrying it (with the flag unset) ran with no per-IP, login/MFA or
 * attendance limits, and production did not refuse it.
 *
 * Now the bypass is explicit and has exactly one spelling:
 *   1. active only when `RAB_DISABLE_RATE_LIMIT` is exactly `'true'` (unset, `'1'`, `'TRUE'`, ... keep the limits on);
 *      `JEST_WORKER_ID` plays no part;
 *   2. never active in a production runtime (NODE_ENV, RAB_RUNTIME_ENV or DB_TARGET says production, trimmed, any case: a
 *      superset of pg-config's isPgProductionEnvironment), whatever the flag says;
 *   3. a production process refuses to boot while the flag holds anything but unset, blank or `false` (env validation, via
 *      rateLimitBypassProductionProblem below).
 *
 * The Jest setups (rab-server and rab-worker `jest-setup.ts`) set the flag to `'true'`, because the integration suite shares
 * one client IP across hundreds of requests a minute; suites that exercise real throttling set it to `'false'`.
 *
 * Used by exactly three limiters, and no other code may read the flag:
 *   - RabThrottlerModule (the global per-IP tier and the per-route auth tiers),
 *   - LoginAttemptLimiterService (login, MFA code, admin MFA reset),
 *   - AttendancePerUserThrottleGuard (clock in / clock out / geofence exit).
 * InvitationRateLimitService and AiQuotaService have no bypass and must not gain one.
 *
 * Pure: reads only the env object it is given.
 */
import { isPgProductionEnvironment } from '../../../database/postgres/pg-config';

export const RATE_LIMIT_BYPASS_ENV_NAME = 'RAB_DISABLE_RATE_LIMIT';

type Env = Record<string, string | undefined>;

/**
 * Production for this rule: any declaration says so (trimmed, case-insensitive), so a half-declared production counts. A
 * superset of pg-config's isPgProductionEnvironment, which is also consulted so the two can never disagree.
 */
function isProductionRuntime(env: Env): boolean {
  return (
    isPgProductionEnvironment(env) ||
    ['NODE_ENV', 'RAB_RUNTIME_ENV', 'DB_TARGET'].some((name) => env[name]?.trim().toLowerCase() === 'production')
  );
}

/** True only when RAB_DISABLE_RATE_LIMIT is exactly 'true', and never in a production runtime. */
export function isRateLimitBypassEnabled(env: Env = process.env): boolean {
  if (isProductionRuntime(env)) return false;
  return env[RATE_LIMIT_BYPASS_ENV_NAME] === 'true';
}

/**
 * The production boot refusal (env validation): a production runtime may carry RAB_DISABLE_RATE_LIMIT only unset, blank
 * or `false`. Any other value is refused, not just `true`, so a production environment never carries a switch meant to turn
 * the limits off. The variable name only, never its value. Null when nothing is wrong (including every non-production
 * runtime).
 */
export function rateLimitBypassProductionProblem(env: Env): string | null {
  if (!isProductionRuntime(env)) return null;
  const value = env[RATE_LIMIT_BYPASS_ENV_NAME]?.trim();
  if (value === undefined || value === '' || value.toLowerCase() === 'false') return null;
  return `${RATE_LIMIT_BYPASS_ENV_NAME} must not be set in production: it switches off the per-IP, login/MFA and attendance rate limits (a test-only switch). Remove it from the service environment (or set it to false).`;
}
