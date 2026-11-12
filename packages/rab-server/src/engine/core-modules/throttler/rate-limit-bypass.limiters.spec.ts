import { AuthCacheRedisClientProvider } from '../auth/services/auth-cache-redis-client.provider';
import { LoginAttemptLimiterService } from '../auth/services/login-attempt-limiter.service';
import { EnvironmentService } from '../environment/environment.service';

/**
 * X1.2 (audit XA-01 / DUP-03), the login/MFA limiter. The attendance guard's twin is
 * modules/attendance/guards/attendance-per-user-throttle.bypass.spec.ts (engine/ never imports modules/). RabThrottlerModule
 * is covered by rate-limiting.integration.spec.ts (JEST_WORKER_ID + flag unset -> 429 over HTTP) and the source check in
 * rate-limit-bypass.spec.ts (importing the module here would boot ConfigModule's env validation): only the explicit RAB_DISABLE_RATE_LIMIT=true switches a limiter off.
 * JEST_WORKER_ID is set in this process (Jest always sets it), which is exactly the old hidden bypass: with the flag unset,
 * each limiter must now reach its store. And a production runtime never honours the flag.
 *
 * No Redis needed: the stores are fakes that record whether they were reached.
 */
type Case = [string, Record<string, string | undefined>, 'skipped' | 'enforced'];
const CASES: Case[] = [
  ['flag true (the Jest setup)', { RAB_DISABLE_RATE_LIMIT: 'true' }, 'skipped'],
  ['flag unset, JEST_WORKER_ID set (the old hidden bypass)', { RAB_DISABLE_RATE_LIMIT: undefined }, 'enforced'],
  ['flag false', { RAB_DISABLE_RATE_LIMIT: 'false' }, 'enforced'],
  ['flag 1 (not exactly true)', { RAB_DISABLE_RATE_LIMIT: '1' }, 'enforced'],
  ['flag true in a production runtime (NODE_ENV)', { RAB_DISABLE_RATE_LIMIT: 'true', NODE_ENV: 'production' }, 'enforced'],
  ['flag true in a production runtime (RAB_RUNTIME_ENV)', { RAB_DISABLE_RATE_LIMIT: 'true', RAB_RUNTIME_ENV: 'production' }, 'enforced'],
];

const TOUCHED = ['RAB_DISABLE_RATE_LIMIT', 'NODE_ENV', 'RAB_RUNTIME_ENV', 'DB_TARGET'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((name) => [name, process.env[name]]));
  delete process.env.RAB_RUNTIME_ENV;
  delete process.env.DB_TARGET;
});
afterEach(() => {
  for (const name of TOUCHED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function applyEnv(env: Record<string, string | undefined>): void {
  expect(process.env.JEST_WORKER_ID).toBeDefined();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

describe('LoginAttemptLimiterService (login, MFA code, admin MFA reset)', () => {
  const build = () => {
    const outage = jest.fn().mockRejectedValue(new Error('store reached'));
    const redis = { client: { exists: outage, eval: outage } } as unknown as AuthCacheRedisClientProvider;
    const env = { get: (name: string) => (name === 'NODE_ENV' ? 'test' : 5) } as unknown as EnvironmentService;
    return { limiter: new LoginAttemptLimiterService(redis, env), outage };
  };

  it.each(CASES)('%s -> %s', async (_name, env, expected) => {
    applyEnv(env);
    const { limiter, outage } = build();
    const calls = [
      () => limiter.admit('person@example.test', '203.0.113.9'),
      () => limiter.admitSecondFactor('00000000-0000-4000-8000-000000000001'),
      () => limiter.admitAdminMfaReset('00000000-0000-4000-8000-000000000002'),
    ];
    for (const call of calls) {
      if (expected === 'skipped') await expect(call()).resolves.toBeUndefined();
      // Enforced: the limiter consulted its store (here: unavailable, so the existing fail-closed 503).
      else await expect(call()).rejects.toMatchObject({ status: 503 });
    }
    expect(outage).toHaveBeenCalledTimes(expected === 'skipped' ? 0 : calls.length);
  });
});
