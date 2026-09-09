/** Shared between queue-worker/main.ts (writer) and AdminPanelService (reader) — kept in its own side-effect-free file since main.ts self-bootstraps on import. */
export const WORKER_HEARTBEAT_KEY = 'rab:worker:heartbeat';
export const WORKER_HEARTBEAT_TTL_SECONDS = 30;

/**
 * Additive observability, NOT consumed by `AdminPanelService` yet — a
 * plain hash (`HSET`), separate from `WORKER_HEARTBEAT_KEY` deliberately:
 * that key's value is parsed with `Number(value)` by its one existing
 * reader, so turning it into a JSON blob to carry richer stats would
 * silently break every "is the worker stale" health check (`NaN > 30` is
 * always `false`). Surfacing this in the Admin Health tab is real,
 * reasonable follow-up work — not built this pass, since it would also
 * need a frontend change; this key exists so that follow-up has real data
 * to read from day one rather than needing its own plumbing pass first.
 */
export const WORKER_STATS_KEY = 'rab:worker:stats';
