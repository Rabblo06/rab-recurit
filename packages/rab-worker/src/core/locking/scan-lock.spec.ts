import type { ClientConfig } from 'pg';

/**
 * Phase B: ScanLock.open() and the schema-drift cycle take a pg ClientConfig from the connection factory instead of a URL
 * string. Unit-level: the config reaches the driver unchanged (target, TLS object, application_name, startup options) with
 * each call site's own short timeouts on top, and no connection string is ever built.
 */
const constructed: ClientConfig[] = [];

jest.mock('../database/reconnecting-pg-client', () => ({
  ReconnectingPgClient: class {
    constructor(config: ClientConfig) {
      constructed.push(config);
    }
    async acquire() {
      return { query: async () => ({ rows: [] }) };
    }
    async close() {
      return undefined;
    }
  },
}));
jest.mock('@rab/server/engine/utils/assert-runtime-db-role', () => ({ assertRuntimeDbRole: jest.fn(async () => undefined) }));

const driftClients: ClientConfig[] = [];
jest.mock('pg', () => ({
  Client: class {
    constructor(config: ClientConfig) {
      driftClients.push(config);
    }
    on() {
      return this;
    }
    async connect() {
      return undefined;
    }
    async end() {
      return undefined;
    }
  },
}));
jest.mock('@rab/server/database/typeorm/workspace-schema/workspace-schema-drift', () => ({
  checkWorkspaceSchemaDrift: jest.fn(async () => ({ checked: 0, ok: 0, notReady: 0, findings: [] })),
}));

import { runWorkspaceSchemaDriftCycle } from '../../queues/rab-maintenance/workspace-schema-drift.job';
import { ScanLock } from './scan-lock';

const factoryConfig = (): ClientConfig & { enableChannelBinding?: boolean } => ({
  host: 'db.internal',
  port: 5432,
  user: 'crewflow_app',
  password: 'not-a-real-password',
  database: 'rab',
  ssl: { rejectUnauthorized: true, ca: 'PEM' },
  options: '-c statement_timeout=5000 -c idle_in_transaction_session_timeout=60000',
  application_name: 'crewflow-worker-scan-lock',
  query_timeout: 5_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

describe('ScanLock.open (Phase B: factory ClientConfig, never a URL)', () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  it('passes the factory config through with the 5 s lock timeouts and keep-alive; no connectionString', async () => {
    const lock = await ScanLock.open(factoryConfig(), { log: () => undefined, warn: () => undefined });
    expect(constructed).toHaveLength(1);
    const [config] = constructed;
    expect(config).not.toHaveProperty('connectionString');
    expect(config).toMatchObject({
      host: 'db.internal',
      user: 'crewflow_app',
      database: 'rab',
      ssl: { rejectUnauthorized: true, ca: 'PEM' },
      application_name: 'crewflow-worker-scan-lock',
      options: '-c statement_timeout=5000 -c idle_in_transaction_session_timeout=60000',
      statement_timeout: 5_000,
      query_timeout: 5_000,
      keepAlive: true,
      connectionTimeoutMillis: 10_000,
    });
    await lock.close();
  });

  it('the lock timeouts win over a caller that asked for longer ones', async () => {
    await ScanLock.open({ ...factoryConfig(), query_timeout: 30_000, statement_timeout: 30_000 }, { log: () => undefined, warn: () => undefined });
    expect(constructed[0]).toMatchObject({ statement_timeout: 5_000, query_timeout: 5_000 });
  });
});

describe('runWorkspaceSchemaDriftCycle (Phase B: factory ClientConfig)', () => {
  it('connects with the given config plus its own 60 s statement timeout', async () => {
    driftClients.length = 0;
    const result = await runWorkspaceSchemaDriftCycle({ ...factoryConfig(), user: 'crewflow', application_name: 'crewflow-provisioner-drift' });
    expect(result).toEqual({ checked: 0, ok: 0, notReady: 0, findings: [] });
    expect(driftClients).toHaveLength(1);
    expect(driftClients[0]).not.toHaveProperty('connectionString');
    expect(driftClients[0]).toMatchObject({ user: 'crewflow', application_name: 'crewflow-provisioner-drift', statement_timeout: 60_000, connectionTimeoutMillis: 10_000 });
  });
});
