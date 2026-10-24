import { Queue } from 'bullmq';
import type Redis from 'ioredis';

/**
 * `WORKER_SCHEDULER=bullmq` start-up preflight (Lane A M4). Refuses to start bullmq mode unless the Redis it is about to
 * keep its schedulers in is safe for BullMQ, and the installed BullMQ has the job-scheduler API this code relies on.
 *
 *  - `maxmemory-policy` must be `noeviction`. Under any evicting policy Redis may silently delete BullMQ keys (a job, a
 *    lock, a scheduler) under memory pressure — scans would stop or run twice with no error anywhere. Read from
 *    `INFO memory` (works on managed Redis that disables CONFIG), falling back to `CONFIG GET`; if neither reveals the
 *    policy the preflight fails closed.
 *  - An unauthenticated connection (no password in REDIS_URL) is a WARNING, not a refusal: the compose Redis is reachable
 *    only on a private network. Production should require auth (owner decision D7).
 *
 * Messages never include REDIS_URL or any part of it.
 */
export class RedisPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisPreflightError';
  }
}

export interface RedisPreflightResult {
  maxmemoryPolicy: string;
  authenticated: boolean;
  redisVersion: string | null;
}

export function parseInfoField(info: string, field: string): string | null {
  const match = new RegExp(`^${field}:(.*)$`, 'm').exec(info);
  return match ? match[1]!.trim() : null;
}

/** True when the URL carries a password (or an ACL user + password). Never returns or logs the value. */
export function redisUrlHasCredentials(redisUrl: string): boolean {
  try {
    const url = new URL(redisUrl);
    return url.password.length > 0;
  } catch {
    return false;
  }
}

/** The BullMQ APIs bullmq mode needs (present since bullmq 5.16; installed 5.81.3). Missing → refuse, never degrade. */
export function assertSupportedBullmqApi(queueClass: { prototype: object } = Queue): void {
  const proto = queueClass.prototype as Record<string, unknown>;
  const missing = ['upsertJobScheduler', 'getJobSchedulers', 'getJobScheduler', 'removeJobScheduler'].filter((m) => typeof proto[m] !== 'function');
  if (missing.length) {
    throw new RedisPreflightError(`the installed bullmq does not provide ${missing.join(', ')} — WORKER_SCHEDULER=bullmq is unsupported with it`);
  }
}

export async function assertRedisReadyForBullmq(
  redis: Pick<Redis, 'ping' | 'info' | 'config'>,
  redisUrl: string,
  logger: { warn(message: string): void },
): Promise<RedisPreflightResult> {
  await redis.ping();
  let info = '';
  try {
    info = await redis.info('memory');
  } catch {
    info = '';
  }
  let policy = parseInfoField(info, 'maxmemory_policy');
  if (!policy) {
    try {
      const pair = (await redis.config('GET', 'maxmemory-policy')) as unknown as string[];
      policy = Array.isArray(pair) && pair.length >= 2 ? String(pair[1]) : null;
    } catch {
      policy = null;
    }
  }
  if (!policy) {
    throw new RedisPreflightError(
      'could not determine Redis maxmemory-policy (INFO memory and CONFIG GET both unavailable); WORKER_SCHEDULER=bullmq requires noeviction — refusing to start',
    );
  }
  if (policy !== 'noeviction') {
    throw new RedisPreflightError(
      `Redis maxmemory-policy is "${policy}"; WORKER_SCHEDULER=bullmq requires "noeviction" (an evicting policy can silently drop BullMQ jobs, locks and schedulers) — refusing to start. Set maxmemory-policy noeviction or use WORKER_SCHEDULER=interval.`,
    );
  }
  let redisVersion: string | null = null;
  try {
    redisVersion = parseInfoField(await redis.info('server'), 'redis_version');
  } catch {
    redisVersion = null;
  }
  const authenticated = redisUrlHasCredentials(redisUrl);
  if (!authenticated) {
    logger.warn('Redis connection is unauthenticated (REDIS_URL carries no password) — acceptable only on a private network; production should require Redis AUTH/ACL');
  }
  return { maxmemoryPolicy: policy, authenticated, redisVersion };
}
