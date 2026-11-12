import type { AdminHealthCard } from '../admin-health.service';
import type { HealthRedisReader } from './health-redis-reader';
import { formatBytes, parseRedisMemoryInfo, readRedisInfoInteger, readRedisInfoToken } from './parse-redis-info.util';

/**
 * Phase X Part 2, X2.4 — the Redis indicator. Twenty: `admin-panel/indicators/redis.health.ts:26-99` (`INFO` and
 * `INFO memory`: version, used/peak memory; up whenever Redis answers) with the memory read the way
 * `message-queue/utils/parse-redis-memory-info.util.ts` reads it (used_memory against maxmemory). Two read-only
 * commands: `INFO server` and `INFO memory`. Memory never changes the status (Twenty has no threshold); the Worker's own
 * Redis preflight already refuses an evicting policy in bullmq mode.
 *
 * The existing Crewflow "no password set" warning is kept unchanged (it comes from REDIS_URL, never printed).
 */
export async function redisIndicator(client: HealthRedisReader, passwordSet: boolean): Promise<AdminHealthCard> {
  const started = Date.now();
  const [server, memory] = await Promise.all([client.info('server'), client.info('memory')]);
  const latencyMs = Date.now() - started;
  const version = readRedisInfoToken(server, 'redis_version') ?? 'unknown';
  const mem = parseRedisMemoryInfo(memory);
  const peak = readRedisInfoInteger(memory, 'used_memory_peak');
  const policy = readRedisInfoToken(memory, 'maxmemory_policy');
  if (!mem) throw new Error('redis indicator: INFO memory without used_memory/maxmemory');

  const limited = mem.maxMemoryBytes > 0;
  const percent = limited ? Math.round((mem.usedMemoryBytes / mem.maxMemoryBytes) * 100) : null;
  const memoryText = limited
    ? `${formatBytes(mem.usedMemoryBytes)} of ${formatBytes(mem.maxMemoryBytes)} (${percent}%)`
    : `${formatBytes(mem.usedMemoryBytes)} · no maxmemory limit`;
  return {
    key: 'redis',
    status: passwordSet ? (latencyMs > 500 ? 'warning' : 'healthy') : 'warning',
    detail: `Redis ${version} · ${memoryText} · ${latencyMs} ms${passwordSet ? '' : ' · no password set'}`,
    latencyMs,
    facts: [
      { label: 'Version', value: version },
      { label: 'Memory used', value: limited ? `${formatBytes(mem.usedMemoryBytes)} of ${formatBytes(mem.maxMemoryBytes)} (${percent}%)` : formatBytes(mem.usedMemoryBytes) },
      { label: 'maxmemory', value: limited ? formatBytes(mem.maxMemoryBytes) : 'Not set (no limit)' },
      ...(peak !== undefined ? [{ label: 'Peak memory', value: formatBytes(peak) }] : []),
      ...(policy ? [{ label: 'Eviction policy', value: policy }] : []),
    ],
  };
}
