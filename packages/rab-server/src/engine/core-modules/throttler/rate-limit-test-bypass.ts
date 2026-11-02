/**
 * X1.4 (cleanup audit DUP-03): the ONE predicate for "skip rate limiting because this is the Jest integration suite".
 *
 * The integration suite shares one client IP across hundreds of logins, clock actions and requests per minute; none of that
 * is the abuse the limiters exist to catch, so jest-setup.ts (both packages) sets RAB_DISABLE_RATE_LIMIT=true for every test
 * file, and the few suites that exercise real throttling set it to 'false'. Used by exactly three limiters:
 *   - RabThrottlerModule (global per-IP tier and the per-route auth tiers),
 *   - LoginAttemptLimiterService (login, MFA code, admin MFA reset),
 *   - AttendancePerUserThrottleGuard (clock in / clock out / geofence exit).
 * InvitationRateLimitService and AiQuotaService have no bypass and must not gain one.
 *
 * What this is NOT: proof that the process is a Jest run. JEST_WORKER_ID and RAB_DISABLE_RATE_LIMIT are ordinary environment
 * variables; anyone who controls a service's environment can set them. So:
 *   1. the bypass needs RAB_DISABLE_RATE_LIMIT to be exactly 'true' AND JEST_WORKER_ID to be non-empty (an unset flag no
 *      longer counts, unlike the old `!== 'false'` copies);
 *   2. it is never active in a production runtime (NODE_ENV or RAB_RUNTIME_ENV says production, trimmed, any case);
 *   3. a production process refuses to boot while either variable is present at all (env.validation.ts,
 *      testRateLimitBypassProductionProblem), so a production deployment cannot carry the switch even dormant.
 * Pure: reads only the env object it is given.
 */
export const RATE_LIMIT_BYPASS_ENV_NAMES = ['JEST_WORKER_ID', 'RAB_DISABLE_RATE_LIMIT'] as const;

type Env = Record<string, string | undefined>;

/** Production for this rule: either declaration says so (trimmed, case-insensitive), so a half-declared production counts. */
function looksLikeProductionRuntime(env: Env): boolean {
  return ['NODE_ENV', 'RAB_RUNTIME_ENV'].some((name) => env[name]?.trim().toLowerCase() === 'production');
}

/** True only inside the Jest suite with the bypass flag on, and never in a production runtime. */
export function isTestRateLimitBypassActive(env: Env = process.env): boolean {
  if (looksLikeProductionRuntime(env)) return false;
  return (env.JEST_WORKER_ID ?? '').trim() !== '' && env.RAB_DISABLE_RATE_LIMIT === 'true';
}

/**
 * The boot refusal (env.validation.ts): a production runtime must not carry either variable, set or blank. Names only,
 * never values. Null when nothing is wrong (including every non-production runtime).
 */
export function testRateLimitBypassProductionProblem(env: Env): string | null {
  if (!looksLikeProductionRuntime(env)) return null;
  const present = RATE_LIMIT_BYPASS_ENV_NAMES.filter((name) => env[name] !== undefined);
  if (present.length === 0) return null;
  return `${present.join(', ')} must not be present in production: together they switch off the per-IP, login/MFA and attendance rate limits (a Jest-only test switch). Remove ${present.length === 1 ? 'it' : 'them'} from the service environment.`;
}
