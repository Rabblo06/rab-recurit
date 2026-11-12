import type { EntityManager } from 'typeorm';

/**
 * TEST-ONLY seam: make server-path provisioning DEFER, the way a real infrastructure failure does (statement / lock timeout,
 * lost connection, function unavailable). Integration suites need a workspace that stays CREATING; under the owner-login
 * architecture the old trick (REVOKE EXECUTE ON core.provision_workspace FROM crewflow_app) does nothing, because the API's
 * runtime login is the schema owner.
 *
 * Effective ONLY when all three gates hold — otherwise it does nothing at all:
 *   1. CREWFLOW_TEST_DEFER_SERVER_PROVISIONING=true in this process (read at call time, so a test toggles it per request);
 *   2. NODE_ENV=test in this process;
 *   3. the database itself is marked disposable: current_setting('crewflow.disposable_test_database', true) = 'true', read in
 *      the provisioning transaction (rab-server's jest global setup requires that marker; a real database never has it).
 * Outside NODE_ENV=test the variable is also REFUSED at start-up (database/owner-login/runtime-db-config.ts TEST_SEAM_VARS:
 * env validation, the runtime guard and api-prestart.sh), so it can never be a production toggle.
 *
 * When effective, the service raises a synthetic infrastructure error (SQLSTATE 57014, query_canceled) right before calling
 * core.provision_workspace — AFTER the ownership, caller and lifecycle checks, so 404 / 403 / 409 are unchanged — and that
 * error goes through the service's REAL deferral path: the transaction rolls back, the warning is logged, DEFERRED is
 * returned, the workspace stays CREATING.
 */
export const DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR = 'CREWFLOW_TEST_DEFER_SERVER_PROVISIONING';
export const TEST_SEAM_DEFERRAL_SQLSTATE = '57014';

export class TestSeamDeferral extends Error {
  readonly code = TEST_SEAM_DEFERRAL_SQLSTATE;
  constructor() {
    super('test seam: server-path provisioning deferred (CREWFLOW_TEST_DEFER_SERVER_PROVISIONING)');
    this.name = 'TestSeamDeferral';
  }
}

/** True only when every gate holds. `warn` is called (once per call) when the variable is set but a gate fails. */
export async function serverProvisioningDeferredForTest(
  manager: Pick<EntityManager, 'query'>,
  warn: (line: string) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (env[DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR] !== 'true') return false;
  if (env.NODE_ENV !== 'test') {
    warn(`${DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR} ignored: it is honoured only with NODE_ENV=test`);
    return false;
  }
  const [row] = await manager.query<Array<{ marker: string | null }>>(`SELECT current_setting('crewflow.disposable_test_database', true) AS marker`);
  if (row?.marker !== 'true') {
    warn(`${DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR} ignored: this database is not marked as a disposable test database`);
    return false;
  }
  return true;
}

/**
 * For integration suites: runs `fn` with the seam switched on in THIS process, and always switches it back. The seam still
 * applies its own NODE_ENV=test and disposable-database gates.
 */
export async function withServerProvisioningDeferred<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env[DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR];
  process.env[DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR] = 'true';
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR];
    else process.env[DEFER_SERVER_PROVISIONING_TEST_SEAM_VAR] = previous;
  }
}
