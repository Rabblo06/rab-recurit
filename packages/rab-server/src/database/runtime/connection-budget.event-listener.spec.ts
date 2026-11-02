import { assertConnectionBudget, ConnectionBudgetError, evaluateConnectionBudget, planConnectionBudget, readDeploymentShape, SERVER_CAPACITY_SQL } from './connection-budget';

/**
 * Phase D (D2): WORKER_DISPATCH_MODE=event adds exactly one listener connection per Worker replica to the deployment's
 * worst case; poll (the default) adds nothing. A crewflow_worker login's rolconnlimit is compared with the Worker rows only.
 */
const SHAPE_2_2 = { PG_EXPECTED_API_INSTANCES: '2', PG_EXPECTED_WORKER_INSTANCES: '2' };
const capacityRow = (over: Record<string, unknown> = {}) => ({ max_connections: 100, superuser_reserved: 3, reserved: 0, provider_reserved: 0, role_limit: -1, database_limit: -1, ...over });

describe('connection budget — Phase D event-mode listener row', () => {
  it('poll (default and explicit) has no listener row', () => {
    for (const env of [SHAPE_2_2, { ...SHAPE_2_2, WORKER_DISPATCH_MODE: 'poll' }]) {
      const plan = planConnectionBudget(readDeploymentShape(env).shape!);
      expect(plan.rows.map((r) => r.item)).not.toContain('Worker dispatch listener (event mode)');
      // 2×10 + 2×(12+6+2+2) + 3 + 3 = 70
      expect(plan.total).toBe(70);
    }
  });

  it('event adds exactly 1 listener per Worker replica (2 replicas → +2), counted against the runtime logins', () => {
    const plan = planConnectionBudget(readDeploymentShape({ ...SHAPE_2_2, WORKER_DISPATCH_MODE: 'event' }).shape!);
    const row = plan.rows.find((r) => r.item === 'Worker dispatch listener (event mode)');
    expect(row).toEqual({ item: 'Worker dispatch listener (event mode)', each: 1, count: 2, total: 2, runtimeRole: true, workerLogin: true });
    expect(plan.total).toBe(72);
    // Worker login rows: 2 × (12 + 6 + 2 + 1) = 42
    expect(plan.workerRoleTotal).toBe(42);
  });

  it('refuses a malformed WORKER_DISPATCH_MODE in the shape (fail closed)', () => {
    expect(() => readDeploymentShape({ ...SHAPE_2_2, WORKER_DISPATCH_MODE: 'Event' })).toThrow(ConnectionBudgetError);
  });

  it('the listener can be what pushes a tight deployment over capacity', async () => {
    const query = jest.fn(async (sql: string) => (sql === SERVER_CAPACITY_SQL ? [capacityRow({ max_connections: 74 })] : []));
    // usable 71: poll (70) fits, event (72) is refused
    await expect(assertConnectionBudget({ processRole: 'worker', ownPoolMax: 12, env: SHAPE_2_2, query, log: () => undefined })).resolves.toMatchObject({ checked: true });
    await expect(
      assertConnectionBudget({ processRole: 'worker', ownPoolMax: 12, env: { ...SHAPE_2_2, WORKER_DISPATCH_MODE: 'event' }, query, log: () => undefined }),
    ).rejects.toThrow(/up to 72 connections but the database allows 71/);
  });

  it('rolconnlimit: crewflow_worker is compared with the Worker rows, crewflow_app (or an unknown login) with every runtime row', () => {
    const plan = planConnectionBudget(readDeploymentShape({ ...SHAPE_2_2, WORKER_DISPATCH_MODE: 'event' }).shape!);
    const cap = (login: string | undefined, roleLimit: number) => ({ maxConnections: 500, superuserReserved: 3, reserved: 0, providerSettingReserved: 0, roleLimit, databaseLimit: null, login });
    expect(evaluateConnectionBudget(plan, cap('crewflow_worker', 42), 0).ok).toBe(true);
    expect(evaluateConnectionBudget(plan, cap('crewflow_worker', 41), 0).problems.join()).toMatch(/up to 42 connections but its connection limit is 41/);
    // runtime rows: API 20 + Worker 42 = 62
    expect(evaluateConnectionBudget(plan, cap('crewflow_app', 61), 0).problems.join()).toMatch(/up to 62 connections/);
    expect(evaluateConnectionBudget(plan, cap(undefined, 61), 0).ok).toBe(false);
  });

  it('the capacity query reports the checking login', () => {
    expect(SERVER_CAPACITY_SQL).toMatch(/current_user::text AS login/);
  });
});
