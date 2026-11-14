/**
 * Phase X Part 2, X2.4: reading Redis `INFO` text for the Admin Panel Health tab.
 *
 * Twenty reference: `message-queue/utils/parse-redis-memory-info.util.ts:8-31` (used_memory + maxmemory read from
 * `INFO memory`, line-anchored, integers only; undefined when a field is missing) and `admin-panel/indicators/redis.health.ts:37-49`
 * (the version from `INFO`). Re-implemented, not copied.
 *
 * Only numeric fields and a short allowlisted string pattern are ever returned, so nothing Redis prints (a config path,
 * a host name) can reach the panel through these helpers.
 */
export interface RedisMemoryInfo {
  usedMemoryBytes: number;
  /** 0 = no `maxmemory` limit configured. */
  maxMemoryBytes: number;
}

function escapeField(field: string): string {
  return field.replace(/[^A-Za-z0-9_]/g, '');
}

/** An integer `INFO` field (`<field>:<digits>` on its own line), or undefined. */
export function readRedisInfoInteger(info: string, field: string): number | undefined {
  const match = new RegExp(`^${escapeField(field)}:(\\d{1,20})\\s*$`, 'm').exec(info);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** A short token `INFO` field (letters, digits, `.`, `-`, `_`), e.g. `redis_version` or `maxmemory_policy`; else undefined. */
export function readRedisInfoToken(info: string, field: string): string | undefined {
  const match = new RegExp(`^${escapeField(field)}:([A-Za-z0-9._-]{1,40})\\s*$`, 'm').exec(info);
  return match ? match[1] : undefined;
}

/** `INFO memory` → used and maximum memory in bytes; undefined when either field is missing (Twenty's contract). */
export function parseRedisMemoryInfo(info: string): RedisMemoryInfo | undefined {
  const usedMemoryBytes = readRedisInfoInteger(info, 'used_memory');
  const maxMemoryBytes = readRedisInfoInteger(info, 'maxmemory');
  if (usedMemoryBytes === undefined || maxMemoryBytes === undefined) return undefined;
  return { usedMemoryBytes, maxMemoryBytes };
}

/** Bytes as a short operator-facing size (binary units, as `used_memory_human` prints them). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
