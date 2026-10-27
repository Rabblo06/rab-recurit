/** Shared between rab-worker's main.ts (writer) and AdminPanelService (reader) — kept in its own side-effect-free file since main.ts self-bootstraps on import. */
export const WORKER_HEARTBEAT_KEY = 'rab:worker:heartbeat';
export const WORKER_HEARTBEAT_TTL_SECONDS = 30;

/**
 * Plain hash (`HSET`) of the jobs process's loop timestamps (`last<Loop>At`, epoch ms) and failure counters
 * (`<loop>Failures`), plus `startedAt`. Separate from `WORKER_HEARTBEAT_KEY` deliberately: that key's value is parsed with
 * `Number(value)` by its readers, so turning it into a JSON blob would silently break every "is the worker stale" check.
 * Readers: `OutboxOperationsService.queueHealth` (Admin queue health, HGETALL), the Worker bundle integration harness and
 * E2E 5.3 (`lastWorkspaceProvisioningAt`).
 *
 * BullMQ migration (2026-10-24): field names and meanings are unchanged. In `WORKER_SCHEDULER=interval` (default) the jobs
 * process still HSETs its whole in-memory object on every settle. In `bullmq` mode it writes only the fields a cycle
 * changed (so replicas that take turns never overwrite a fresher timestamp), failure counters become cluster-wide
 * HINCRBY totals, and a `<loop>Skipped` counter appears for scans skipped because another run held the scan lock.
 * The workspace provisioner no longer writes `startedAt` here (it overwrote the jobs process's own start time): it keeps
 * mirroring ONLY its loop fields (`lastWorkspaceProvisioningAt`, `workspaceProvisioningFailures`, drift) for these
 * readers, and writes its full stats to `PROVISIONER_STATS_KEY`.
 */
export const WORKER_STATS_KEY = 'rab:worker:stats';

/** The workspace provisioner's own heartbeat (unchanged) and full stats hash (its own `startedAt` + loop fields). */
export const PROVISIONER_HEARTBEAT_KEY = 'rab:workspace-provisioner:heartbeat';
export const PROVISIONER_STATS_KEY = 'rab:workspace-provisioner:stats';

/**
 * M1 per-loop cycle-duration summaries (one hash field per loop, JSON of p50/p95/p99/max ms + outcome counters; no
 * configuration or business data). 7-day TTL, refreshed on write.
 */
export const WORKER_CYCLE_DURATIONS_KEY = 'rab:worker:cycle-durations';
export const PROVISIONER_CYCLE_DURATIONS_KEY = 'rab:workspace-provisioner:cycle-durations';

/**
 * BullMQ scheduler status, written by jobs processes running `WORKER_SCHEDULER=bullmq` after each successful scheduler
 * reconcile (mode, the scan-queue prefix, reconcile time, scheduler count). It carries a short TTL, so it disappears on
 * its own after a rollback to interval mode; its absence means "interval mode (or no bullmq replica alive)".
 */
export const WORKER_SCHEDULER_STATUS_KEY = 'rab:worker:scheduler';
