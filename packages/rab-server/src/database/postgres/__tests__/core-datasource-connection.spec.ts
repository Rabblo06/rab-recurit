import { DataSource } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { coreDataSourceOptions, coreMigrationDataSource, coreMigrationDataSourceOptions } from '../../typeorm/core/core.datasource';
import { PgConfigError } from '../pg-url-policy';

// Phase B (B1): coreDataSourceOptions / coreMigrationDataSourceOptions take their connection from the factory, lazily,
// and a refused configuration is deferred to the first connection attempt (fail closed), never thrown at import.
const SECRET = 'Pw-s3cret-9f';
const KEYS = ['PG_DATABASE_URL', 'DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX', 'PG_POOL_MAX_CONNECTIONS', 'DB_TARGET'] as const;

describe('core.datasource connection fields (factory)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('runtime: explicit target, no url, runtime timeouts, application_name, explicit max', () => {
    process.env.PG_DATABASE_URL = `postgres://crewflow_app:${SECRET}@localhost:5432/rab`;
    process.env.PG_POOL_MAX_CONNECTIONS = '7';
    const o = { ...coreDataSourceOptions } as PostgresConnectionOptions;
    expect(o.url).toBeUndefined();
    expect({ host: o.host, port: o.port, username: o.username, database: o.database, ssl: o.ssl }).toEqual({
      host: 'localhost',
      port: 5432,
      username: 'crewflow_app',
      database: 'rab',
      ssl: false,
    });
    expect(o.extra).toMatchObject({
      max: 7,
      query_timeout: 30_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      options: '-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000',
      application_name: 'crewflow-api',
    });
    expect(o.migrationsTableName).toBe('core.migrations');
  });

  it('migration: the elevated legacy URL when set, else the primary; 15/16-minute timeouts; crewflow-migrate', () => {
    process.env.DATABASE_URL = `postgres://crewflow_app:${SECRET}@localhost:5432/rab`;
    process.env.DATABASE_URL_UNPOOLED = `postgres://crewflow:${SECRET}@localhost:5432/rab`;
    const legacy = { ...coreMigrationDataSourceOptions } as PostgresConnectionOptions;
    expect(legacy.username).toBe('crewflow');
    expect(legacy.extra).toMatchObject({
      query_timeout: 960_000,
      options: '-c statement_timeout=900000 -c idle_in_transaction_session_timeout=60000',
      application_name: 'crewflow-migrate',
    });
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_UNPOOLED;
    process.env.PG_DATABASE_URL = `postgres://crewflow_migrator:${SECRET}@localhost:5432/rab`;
    expect(({ ...coreMigrationDataSourceOptions } as PostgresConnectionOptions).username).toBe('crewflow_migrator');
    expect((coreMigrationDataSourceOptions as PostgresConnectionOptions).entities).toBe(coreDataSourceOptions.entities);
  });

  it('a refused configuration is deferred: reading the options does not throw, connecting rejects with the PgConfigError', async () => {
    process.env.PG_DATABASE_URL = `postgres://crewflow_app:${SECRET}@localhost:5432/rab`;
    process.env.PG_POOL_MAX_CONNECTIONS = 'abc';
    expect(() => ({ ...coreDataSourceOptions })).not.toThrow();
    const ds = new DataSource({ ...coreDataSourceOptions, name: 'deferred-refusal' } as PostgresConnectionOptions);
    const error = await ds.initialize().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PgConfigError);
    expect((error as Error).message).toMatch(/PG_POOL_MAX_CONNECTIONS must be a whole number/);
    expect((error as Error).message).not.toContain(SECRET);
    await expect(coreMigrationDataSource.initialize()).rejects.toBeInstanceOf(PgConfigError);
  });

  it('a transaction-pooler URL is refused for the migration connection', async () => {
    process.env.PG_DATABASE_URL = `postgres://crewflow_migrator:${SECRET}@ep-a-1-pooler.eu-west-2.aws.neon.tech/neondb`;
    await expect(coreMigrationDataSource.initialize()).rejects.toThrow(/The migrate process holds session advisory locks/);
  });
});
