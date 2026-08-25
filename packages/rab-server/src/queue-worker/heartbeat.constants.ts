/** Shared between queue-worker/main.ts (writer) and AdminPanelService (reader) — kept in its own side-effect-free file since main.ts self-bootstraps on import. */
export const WORKER_HEARTBEAT_KEY = 'rab:worker:heartbeat';
export const WORKER_HEARTBEAT_TTL_SECONDS = 30;
