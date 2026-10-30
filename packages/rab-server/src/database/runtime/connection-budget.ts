/**
 * Phase B (B5/P6): startup connection-budget check. Every API and Worker instance computes the WHOLE deployment's
 * worst-case connection count from one shared, declared deployment shape and compares it with what the database server
 * actually allows. Configured total above capacity → refuse to start (fail closed). Instance counts not declared → warn
 * and skip (owner rule).
 *
 * Deployment shape (environment, identical in every service of one deployment):
 *   PG_EXPECTED_API_INSTANCES        peak API instances at once, INCLUDING rolling-deploy overlap (old + new)
 *   PG_EXPECTED_WORKER_INSTANCES     peak Worker containers at once
 *   PG_EXPECTED_API_POOL_MAX         default 10 — the API pool (PG_POOL_MAX_CONNECTIONS of the API processes)
 *   PG_EXPECTED_WORKER_POOL_MAX      default 12 — the Worker runtime pool (PG_POOL_MAX_CONNECTIONS of the Worker)
 *   PG_EXPECTED_MIGRATE_CONNECTIONS  default 3  — the one-shot rab-migrate step while it runs
 *   PG_PROVIDER_RESERVED_CONNECTIONS default 0  — slots a managed provider keeps for itself beyond what the server
 *                                    reports (declared by the operator; see the runbook)
 * Each process also verifies that ITS OWN pool is not larger than the budgeted value for its role: otherwise the shared
 * calculation would understate the real total, so that too refuses to start.
 *
 * Per Worker container, from the code (Phase B audit; file:line in the A3/A4 report):
 *   runtime pool PG_EXPECTED_WORKER_POOL_MAX + direct/lock pool 6 (5 lock-holding scans + 1) + BullMQ scan-lock client 1
 *   + storage-reconcile lock client 1 + provisioner child 2 (provisioning client + drift client; until E6 retires it).
 * Boot probes are short-lived and sequential (runtime guard, boot gates, session probe); BOOT_PROBE_ALLOWANCE covers
 * the probes of one starting process plus one operator session.
 *
 * Capacity: max_connections − superuser_reserved_connections − reserved_connections (PostgreSQL 16) − the RDS-style
 * rds.rds_superuser_reserved_connections when the server reports it − PG_PROVIDER_RESERVED_CONNECTIONS. Also bounded by
 * the database's datconnlimit and, for the crewflow_app processes only, the login's rolconnlimit.
 */

export const WORKER_DIRECT_POOL_MAX_BUDGET = 6;
export const WORKER_SCAN_LOCK_CONNECTIONS = 1;
export const WORKER_STORAGE_LOCK_CONNECTIONS = 1;
export const WORKER_PROVISIONER_CONNECTIONS = 2;
export const BOOT_PROBE_ALLOWANCE = 3;

export const DEFAULT_API_POOL_MAX = 10;
export const DEFAULT_WORKER_POOL_MAX = 12;
export const DEFAULT_MIGRATE_CONNECTIONS = 3;

export const CONNECTION_BUDGET_ENV_NAMES = [
  'PG_EXPECTED_API_INSTANCES',
  'PG_EXPECTED_WORKER_INSTANCES',
  'PG_EXPECTED_API_POOL_MAX',
  'PG_EXPECTED_WORKER_POOL_MAX',
  'PG_EXPECTED_MIGRATE_CONNECTIONS',
  'PG_PROVIDER_RESERVED_CONNECTIONS',
] as const;

export class ConnectionBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionBudgetError';
  }
}

type Env = Record<string, string | undefined>;

export interface DeploymentShape {
  apiInstances: number;
  workerInstances: number;
  apiPoolMax: number;
  workerPoolMax: number;
  migrateConnections: number;
  providerReserved: number;
}

export interface BudgetRow {
  item: string;
  each: number;
  count: number;
  total: number;
  /** Whether these connections log in as the runtime role (counted against its rolconnlimit). */
  runtimeRole: boolean;
}

export interface BudgetPlan {
  rows: BudgetRow[];
  total: number;
  runtimeRoleTotal: number;
}

export interface ServerCapacity {
  maxConnections: number;
  superuserReserved: number;
  reserved: number;
  providerSettingReserved: number;
  roleLimit: number | null;
  databaseLimit: number | null;
}

export interface BudgetEvaluation {
  ok: boolean;
  capacity: number;
  problems: string[];
}

function intEnv(env: Env, name: string, fallback: number | null, min: number, max: number): number | null {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,6}$/.test(raw)) throw new ConnectionBudgetError(`${name} must be a whole number. Refusing to start.`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConnectionBudgetError(`${name} must be between ${min} and ${max}. Refusing to start.`);
  return n;
}

/** Reads the shared deployment shape. Null when either instance count is not declared (→ warn, not checked). */
export function readDeploymentShape(env: Env): { shape: DeploymentShape | null; missing: string[] } {
  const apiInstances = intEnv(env, 'PG_EXPECTED_API_INSTANCES', null, 0, 1000);
  const workerInstances = intEnv(env, 'PG_EXPECTED_WORKER_INSTANCES', null, 0, 1000);
  const shapeRest = {
    apiPoolMax: intEnv(env, 'PG_EXPECTED_API_POOL_MAX', DEFAULT_API_POOL_MAX, 1, 100) as number,
    workerPoolMax: intEnv(env, 'PG_EXPECTED_WORKER_POOL_MAX', DEFAULT_WORKER_POOL_MAX, 1, 100) as number,
    migrateConnections: intEnv(env, 'PG_EXPECTED_MIGRATE_CONNECTIONS', DEFAULT_MIGRATE_CONNECTIONS, 0, 100) as number,
    providerReserved: intEnv(env, 'PG_PROVIDER_RESERVED_CONNECTIONS', 0, 0, 10_000) as number,
  };
  const missing = [apiInstances === null ? 'PG_EXPECTED_API_INSTANCES' : null, workerInstances === null ? 'PG_EXPECTED_WORKER_INSTANCES' : null].filter(
    (x): x is string => x !== null,
  );
  if (apiInstances === null || workerInstances === null) return { shape: null, missing };
  return { shape: { apiInstances, workerInstances, ...shapeRest }, missing };
}

/** Worst-case connections of the whole deployment against the primary. Pure. */
export function planConnectionBudget(shape: DeploymentShape): BudgetPlan {
  const rows: BudgetRow[] = [
    { item: 'API runtime pool', each: shape.apiPoolMax, count: shape.apiInstances, total: shape.apiPoolMax * shape.apiInstances, runtimeRole: true },
    { item: 'Worker runtime pool', each: shape.workerPoolMax, count: shape.workerInstances, total: shape.workerPoolMax * shape.workerInstances, runtimeRole: true },
    {
      item: 'Worker direct/lock pool',
      each: WORKER_DIRECT_POOL_MAX_BUDGET,
      count: shape.workerInstances,
      total: WORKER_DIRECT_POOL_MAX_BUDGET * shape.workerInstances,
      runtimeRole: true,
    },
    {
      item: 'Worker scan-lock + storage-lock clients',
      each: WORKER_SCAN_LOCK_CONNECTIONS + WORKER_STORAGE_LOCK_CONNECTIONS,
      count: shape.workerInstances,
      total: (WORKER_SCAN_LOCK_CONNECTIONS + WORKER_STORAGE_LOCK_CONNECTIONS) * shape.workerInstances,
      runtimeRole: true,
    },
    {
      item: 'Worker provisioner child (until E6)',
      each: WORKER_PROVISIONER_CONNECTIONS,
      count: shape.workerInstances,
      total: WORKER_PROVISIONER_CONNECTIONS * shape.workerInstances,
      runtimeRole: false,
    },
    { item: 'rab-migrate', each: shape.migrateConnections, count: 1, total: shape.migrateConnections, runtimeRole: false },
    { item: 'boot probes + operator session', each: BOOT_PROBE_ALLOWANCE, count: 1, total: BOOT_PROBE_ALLOWANCE, runtimeRole: false },
  ];
  return {
    rows,
    total: rows.reduce((sum, r) => sum + r.total, 0),
    runtimeRoleTotal: rows.filter((r) => r.runtimeRole).reduce((sum, r) => sum + r.total, 0),
  };
}

/** Usable connection slots for ordinary (non-superuser, non-reserved) logins. Pure. */
export function usableCapacity(capacity: ServerCapacity, providerReserved: number): number {
  let usable = capacity.maxConnections - capacity.superuserReserved - capacity.reserved - capacity.providerSettingReserved - providerReserved;
  if (capacity.databaseLimit !== null && capacity.databaseLimit >= 0) usable = Math.min(usable, capacity.databaseLimit);
  return usable;
}

export function evaluateConnectionBudget(plan: BudgetPlan, capacity: ServerCapacity, providerReserved: number): BudgetEvaluation {
  const usable = usableCapacity(capacity, providerReserved);
  const problems: string[] = [];
  if (plan.total > usable) {
    problems.push(
      `the deployment can open up to ${plan.total} connections but the database allows ${usable} ` +
        `(max_connections ${capacity.maxConnections} − superuser_reserved ${capacity.superuserReserved} − reserved ${capacity.reserved}` +
        `${capacity.providerSettingReserved ? ` − provider ${capacity.providerSettingReserved}` : ''}${providerReserved ? ` − declared ${providerReserved}` : ''}` +
        `${capacity.databaseLimit !== null && capacity.databaseLimit >= 0 ? `, database limit ${capacity.databaseLimit}` : ''})`,
    );
  }
  if (capacity.roleLimit !== null && capacity.roleLimit >= 0 && plan.runtimeRoleTotal > capacity.roleLimit) {
    problems.push(`the runtime login can open up to ${plan.runtimeRoleTotal} connections but its connection limit is ${capacity.roleLimit}`);
  }
  return { ok: problems.length === 0, capacity: usable, problems };
}

export function formatBudgetTable(plan: BudgetPlan, usable: number | null): string {
  const lines = plan.rows.map((r) => `  ${r.item}: ${r.count} × ${r.each} = ${r.total}`);
  lines.push(`  total ${plan.total}${usable !== null ? ` of ${usable} usable` : ''}`);
  return lines.join('\n');
}

export const SERVER_CAPACITY_SQL = `
SELECT pg_catalog.current_setting('max_connections')::int AS max_connections,
       pg_catalog.current_setting('superuser_reserved_connections')::int AS superuser_reserved,
       COALESCE(NULLIF(pg_catalog.current_setting('reserved_connections', true), ''), '0')::int AS reserved,
       COALESCE(NULLIF(pg_catalog.current_setting('rds.rds_superuser_reserved_connections', true), ''), '0')::int AS provider_reserved,
       (SELECT r.rolconnlimit FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) AS role_limit,
       (SELECT d.datconnlimit FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AS database_limit`;

export type BudgetQuery = (sql: string) => Promise<Array<Record<string, unknown>>>;

export async function readServerCapacity(query: BudgetQuery): Promise<ServerCapacity> {
  const [row] = await query(SERVER_CAPACITY_SQL);
  if (!row) throw new ConnectionBudgetError('the database connection limits could not be read.');
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    maxConnections: Number(row.max_connections),
    superuserReserved: Number(row.superuser_reserved),
    reserved: Number(row.reserved),
    providerSettingReserved: Number(row.provider_reserved),
    roleLimit: num(row.role_limit),
    databaseLimit: num(row.database_limit),
  };
}

export type BudgetProcessRole = 'api' | 'worker';

export interface AssertConnectionBudgetInput {
  processRole: BudgetProcessRole;
  /** This process's own runtime pool max (the factory's resolved PG_POOL_MAX_CONNECTIONS). */
  ownPoolMax: number;
  env: Env;
  query: BudgetQuery;
  log?: (line: string) => void;
}

export interface ConnectionBudgetReport {
  checked: boolean;
  plan: BudgetPlan | null;
  usable: number | null;
  warnings: string[];
}

/**
 * The boot check. Throws ConnectionBudgetError (refuse to start) when the declared deployment exceeds the server, or when
 * this process's own pool exceeds the budgeted pool of its role. Warns (and returns checked: false) when the instance
 * counts are not declared.
 */
export async function assertConnectionBudget(input: AssertConnectionBudgetInput): Promise<ConnectionBudgetReport> {
  const log = input.log ?? ((line: string) => console.warn(line)); // eslint-disable-line no-console
  const { shape, missing } = readDeploymentShape(input.env);
  const budgetedOwn = input.processRole === 'api' ? (shape?.apiPoolMax ?? null) : (shape?.workerPoolMax ?? null);
  const budgetedOwnDefault =
    input.processRole === 'api'
      ? (intEnv(input.env, 'PG_EXPECTED_API_POOL_MAX', DEFAULT_API_POOL_MAX, 1, 100) as number)
      : (intEnv(input.env, 'PG_EXPECTED_WORKER_POOL_MAX', DEFAULT_WORKER_POOL_MAX, 1, 100) as number);
  const budgetName = input.processRole === 'api' ? 'PG_EXPECTED_API_POOL_MAX' : 'PG_EXPECTED_WORKER_POOL_MAX';
  if (input.ownPoolMax > (budgetedOwn ?? budgetedOwnDefault)) {
    throw new ConnectionBudgetError(
      `this ${input.processRole} process's pool max is ${input.ownPoolMax}, above the budgeted ${budgetName} ${budgetedOwn ?? budgetedOwnDefault}; ` +
        `the deployment-wide connection budget would be understated. Lower PG_POOL_MAX_CONNECTIONS or raise ${budgetName} everywhere. Refusing to start.`,
    );
  }
  if (!shape) {
    const warning = `connection budget NOT checked: ${missing.join(' and ')} not set. Declare the peak instance counts so startup can verify the database's connection limit.`;
    log(`[db-budget] WARNING ${warning}`);
    return { checked: false, plan: null, usable: null, warnings: [warning] };
  }
  const plan = planConnectionBudget(shape);
  const capacity = await readServerCapacity(input.query);
  const evaluation = evaluateConnectionBudget(plan, capacity, shape.providerReserved);
  if (!evaluation.ok) {
    throw new ConnectionBudgetError(
      `connection budget exceeded: ${evaluation.problems.join('; ')}.\n${formatBudgetTable(plan, evaluation.capacity)}\n` +
        'Lower the pool sizes or instance counts (PG_POOL_MAX_CONNECTIONS with PG_EXPECTED_*_POOL_MAX), or use a larger database plan. Refusing to start.',
    );
  }
  log(`[db-budget] ok: worst case ${plan.total} of ${evaluation.capacity} usable connections (api ${shape.apiInstances}×${shape.apiPoolMax}, worker ${shape.workerInstances}).`);
  return { checked: true, plan, usable: evaluation.capacity, warnings: [] };
}
