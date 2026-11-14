import type { AdminHealthCard } from '../admin-health.service';
import type { HealthRedisReader } from './health-redis-reader';
import { heartbeatAgeSeconds } from './worker.indicator';

/**
 * Phase X Part 2, X2.4 — the BullMQ scheduler count (owner: "BullMQ scheduler count"; audit XR-07: "Redis loses its
 * schedules → nothing alerts"). Twenty has no separate card for it: its worker indicator (`worker.health.ts`) reads the
 * queues through BullMQ, and BullMQ's own `getJobSchedulersCount` is a plain `ZCARD <prefix>:<queue>:repeat`
 * (bullmq 5.x `job-scheduler.js`, getSchedulersCount). This indicator does exactly that, read-only, for every scan queue
 * (`crewflow-scan-*`, the only queues with job schedulers), and compares it with the last reconcile/verify report the
 * Worker leaves in `rab:worker:scheduler` (HGETALL; `schedulers` present + `missing`).
 *
 *  - WORKER_SCHEDULER=interval and no bullmq report: scans run on Worker timers; healthy, the count is shown.
 *  - bullmq, zero schedulers in Redis: degraded (no scan is being triggered — Redis lost its schedules).
 *  - bullmq, fewer schedulers than the last report expects, or the report itself counts missing ones: degraded.
 *  - bullmq, schedulers present but no recent report (the key has a short TTL): warning.
 */
export interface SchedulerIndicatorInput {
  configuredMode: 'interval' | 'bullmq';
  statusKey: string;
  /** Used when the Worker's report is absent (its key expired): the API's own resolved BULLMQ_PREFIX. */
  fallbackPrefix: string;
  scanQueues: readonly string[];
  nowMs?: () => number;
}

const PREFIX = /^[A-Za-z0-9:_-]{1,80}$/;
const int = (v: string | undefined): number | null => (v !== undefined && /^\d{1,15}$/.test(v) ? Number(v) : null);

export async function schedulerIndicator(client: HealthRedisReader, input: SchedulerIndicatorInput): Promise<AdminHealthCard> {
  const raw = await client.hgetall(input.statusKey);
  const report = raw && raw.mode === 'bullmq' && typeof raw.prefix === 'string' && PREFIX.test(raw.prefix)
    ? { prefix: raw.prefix, schedulers: int(raw.schedulers), missing: int(raw.missing) ?? 0, reconciledAt: int(raw.reconciledAt), registration: raw.registration === 'api' ? 'API' : 'Worker' }
    : null;
  const prefix = report?.prefix ?? input.fallbackPrefix;
  const perQueue = await Promise.all(input.scanQueues.map((q) => client.zcard(`${prefix}:${q}:repeat`)));
  const live = perQueue.reduce((sum, n) => sum + Number(n), 0);
  const age = report?.reconciledAt ? heartbeatAgeSeconds(String(report.reconciledAt), (input.nowMs ?? Date.now)()) : null;
  const expected = report?.schedulers !== null && report?.schedulers !== undefined ? report.schedulers + report.missing : null;
  const mode = report ? 'bullmq' : input.configuredMode;
  const facts = [
    { label: 'Mode', value: mode === 'bullmq' ? 'BullMQ schedulers (WORKER_SCHEDULER=bullmq)' : 'Interval timers (WORKER_SCHEDULER=interval)' },
    { label: 'Schedulers in Redis', value: String(live) },
    ...(expected !== null ? [{ label: 'Expected (last report)', value: String(expected) }] : []),
    ...(report ? [{ label: 'Last report', value: `${age === null ? 'time unknown' : `${age} s ago`} · registered by the ${report.registration}` }] : []),
    ...input.scanQueues.map((q, i) => ({ label: q, value: `${Number(perQueue[i])} scheduler${Number(perQueue[i]) === 1 ? '' : 's'}` })),
  ];

  if (!report && input.configuredMode === 'interval') {
    return { key: 'scheduler', status: 'healthy', detail: `Interval mode: scans run on Worker timers · ${live} BullMQ schedulers in Redis`, latencyMs: null, facts };
  }
  if (live === 0) {
    return { key: 'scheduler', status: 'degraded', detail: 'No BullMQ schedulers in Redis: scans are not being triggered.', latencyMs: null, facts };
  }
  if (!report) {
    return { key: 'scheduler', status: 'warning', detail: `${live} BullMQ schedulers in Redis · no recent reconcile report from a Worker`, latencyMs: null, facts };
  }
  if (report.missing > 0 || (expected !== null && live < expected)) {
    return { key: 'scheduler', status: 'degraded', detail: `${live} of ${expected ?? live} BullMQ schedulers in Redis: some scans are not being triggered.`, latencyMs: null, facts };
  }
  return { key: 'scheduler', status: 'healthy', detail: `${live} BullMQ schedulers · last report ${age === null ? 'time unknown' : `${age} s ago`}`, latencyMs: null, facts };
}
