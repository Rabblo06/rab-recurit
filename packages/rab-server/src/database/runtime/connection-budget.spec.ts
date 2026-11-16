import { MIGRATION_POOL_MAX } from '../typeorm/scripts/migrate/locked-migration-runner';
import {
  assertConnectionBudget,
  ConnectionBudgetError,
  DEFAULT_MIGRATE_CONNECTIONS,
  evaluateConnectionBudget,
  planConnectionBudget,
  readDeploymentShape,
  SERVER_CAPACITY_SQL,
  ServerCapacity,
} from './connection-budget';

const capacityRow = (over: Partial<Record<string, unknown>> = {}) => ({
  max_connections: 50,
  superuser_reserved: 3,
  reserved: 0,
  provider_reserved: 0,
  role_limit: -1,
  database_limit: -1,
  ...over,
});

const queryReturning = (row: Record<string, unknown>) => jest.fn(async (sql: string) => (sql === SERVER_CAPACITY_SQL ? [row] : []));

const SHAPE_2_1 = { PG_EXPECTED_API_INSTANCES: '2', PG_EXPECTED_WORKER_INSTANCES: '1' };

describe('connection budget (B5)', () => {
  it('plans the deployment: 2 API x (10 + 1 health login probe) + 1 Worker (12 + 6 + 2 + 2) + migrate-on-start 5 + probes 3 = 52', () => {
    const { shape } = readDeploymentShape(SHAPE_2_1);
    const plan = planConnectionBudget(shape!);
    expect(plan.rows.map((r) => [r.item, r.total])).toEqual([
      ['API runtime pool', 20],
      ['API health login probe', 2],
      ['Worker runtime pool', 12],
      ['Worker direct/lock pool', 6],
      ['Worker scan-lock + storage-lock clients', 2],
      ['Worker in-process provisioner (provisioning + drift clients)', 2],
      ['API migrate-on-start child', 5],
      ['boot probes + operator session', 3],
    ]);
    expect(plan.total).toBe(52);
    // XD-05: one owner login opens every row, so its rolconnlimit is compared with the whole total (before XD-05: 42 of 50).
    expect(plan.runtimeRoleTotal).toBe(52);
  });

  it('the /healthz login probe slot is budgeted: a capacity that fits everything except one probe per API instance is refused', async () => {
    // usable = 53 - 3 = 50: the pools, Worker, migrate and boot probes (50) fit, the two API probe slots (52) do not.
    await expect(
      assertConnectionBudget({ processRole: 'api', ownPoolMax: 10, env: SHAPE_2_1, query: queryReturning(capacityRow({ max_connections: 53 })), log: () => undefined }),
    ).rejects.toThrow(/up to 52 connections but the database allows 50/);
    await expect(
      assertConnectionBudget({ processRole: 'api', ownPoolMax: 10, env: SHAPE_2_1, query: queryReturning(capacityRow({ max_connections: 55 })), log: () => undefined }),
    ).resolves.toMatchObject({ checked: true, usable: 52 });
    // A runtime login limited to the pools alone (40) is refused: the probe connects as that login too.
    const plan = planConnectionBudget(readDeploymentShape(SHAPE_2_1).shape!);
    const limited = evaluateConnectionBudget(plan, { maxConnections: 200, superuserReserved: 3, reserved: 0, providerSettingReserved: 0, roleLimit: 40, databaseLimit: null }, 0);
    expect(limited.problems.join()).toMatch(/runtime login can open up to 52 connections but its connection limit is 40/);
  });

  it('XD-05: no row is named after the retired rab-migrate step or provisioner child; every row is the owner login', () => {
    const plan = planConnectionBudget(readDeploymentShape(SHAPE_2_1).shape!);
    expect(plan.rows.map((r) => r.item).join('|')).not.toMatch(/rab-migrate|provisioner child|until E6/);
    expect(plan.rows.filter((r) => !r.runtimeRole)).toEqual([]);
  });

  it('XD-05: the migrate-on-start default covers the migration runner pool plus its one login client', () => {
    expect(DEFAULT_MIGRATE_CONNECTIONS).toBe(MIGRATION_POOL_MAX + 1);
    expect(readDeploymentShape(SHAPE_2_1).shape!.migrateConnections).toBe(5);
    expect(readDeploymentShape({ ...SHAPE_2_1, PG_EXPECTED_MIGRATE_CONNECTIONS: '3' }).shape!.migrateConnections).toBe(3);
  });

  it('XD-05: a crewflow_owner connection limit is compared with every row, provisioner, migrate and probes included', () => {
    const plan = planConnectionBudget(readDeploymentShape(SHAPE_2_1).shape!);
    const cap = (roleLimit: number): ServerCapacity => ({
      maxConnections: 500,
      superuserReserved: 3,
      reserved: 0,
      providerSettingReserved: 0,
      roleLimit,
      databaseLimit: null,
      login: 'crewflow_owner',
    });
    expect(evaluateConnectionBudget(plan, cap(52), 0).ok).toBe(true);
    // 51 used to pass (only the 42 pool + probe connections were compared) although the login can open 52.
    expect(evaluateConnectionBudget(plan, cap(51), 0).problems.join()).toMatch(/runtime login can open up to 52 connections but its connection limit is 51/);
  });

  it('a 47-connection database (max_connections 50, 3 superuser-reserved): the defaults (52) are refused, API pool 7 (46) fits', async () => {
    await expect(
      assertConnectionBudget({ processRole: 'api', ownPoolMax: 10, env: SHAPE_2_1, query: queryReturning(capacityRow()), log: () => undefined }),
    ).rejects.toThrow(/up to 52 connections but the database allows 47/);

    const ok = await assertConnectionBudget({
      processRole: 'api',
      ownPoolMax: 7,
      env: { ...SHAPE_2_1, PG_EXPECTED_API_POOL_MAX: '7' },
      query: queryReturning(capacityRow()),
      log: () => undefined,
    });
    expect(ok).toMatchObject({ checked: true, usable: 47 });
    expect(ok.plan!.total).toBe(46);
  });

  it('subtracts reserved_connections, provider-reported and operator-declared reservations, and honours datconnlimit', () => {
    const plan = planConnectionBudget(readDeploymentShape(SHAPE_2_1).shape!);
    const cap = (o: Partial<ServerCapacity>): ServerCapacity => ({
      maxConnections: 100,
      superuserReserved: 3,
      reserved: 0,
      providerSettingReserved: 0,
      roleLimit: null,
      databaseLimit: null,
      ...o,
    });
    expect(evaluateConnectionBudget(plan, cap({}), 0)).toMatchObject({ ok: true, capacity: 97 });
    expect(evaluateConnectionBudget(plan, cap({ reserved: 10, providerSettingReserved: 2 }), 0).capacity).toBe(85);
    expect(evaluateConnectionBudget(plan, cap({}), 50)).toMatchObject({ ok: false, capacity: 47 });
    expect(evaluateConnectionBudget(plan, cap({ databaseLimit: 40 }), 0)).toMatchObject({ ok: false, capacity: 40 });
  });

  it('refuses when the runtime login connection limit is below the deployment total', () => {
    const plan = planConnectionBudget(readDeploymentShape(SHAPE_2_1).shape!);
    const result = evaluateConnectionBudget(
      plan,
      { maxConnections: 200, superuserReserved: 3, reserved: 0, providerSettingReserved: 0, roleLimit: 30, databaseLimit: null },
      0,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toMatch(/runtime login can open up to 52 connections but its connection limit is 30/);
  });

  it('warns (does not refuse, does not query) when the instance counts are not declared', async () => {
    const log = jest.fn();
    const query = queryReturning(capacityRow());
    const report = await assertConnectionBudget({ processRole: 'worker', ownPoolMax: 12, env: {}, query, log });
    expect(report.checked).toBe(false);
    expect(log.mock.calls[0][0]).toMatch(/WARNING connection budget NOT checked: PG_EXPECTED_API_INSTANCES and PG_EXPECTED_WORKER_INSTANCES not set/);
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a process whose own pool is larger than its role's budgeted pool (the shared total would be understated)", async () => {
    await expect(
      assertConnectionBudget({ processRole: 'api', ownPoolMax: 15, env: {}, query: queryReturning(capacityRow()), log: () => undefined }),
    ).rejects.toThrow(/pool max is 15, above the budgeted PG_EXPECTED_API_POOL_MAX 10/);
    await expect(
      assertConnectionBudget({ processRole: 'worker', ownPoolMax: 13, env: SHAPE_2_1, query: queryReturning(capacityRow()), log: () => undefined }),
    ).rejects.toThrow(ConnectionBudgetError);
  });

  it('refuses malformed numbers instead of falling back (fail closed)', () => {
    expect(() => readDeploymentShape({ PG_EXPECTED_API_INSTANCES: 'two', PG_EXPECTED_WORKER_INSTANCES: '1' })).toThrow(/whole number/);
    expect(() => readDeploymentShape({ ...SHAPE_2_1, PG_EXPECTED_WORKER_POOL_MAX: '0' })).toThrow(/between 1 and 100/);
    expect(() => readDeploymentShape({ ...SHAPE_2_1, PG_EXPECTED_API_POOL_MAX: '2.5' })).toThrow(/whole number/);
  });

  it('error messages carry numbers and variable names only (no URL, user or password)', async () => {
    const error = await assertConnectionBudget({ processRole: 'api', ownPoolMax: 10, env: SHAPE_2_1, query: queryReturning(capacityRow({ max_connections: 20 })), log: () => undefined }).catch((e: Error) => e);
    expect((error as Error).message).not.toMatch(/postgres(ql)?:\/\/|password|crewflow_app/i);
  });
});
