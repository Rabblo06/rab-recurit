import 'reflect-metadata';
import { DataSource, EntityManager } from 'typeorm';

import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { SchemaResolverService } from '../../engine/core-modules/tenant/schema-resolver.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { integrationTestDatabase } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * T-1 (ST-01 / ST-02) on REAL PostgreSQL (disposable PG16 / PG18 built the owner-login way), as crewflow_owner, through
 * one pooled connection (pool max 1, so every transaction below provably reuses the same backend):
 *   - the folded binding SELECT sets search_path = 'core' (and, with `readOnly`, transaction_read_only = on) inside the
 *     transaction, and nothing of it survives COMMIT or ROLLBACK on that connection;
 *   - a write after the folded read-only flag fails with 25006 (INSERT, UPDATE of zero rows, inside a SAVEPOINT too), and
 *     the same write without the option does not;
 *   - a poisoned session (a session-level role left behind and COMMITTED) never reaches the next tenant transaction:
 *     reset by the checkout hook, and by the per-transaction RESET ROLE alone when no hook is installed;
 *   - injection payloads sent as role / organisationId / userId are bound values: search_path stays 'core', nothing
 *     session-scoped changes, the session stays the login.
 * Skipped (NOT a pass) unless TEST_DATABASE_URL is the owner login.
 */
// DEAD-07: the validated TEST pair (throws on an invalid pair, never a silent skip); the opt-in is the app login itself.
const env = integrationTestDatabase();
const OWNER = env.app.login === 'crewflow_owner';
const suite = OWNER ? describe : describe.skip;
if (!OWNER) console.warn('[tenant-context framing] SKIPPED: TEST_DATABASE_URL is not the owner login crewflow_owner (NOT a pass).'); // eslint-disable-line no-console

const ORG = '00000000-0000-4000-8000-0000000000e1';
const WS = '00000000-0000-4000-8000-0000000000e2';
const CTX = { organisationId: ORG, workspaceId: WS, userId: '00000000-0000-4000-8000-0000000000e3', role: '', actorType: 'worker' as const };

type Snapshot = { pid: number; search_path: string; read_only: string; org: string | null; role_guc: string | null; cu: string; su: string };
const SNAPSHOT_SQL = `SELECT pg_backend_pid() AS pid, current_setting('search_path') AS search_path, current_setting('transaction_read_only') AS read_only,
  current_setting('rab.organisation_id', true) AS org, current_setting('rab.role', true) AS role_guc, current_user::text AS cu, session_user::text AS su`;
const snapshot = async (q: { query: (sql: string) => Promise<unknown> }): Promise<Snapshot> => ((await q.query(SNAPSHOT_SQL)) as Snapshot[])[0]!;
const codeOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: { code?: string; driverError?: { code?: string } }) => e.driverError?.code ?? e.code ?? 'error',
  );
/** A tenant-context-transaction-local GUC reverts to '' (once defined in the session) or NULL (never defined). */
const unset = (value: string | null) => value === null || value === '';

function makeDataSource(): DataSource {
  return new DataSource({ type: 'postgres', url: process.env.TEST_DATABASE_URL, entities: [], synchronize: false, logging: false, extra: { max: 1 } });
}
const environment = (hws: boolean) => ({ get: (key: string) => (key === 'HWS_RUNTIME_ENABLED' ? hws : undefined) }) as unknown as EnvironmentService;
// HWS is off in every case here (production shape); the resolver is never reached, and is refused loudly if it were.
const noResolver = { resolve: async () => Promise.reject(new Error('resolver must not be called with HWS off')) } as unknown as SchemaResolverService;

suite('T-1 tenant-context framing (real PostgreSQL, as crewflow_owner, pool max 1)', () => {
  let dataSource: DataSource;
  let tenant: TenantContextService;
  let baseline: Snapshot;

  beforeAll(async () => {
    dataSource = makeDataSource();
    await dataSource.initialize();
    tenant = new TenantContextService(dataSource, noResolver, environment(false)); // installs the checkout RESET ROLE hook
    baseline = await snapshot(dataSource);
    expect(baseline.cu).toBe('crewflow_owner');
    expect(baseline.read_only).toBe('off');
    expect(baseline.search_path).not.toBe('core'); // otherwise the revert assertions below would prove nothing
  });
  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('ST-01: search_path = core is set by the binding SELECT, transaction-local, and reverts after COMMIT', async () => {
    const inside = await tenant.runInTenantContext(CTX, (m) => snapshot(m));
    expect(inside).toMatchObject({ pid: baseline.pid, search_path: 'core', read_only: 'off', org: ORG, cu: 'crewflow_owner', su: 'crewflow_owner' });
    const [{ schemas }] = await dataSource.query(`SELECT current_schemas(false)::text AS schemas`);
    const after = await snapshot(dataSource);
    expect(after.pid).toBe(baseline.pid);
    expect(after.search_path).toBe(baseline.search_path);
    expect(unset(after.org)).toBe(true);
    expect(after.read_only).toBe('off');
    expect(schemas).not.toBe('{core}');
  });

  it('ST-01: inside, search_path is exactly the one schema core (never a list)', async () => {
    const schemas = await tenant.runInTenantContext(CTX, async (m) => ((await m.query(`SELECT current_schemas(false)::text AS s`)) as Array<{ s: string }>)[0]!.s);
    expect(schemas).toBe('{core}');
  });

  it('ST-02: readOnly puts transaction_read_only = on in the same SELECT; everything reverts after COMMIT and after ROLLBACK', async () => {
    const inside = await tenant.runInTenantContext(CTX, (m) => snapshot(m), { readOnly: true });
    expect(inside).toMatchObject({ pid: baseline.pid, search_path: 'core', read_only: 'on', org: ORG, cu: 'crewflow_owner' });
    const afterCommit = await snapshot(dataSource);
    expect(afterCommit).toMatchObject({ pid: baseline.pid, search_path: baseline.search_path, read_only: 'off', cu: 'crewflow_owner' });
    expect(unset(afterCommit.org)).toBe(true);

    const boom = new Error('roll back');
    await expect(
      tenant.runInTenantContext(
        CTX,
        async (m) => {
          expect((await snapshot(m)).read_only).toBe('on');
          throw boom;
        },
        { readOnly: true },
      ),
    ).rejects.toBe(boom);
    const afterRollback = await snapshot(dataSource);
    expect(afterRollback).toMatchObject({ pid: baseline.pid, search_path: baseline.search_path, read_only: 'off', cu: 'crewflow_owner' });
    expect(unset(afterRollback.org)).toBe(true);
  });

  describe('ST-02: a write after the folded read-only flag fails with 25006', () => {
    const update = (m: EntityManager) => m.query(`UPDATE core.user_session SET revoked_reason = revoked_reason WHERE false`);
    const insert = (m: EntityManager) =>
      m.query(`INSERT INTO core.audit_log (organisation_id, action, entity_type) VALUES ($1, 't1.read_only_probe', 'probe')`, [ORG]);

    it('UPDATE (even of zero rows) and INSERT are refused with 25006', async () => {
      expect(await codeOf(tenant.runInTenantContext(CTX, update, { readOnly: true }))).toBe('25006');
      expect(await codeOf(tenant.runInWorkspaceContext(CTX, update, { readOnly: true }))).toBe('25006');
      expect(await codeOf(tenant.runInTenantContext(CTX, insert, { readOnly: true }))).toBe('25006');
    });

    it('control: the same UPDATE without the option is not refused as read-only', async () => {
      expect(await codeOf(tenant.runInTenantContext(CTX, update))).toBe('ok');
      // The INSERT may be refused by RLS/grants for this synthetic context, but never as a read-only transaction.
      const code = await codeOf(tenant.runInTenantContext(CTX, async (m) => { await insert(m); throw new Error('roll back'); }));
      expect(code).not.toBe('25006');
    });

    it('inside a SAVEPOINT (the combined walk): 25006, ROLLBACK TO works, and the transaction stays READ ONLY', async () => {
      const out = await tenant.runInTenantContext(
        CTX,
        async (m) => {
          await m.query('SAVEPOINT t1_member');
          const code = await codeOf(update(m));
          await m.query('ROLLBACK TO SAVEPOINT t1_member');
          return { code, after: await snapshot(m) };
        },
        { readOnly: true },
      );
      expect(out.code).toBe('25006');
      expect(out.after.read_only).toBe('on');
      expect((await snapshot(dataSource)).read_only).toBe('off');
    });
  });

  it('poisoned session: a COMMITTED session-level role never reaches the next tenant transaction (checkout reset)', async () => {
    await dataSource.transaction(async (m) => {
      await m.query(`SELECT set_config('role', 'rab_secure_owner', false)`);
    });
    const inside = await tenant.runInTenantContext(CTX, (m) => snapshot(m), { readOnly: true });
    expect(inside).toMatchObject({ pid: baseline.pid, cu: 'crewflow_owner', su: 'crewflow_owner' });
  });

  it('poisoned session, layer 2 alone (no checkout hook): the per-transaction RESET ROLE still resets it', async () => {
    const bare = makeDataSource();
    // Built BEFORE initialize: the constructor installs the checkout hook only on an initialized DataSource.
    const layer2Only = new TenantContextService(bare, noResolver, environment(false));
    await bare.initialize();
    try {
      await bare.transaction(async (m) => {
        await m.query(`SELECT set_config('role', 'rab_secure_owner', false)`);
      });
      // Control: without any reset the poisoned role survives COMMIT and the checkout.
      expect((await snapshot(bare)).cu).toBe('rab_secure_owner');
      const inside = await layer2Only.runInTenantContext(CTX, (m) => snapshot(m), { readOnly: true });
      expect(inside).toMatchObject({ cu: 'crewflow_owner', su: 'crewflow_owner', search_path: 'core', read_only: 'on' });
    } finally {
      await bare.query('RESET ROLE').catch(() => undefined);
      await bare.destroy();
    }
  });

  it.each(["'; DROP SCHEMA core CASCADE; --", "x'); SET ROLE rab_secure_owner; --", "' OR '1'='1", 'core, public', 'workspace_x, core'])(
    'injection payload %p as role / organisationId / userId: bound verbatim, search_path stays core, session unchanged',
    async (payload) => {
      const inside = await tenant.runInTenantContext(
        { organisationId: payload, workspaceId: null, userId: payload, role: payload, actorType: 'worker' },
        async (m) => ({ ...(await snapshot(m)), schemas: ((await m.query(`SELECT current_schemas(false)::text AS s`)) as Array<{ s: string }>)[0]!.s }),
        { readOnly: true },
      );
      expect(inside).toMatchObject({ search_path: 'core', schemas: '{core}', org: payload, role_guc: payload, cu: 'crewflow_owner', read_only: 'on' });
      const after = await snapshot(dataSource);
      expect(after).toMatchObject({ pid: baseline.pid, search_path: baseline.search_path, cu: 'crewflow_owner', read_only: 'off' });
      expect(unset(after.role_guc)).toBe(true);
      expect((await dataSource.query(`SELECT to_regnamespace('core') IS NOT NULL AS present`))[0].present).toBe(true);
    },
  );
});
