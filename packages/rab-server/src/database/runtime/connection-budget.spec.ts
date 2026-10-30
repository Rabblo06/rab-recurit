import {
  assertConnectionBudget,
  ConnectionBudgetError,
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
  it('plans the deployment: 2 API x 10 + 1 Worker (12 + 6 + 2 + 2) + migrate 3 + probes 3 = 48', () => {
    const { shape } = readDeploymentShape(SHAPE_2_1);
    const plan = planConnectionBudget(shape!);
    expect(plan.rows.map((r) => [r.item, r.total])).toEqual([
      ['API runtime pool', 20],
      ['Worker runtime pool', 12],
      ['Worker direct/lock pool', 6],
      ['Worker scan-lock + storage-lock clients', 2],
      ['Worker provisioner child (until E6)', 2],
      ['rab-migrate', 3],
      ['boot probes + operator session', 3],
    ]);
    expect(plan.total).toBe(48);
    expect(plan.runtimeRoleTotal).toBe(40);
  });

  it('a 47-connection database (max_connections 50, 3 superuser-reserved): the defaults (48) are refused, API pool 9 (46) fits', async () => {
    await expect(
      assertConnectionBudget({ processRole: 'api', ownPoolMax: 10, env: SHAPE_2_1, query: queryReturning(capacityRow()), log: () => undefined }),
    ).rejects.toThrow(/up to 48 connections but the database allows 47/);

    const ok = await assertConnectionBudget({
      processRole: 'api',
      ownPoolMax: 9,
      env: { ...SHAPE_2_1, PG_EXPECTED_API_POOL_MAX: '9' },
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

  it('refuses when the runtime login connection limit is below the API + Worker total', () => {
    const plan = planConnectionBudget(readDeploymentShape(SHAPE_2_1).shape!);
    const result = evaluateConnectionBudget(
      plan,
      { maxConnections: 200, superuserReserved: 3, reserved: 0, providerSettingReserved: 0, roleLimit: 30, databaseLimit: null },
      0,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toMatch(/runtime login can open up to 40 connections but its connection limit is 30/);
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
