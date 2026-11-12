import type { AdminHealthCard } from '../admin-health.service';
import type { HealthRedisReader } from './health-redis-reader';

/**
 * Phase X Part 2, X2.4 — the Worker indicator. Twenty: `admin-panel/indicators/worker.health.ts:25-166` (up when a
 * worker is alive; per queue the waiting, active, delayed and failed counts). Crewflow's "alive" signal is the Worker's
 * heartbeat key (Twenty asks BullMQ for connected workers; Crewflow already has a heartbeat with a TTL, kept as the
 * status source, unchanged). The queue counts are read with plain read-only commands on BullMQ's own keys — `LLEN` of
 * the `wait` / `paused` / `active` lists and `ZCARD` of the `prioritized` / `delayed` / `failed` sets — instead of
 * BullMQ's `getJobCounts` script, so the read path provably issues no write (no Lua, no `CLIENT SETNAME` from a new
 * Queue connection). waiting = wait + paused, as BullMQ's `getWaitingCount` counts it; prioritized jobs are shown
 * separately, as the queue table below the cards shows them.
 *
 * Counts never change the status (Twenty's per-queue failure rate needs BullMQ metrics, shown in the queue chart
 * below the cards); they are shown for the operator.
 */
export interface HealthQueueRef {
  name: string;
  prefix: string;
}

export interface QueueCounts {
  failed: number;
  waiting: number;
  prioritized: number;
  active: number;
  delayed: number;
}

export async function readQueueCounts(client: HealthRedisReader, queue: HealthQueueRef): Promise<QueueCounts> {
  const key = (suffix: string) => `${queue.prefix}:${queue.name}:${suffix}`;
  const [wait, paused, prioritized, active, delayed, failed] = await Promise.all([
    client.llen(key('wait')),
    client.llen(key('paused')),
    client.zcard(key('prioritized')),
    client.llen(key('active')),
    client.zcard(key('delayed')),
    client.zcard(key('failed')),
  ]);
  return { failed: Number(failed), waiting: Number(wait) + Number(paused), prioritized: Number(prioritized), active: Number(active), delayed: Number(delayed) };
}

/** Heartbeat age in seconds from a `Date.now()` value stored as text; null when missing or not a number. */
export function heartbeatAgeSeconds(value: string | null, nowMs: number): number | null {
  const at = Number(value);
  if (!value || !Number.isFinite(at)) return null;
  return Math.max(0, Math.round((nowMs - at) / 1000));
}

export async function workerIndicator(
  client: HealthRedisReader,
  input: { heartbeatKey: string; heartbeatTtlSeconds: number; queues: readonly HealthQueueRef[]; nowMs?: () => number },
): Promise<AdminHealthCard> {
  const [beat, counts] = await Promise.all([client.get(input.heartbeatKey), Promise.all(input.queues.map((q) => readQueueCounts(client, q)))]);
  const age = heartbeatAgeSeconds(beat, (input.nowMs ?? Date.now)());
  const totals = counts.reduce((t, c) => ({ failed: t.failed + c.failed, waiting: t.waiting + c.waiting }), { failed: 0, waiting: 0 });
  const queueText = `${totals.failed} failed · ${totals.waiting} waiting across ${input.queues.length} queue${input.queues.length === 1 ? '' : 's'}`;
  const facts = [
    { label: 'Heartbeat', value: age === null ? 'Not seen' : `${age} s ago${age > input.heartbeatTtlSeconds ? ' (stale)' : ''}` },
    ...input.queues.map((q, i) => ({
      label: q.name,
      value: `${counts[i]!.failed} failed · ${counts[i]!.waiting} waiting · ${counts[i]!.prioritized} prioritized · ${counts[i]!.active} active · ${counts[i]!.delayed} delayed`,
    })),
  ];
  if (age === null) return { key: 'worker', status: 'unavailable', detail: `No worker heartbeat seen. · ${queueText}`, latencyMs: null, facts };
  const stale = age > input.heartbeatTtlSeconds;
  return { key: 'worker', status: stale ? 'degraded' : 'healthy', detail: `Heartbeat ${age} s ago${stale ? ' (stale)' : ''} · ${queueText}`, latencyMs: null, facts };
}
