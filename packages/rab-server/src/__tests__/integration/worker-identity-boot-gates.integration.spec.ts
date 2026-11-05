import { DataSource } from 'typeorm';

import { BOOT_FACTS_SQL, DatabaseBootGateError, runDatabaseBootGates, RunBootGatesOptions } from '../../database/boot-checks/database-boot-gates';
import { RUNTIME_IDENTITY_SQL } from '../../engine/utils/assert-runtime-db-role';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { assertRuntimeDbRole } from '../../engine/utils/assert-runtime-db-role';

/**
 * Phase D (D2/D5) identity separation against a real disposable database.
 *
 * OPT-IN: it needs the operator-created `crewflow_worker` login (interface contract:
 * LOGIN, INHERIT, member of crewflow_app WITH INHERIT TRUE, SET FALSE; nothing else) and, for the global-mode cases, the
 * Phase D migrations (WorkerDispatchPointer1786721300000 …). It is skipped unless TEST_DATABASE_WORKER_URL (a
 * crewflow_worker URL on the SAME test database) is set. The admin URL creates and drops two throwaway roles to prove the
 * PG16 membership-option handling of the owner-role rule.
 *
 * Unit counterparts (mocked catalog facts, run): database-boot-gate-rules.worker-identity.spec.ts, assert-runtime-db-role.spec.ts.
 */
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
/**
 * SUPERSEDED (Agent 3 ruling, 2026-11-05): under the one owner login there is no crewflow_worker LOGIN; the worker / API
 * identity boot gates are covered by owner-login-guards.integration.spec.ts. Every test below is skipped BY NAME and stays
 * under the PR #9 removal gate (twenty-expected-differences.json removeInPr9): remove this file in PR #9.
 */
const SUPERSEDED_BY_OWNER_LOGIN_GUARDS_REMOVE_IN_PR9 = true;
const SUPERSEDED = 'SUPERSEDED by owner-login-guards; remove in PR #9 (skipped) — ';
const describeIfWorkerRole = WORKER_URL && !SUPERSEDED_BY_OWNER_LOGIN_GUARDS_REMOVE_IN_PR9 ? describe : describe.skip;
const quiet = () => undefined;

function options(url: string, env: Record<string, string> = {}): RunBootGatesOptions {
  return { env: { NODE_ENV: 'test', ...env }, connectionEnv: { NODE_ENV: 'test', PG_DATABASE_URL: url }, retry: { attempts: 1 }, log: quiet };
}

async function refusedAt(promise: Promise<unknown>, gate: string, pattern: RegExp): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(DatabaseBootGateError);
  expect((error as DatabaseBootGateError).gate).toBe(gate);
  expect((error as Error).message).toMatch(pattern);
}

async function withSource<T>(url: string, fn: (ds: DataSource) => Promise<T>): Promise<T> {
  const ds = new DataSource({ type: 'postgres', url, entities: [], synchronize: false, extra: { max: 1 } });
  await ds.initialize();
  try {
    return await fn(ds);
  } finally {
    await ds.destroy();
  }
}

describeIfWorkerRole(SUPERSEDED + 'Phase D worker identity boot gates (integration; needs crewflow_worker)', () => {
  const { appUrl, adminUrl } = WORKER_URL ? resolveIntegrationTestDatabase(process.env) : ({} as never);

  it(SUPERSEDED + 'crewflow_worker has the reviewed shape and passes the per_scope Worker gate; the report shows the due-work grant state', async () => {
    const report = await runDatabaseBootGates('worker', options(WORKER_URL!, { WORKER_CLAIM_MODE: 'per_scope' }));
    expect(report).toMatchObject({ role: 'crewflow_worker', claimMode: 'per_scope', grants: { dueWork: 'granted' } });
  });

  it(SUPERSEDED + 'the API and a CLI command refuse the crewflow_worker login', async () => {
    await refusedAt(runDatabaseBootGates('api', options(WORKER_URL!)), 'role', /Worker-only login/);
    await refusedAt(runDatabaseBootGates('cli', { ...options(WORKER_URL!), cliCommand: 'bootstrap-admin' }), 'role', /Worker-only login/);
    await withSource(WORKER_URL!, (ds) => expect(assertRuntimeDbRole(ds, 'API server')).rejects.toThrow(/Worker-only login/));
  });

  it(SUPERSEDED + 'global mode: crewflow_worker starts (dispatch-claim functions granted); crewflow_app refuses', async () => {
    await expect(runDatabaseBootGates('worker', options(WORKER_URL!, { WORKER_CLAIM_MODE: 'global' }))).resolves.toMatchObject({
      grants: { dispatchClaims: 'granted' },
    });
    await refusedAt(runDatabaseBootGates('worker', options(appUrl, { WORKER_CLAIM_MODE: 'global' })), 'role', /WORKER_CLAIM_MODE=global requires "crewflow_worker"/);
    await withSource(WORKER_URL!, (ds) => expect(assertRuntimeDbRole(ds, 'worker', { process: 'worker', claimMode: 'global' })).resolves.toBeUndefined());
    await withSource(appUrl, (ds) => expect(assertRuntimeDbRole(ds, 'worker', { process: 'worker', claimMode: 'global' })).rejects.toThrow(/crewflow_worker/));
  });

  it(SUPERSEDED + 'the API login (crewflow_app) cannot EXECUTE any dispatch-claim function (gate 8 passes for it)', async () => {
    await expect(runDatabaseBootGates('api', options(appUrl))).resolves.toMatchObject({ grants: { dispatchClaims: 'not-granted' } });
  });

  it(SUPERSEDED + 'PG16 membership options: an owner-role membership WITH INHERIT FALSE, SET FALSE (or SET-only) is still refused', async () => {
    // Throwaway roles: a member of crewflow_worker with a non-inheriting, non-SET membership of crewflow. pg_has_role(MEMBER)
    // must see it; the boot gate must refuse it on its owner-role rule.
    const pw = `pd_${Math.random().toString(36).slice(2)}`;
    await withSource(adminUrl, async (ds) => {
      await ds.query(`DROP ROLE IF EXISTS phase_d_probe_member`);
      await ds.query(`CREATE ROLE phase_d_probe_member LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS`);
      await ds.query(`GRANT crewflow_app TO phase_d_probe_member WITH INHERIT TRUE, SET FALSE`);
      await ds.query(`GRANT crewflow TO phase_d_probe_member WITH INHERIT FALSE, SET FALSE`);
    });
    try {
      const url = new URL(appUrl);
      url.username = 'phase_d_probe_member';
      url.password = pw;
      const facts = await withSource(url.toString(), (ds) =>
        ds.query(`SELECT pg_catalog.pg_has_role(current_user, 'crewflow', 'MEMBER') AS member, pg_catalog.pg_has_role(current_user, 'crewflow', 'USAGE') AS usage`),
      );
      expect(facts[0]).toEqual({ member: true, usage: false });
      // The boot gate's and the runtime assertion's owner-role columns both name crewflow for this login.
      const [gateFacts] = await withSource(url.toString(), (ds) => ds.query(BOOT_FACTS_SQL));
      expect(gateFacts.owner_roles).toBe('crewflow');
      const [runtimeFacts] = await withSource(url.toString(), (ds) => ds.query(RUNTIME_IDENTITY_SQL));
      expect(runtimeFacts.owner_roles).toBe('crewflow');
    } finally {
      await withSource(adminUrl, (ds) => ds.query(`DROP ROLE IF EXISTS phase_d_probe_member`));
    }
  });
});
