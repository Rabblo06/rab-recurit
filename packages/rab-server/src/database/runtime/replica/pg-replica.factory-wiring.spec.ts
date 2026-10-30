/**
 * Phase B (A7 integration of B4): the replica service finds its URL through the connection factory
 * (readReplicaDatabaseUrl → PG_DATABASE_REPLICA_URL) and builds its pool through createPgDataSource with the replica role,
 * the replica label and the short 2 s connect timeout. No database: createPgDataSource is captured, and the replica's
 * initialize() fails as an unreachable server would, so the service must end up CONFIGURED-but-unavailable (reads on the
 * primary, probe would retry) — never "not-configured".
 */
const built: Array<{ request: Record<string, unknown>; base: Record<string, unknown>; config: Record<string, unknown> }> = [];

jest.mock('../../postgres', () => {
  const actual = jest.requireActual('../../postgres');
  return {
    ...actual,
    createPgDataSource: jest.fn((resolved, request, base) => {
      // The real factory config for the same request, to prove the options it would hand to pg.
      built.push({ request, base, config: actual.pgPoolConfig(resolved, request) });
      return {
        isInitialized: false,
        initialize: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        },
        destroy: async () => undefined,
      };
    }),
  };
});

import { DataSource } from 'typeorm';

import { REPLICA_CONNECT_TIMEOUT_MS, PgReplicaService } from './pg-replica.service';
import { DatabaseMetrics } from '../database-metrics';

const PRIMARY = 'postgres://crewflow_app:not-a-real-password@127.0.0.1:5432/rab';
const REPLICA = 'postgres://crewflow_app:not-a-real-password@127.0.0.1:5433/rab';
const primary = { options: { entities: [], logging: false } } as unknown as DataSource;

function service(env: Record<string, string | undefined>): PgReplicaService {
  return new PgReplicaService(primary, { enabled: true, env, startProbe: false, metrics: new DatabaseMetrics() });
}

beforeEach(() => {
  built.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('PgReplicaService ↔ connection factory', () => {
  it('PG_DATABASE_REPLICA_URL unset: not configured, no pool built', async () => {
    const s = service({ PG_DATABASE_URL: PRIMARY });
    await s.onModuleInit();
    expect(s.currentState).toBe('not-configured');
    expect(built).toHaveLength(0);
    expect(s.routeRead()).toEqual({ dataSource: null, reason: 'not-configured' });
  });

  it('PG_DATABASE_REPLICA_URL set: the factory builds the replica pool (replica role, label, 2 s connect timeout, read-only session)', async () => {
    const s = service({ PG_DATABASE_URL: PRIMARY, PG_DATABASE_REPLICA_URL: ` ${REPLICA} ` });
    await s.onModuleInit();
    expect(built).toHaveLength(1);
    const [{ request, config }] = built;
    expect(request).toMatchObject({ url: REPLICA, urlLabel: 'PG_DATABASE_REPLICA_URL', role: 'replica', purpose: 'runtime', connectTimeoutMs: REPLICA_CONNECT_TIMEOUT_MS });
    expect(REPLICA_CONNECT_TIMEOUT_MS).toBe(2_000);
    expect(config).toMatchObject({ port: 5433, connectionTimeoutMillis: 2_000, application_name: 'crewflow-api-replica' });
    expect(String(config.options)).toContain('-c default_transaction_read_only=on');
    expect(config).not.toHaveProperty('connectionString');
    // Unreachable at startup: configured, reads fall back to the primary, never "not-configured".
    expect(s.currentState).toBe('unavailable');
    expect(s.routeRead()).toEqual({ dataSource: null, reason: 'unavailable' });
  });

  it('a replica URL naming the primary is refused by the factory', async () => {
    const s = service({ PG_DATABASE_URL: PRIMARY, PG_DATABASE_REPLICA_URL: PRIMARY });
    await expect(s.onModuleInit()).rejects.toThrow(/PG_DATABASE_REPLICA_URL names the primary/);
  });
});
