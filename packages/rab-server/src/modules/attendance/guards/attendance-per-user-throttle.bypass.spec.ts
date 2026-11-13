import { ExecutionContext } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

import { ThrottlerRedisClientProvider } from '../../../engine/core-modules/throttler/throttler-redis-client.provider';
import { AttendancePerUserThrottleGuard } from './attendance-per-user-throttle.guard';

/**
 * X1.2 (audit XA-01 / DUP-03), the attendance limiter (the throttler and login/MFA limiter cases are in
 * engine/core-modules/throttler/rate-limit-bypass.limiters.spec.ts): only the explicit RAB_DISABLE_RATE_LIMIT=true switches a limiter off.
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

describe('AttendancePerUserThrottleGuard (clock in / clock out / geofence exit)', () => {
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ authContext: { userId: '00000000-0000-4000-8000-000000000003' } }) }),
  } as unknown as ExecutionContext;

  it.each(CASES)('%s -> %s', async (_name, env, expected) => {
    applyEnv(env);
    // The 11th request of the window: over the limit of 10.
    const evalScript = jest.fn().mockResolvedValue(11);
    const guard = new AttendancePerUserThrottleGuard({ client: { eval: evalScript } } as unknown as ThrottlerRedisClientProvider);
    if (expected === 'skipped') await expect(guard.canActivate(context)).resolves.toBe(true);
    else await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ThrottlerException);
    expect(evalScript).toHaveBeenCalledTimes(expected === 'skipped' ? 0 : 1);
  });
});
