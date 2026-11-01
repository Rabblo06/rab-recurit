/**
 * Side-effect import — FIRST in a spec (after local-storage-env), before anything that reads the environment: the Worker's
 * runtime login becomes the Worker-only `crewflow_worker` (TEST_DATABASE_WORKER_URL) with WORKER_CLAIM_MODE=global, the
 * Phase D target configuration. A no-op unless the Phase D opt-in and the worker URL are both present (the spec then skips).
 */
export const WORKER_LOGIN_ACTIVE = process.env.PHASE_D_SQL_APPROVED === 'true' && Boolean(process.env.TEST_DATABASE_WORKER_URL);
if (WORKER_LOGIN_ACTIVE) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_WORKER_URL;
  process.env.WORKER_CLAIM_MODE = 'global';
}
