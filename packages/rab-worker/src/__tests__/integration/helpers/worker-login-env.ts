/**
 * Side-effect import — FIRST in a spec (after local-storage-env), before anything that reads the environment: the Worker's
 * runtime login becomes the Worker-only `crewflow_worker` (TEST_DATABASE_WORKER_URL) with WORKER_CLAIM_MODE=global, the
 * Phase D target configuration. A no-op unless the Phase D opt-in and the worker URL are both present (the spec then skips).
 *
 * X1.8 (audit XD-03): the worker URL is no longer copied into DATABASE_URL unchecked. rab-server's test-database guard
 * validates it first with the TEST_* rules, whatever NODE_ENV says: the TEST pair must be valid, the worker URL must name its
 * login and the TEST database on the same endpoint, no inherited URL or libpq variable may redirect a connection, and it may
 * not be the test admin (bootstrap superuser) login. A refusal throws before anything is changed.
 */
import { applyWorkerLoginTestDatabaseEnv } from '@rab/server/database/typeorm/core/test-database-guard';

export const WORKER_LOGIN_ACTIVE = applyWorkerLoginTestDatabaseEnv(process.env);
