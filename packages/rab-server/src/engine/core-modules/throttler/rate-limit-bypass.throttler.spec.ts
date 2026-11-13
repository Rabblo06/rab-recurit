import * as fs from 'fs';
import * as path from 'path';
import { ExecutionContext } from '@nestjs/common';
import Redis from 'ioredis';

import type { EnvironmentService } from '../environment/environment.service';
import { rabThrottlerOptions } from './throttler-options.factory';
import type { ThrottlerRedisClientProvider } from './throttler-redis-client.provider';

/**
 * X1.2 (audit XA-01 / DUP-03), RabThrottlerModule (the global per-IP tier and the per-route auth tiers): its real options
 * factory, the one the module passes to ThrottlerModule.forRootAsync, skips throttling only with the explicit
 * RAB_DISABLE_RATE_LIMIT=true, outside production. JEST_WORKER_ID is set in this process, i.e. the old hidden bypass.
 *
 * The Redis client never connects (lazyConnect): only the skip predicate is exercised.
 */
const TOUCHED = ['RAB_DISABLE_RATE_LIMIT', 'NODE_ENV', 'RAB_RUNTIME_ENV', 'DB_TARGET'] as const;
let saved: Record<string, string | undefined>;
let client: Redis;
let skipIf: (context: ExecutionContext) => boolean;

beforeAll(() => {
  client = new Redis({ lazyConnect: true });
  const options = rabThrottlerOptions(
    { client } as unknown as ThrottlerRedisClientProvider,
    { trustedProxyCidrs: [] } as unknown as EnvironmentService,
  ) as { skipIf?: (context: ExecutionContext) => boolean };
  expect(options.skipIf).toBeInstanceOf(Function);
  skipIf = options.skipIf!;
});
afterAll(() => client.disconnect());

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((name) => [name, process.env[name]]));
  delete process.env.RAB_RUNTIME_ENV;
  delete process.env.DB_TARGET;
  process.env.NODE_ENV = 'test';
});
afterEach(() => {
  for (const name of TOUCHED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const context = {} as ExecutionContext;

describe('RabThrottlerModule skip predicate (X1.2)', () => {
  it.each<[string, Record<string, string | undefined>, boolean]>([
    ['off by default: flag unset, JEST_WORKER_ID set (the old hidden bypass)', { RAB_DISABLE_RATE_LIMIT: undefined }, false],
    ['off with the flag false', { RAB_DISABLE_RATE_LIMIT: 'false' }, false],
    ['off with a flag that is not exactly true', { RAB_DISABLE_RATE_LIMIT: '1' }, false],
    ['on only with the explicit flag, outside production', { RAB_DISABLE_RATE_LIMIT: 'true' }, true],
    ['never in production (NODE_ENV)', { RAB_DISABLE_RATE_LIMIT: 'true', NODE_ENV: 'production' }, false],
    ['never in production (RAB_RUNTIME_ENV)', { RAB_DISABLE_RATE_LIMIT: 'true', RAB_RUNTIME_ENV: 'production' }, false],
    ['never in production (DB_TARGET)', { RAB_DISABLE_RATE_LIMIT: 'true', DB_TARGET: 'production' }, false],
  ])('%s -> skip %s', (_name, env, expected) => {
    expect(process.env.JEST_WORKER_ID).toBeDefined();
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    expect(skipIf(context)).toBe(expected);
  });

  it('is read per request, so flipping the flag at runtime takes effect immediately', () => {
    process.env.RAB_DISABLE_RATE_LIMIT = 'true';
    expect(skipIf(context)).toBe(true);
    delete process.env.RAB_DISABLE_RATE_LIMIT;
    expect(skipIf(context)).toBe(false);
  });

  it('is the factory RabThrottlerModule actually uses', () => {
    const moduleSource = fs.readFileSync(path.join(__dirname, 'throttler.module.ts'), 'utf8');
    expect(moduleSource).toMatch(/useFactory:\s*rabThrottlerOptions\b/);
    expect(moduleSource).not.toMatch(/skipIf/);
  });
});
