import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthIndicatorService, TerminusModule } from '@nestjs/terminus';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Agent, get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { createPgClientForUrl } from '../../database/postgres';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import {
  createDatabaseLoginProbeClient,
  DATABASE_LOGIN_DOWN_MESSAGE,
  DATABASE_LOGIN_PROBE_CACHE_MS,
  DATABASE_LOGIN_PROBE_CLIENT,
  DatabaseLoginHealthIndicator,
} from '../../engine/core-modules/health/database-login.health';
import { HealthController } from '../../engine/core-modules/health/health.controller';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';

/**
 * Owner decision 2026-11-13, the incident reproduced on a real PostgreSQL: the API's login has its password changed (or
 * its LOGIN revoked) in the database while the API keeps running with a warm pool.
 *   - before the fix: the pooled `database` ping keeps answering on the connection opened before the change, so /healthz
 *     stays 200 and the container stays green (asserted below: `database` is STILL up while the login is broken);
 *   - now: `databaseLogin` opens a NEW connection, sees 28P01 / 28000, and /healthz answers 503 with fixed text only;
 *   - restored: the next probe after the 5 s cache logs in again and /healthz is 200.
 * A throw-away login (`cf_hz_<hex>`) is created for this file and dropped afterwards; no shared login is ever changed.
 * The real /healthz controller is used; only its two connections point at the throw-away login.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('/healthz goes down when the API can no longer open a NEW database connection', () => {
  const role = `cf_hz_${randomBytes(4).toString('hex')}`;
  const passwordA = randomBytes(18).toString('base64url');
  const passwordB = randomBytes(18).toString('base64url');
  let admin: Client;
  let app: INestApplication;
  let pool: DataSource;
  let loginUrl: string;
  let database: string;
  let probesOpened = 0;

  beforeAll(async () => {
    const { adminUrl } = resolveIntegrationTestDatabase(process.env);
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    database = (await admin.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${passwordA}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
    const url = new URL(adminUrl);
    url.username = role;
    url.password = passwordA;
    loginUrl = url.toString();

    const moduleRef = await Test.createTestingModule({
      imports: [
        TerminusModule,
        // The API's warm pool, on the throw-away login: kept open across the password change (idle connections never expire).
        TypeOrmModule.forRoot({ type: 'postgres', url: loginUrl, entities: [], synchronize: false, extra: { max: 2, idleTimeoutMillis: 0 } }),
      ],
      controllers: [HealthController],
      providers: [
        DatabaseLoginHealthIndicator,
        // Same factory path as production (createPgClient: explicit target, TLS, startup options), on the throw-away login.
        {
          provide: DATABASE_LOGIN_PROBE_CLIENT,
          useValue: () => {
            probesOpened++;
            return createPgClientForUrl(loginUrl, 'the throw-away login URL', { purpose: 'health', readOnly: true, connectTimeoutMs: 2_500, statementTimeoutMs: 1_500, queryTimeoutMs: 1_500 });
          },
        },
      ],
    }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication({ logger: false }));
    await app.init();
    // A real listening socket for the burst below (supertest would open one ephemeral server per request).
    await app.listen(0, '127.0.0.1');
    pool = moduleRef.get<DataSource>(getDataSourceToken());
  });

  afterAll(async () => {
    await app?.close();
    if (admin) {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [role]).catch(() => undefined);
      await admin.query(`REVOKE CONNECT ON DATABASE "${database}" FROM ${role}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });

  const healthz = () => request(app.getHttpServer()).get('/healthz');
  const expectNoDetail = (text: string) => {
    for (const leak of [role, passwordA, passwordB, '28P01', '28000', 'password', 'authentication', 'postgres://', database]) expect(text).not.toContain(leak);
  };

  it('up while the login works; the pool is warm', async () => {
    await pool.query('SELECT 1');
    const res = await healthz();
    expect(res.status).toBe(200);
    expect(res.body.info).toMatchObject({ database: { status: 'up' }, databaseLogin: { status: 'up' } });
  });

  it('password changed under a running API: the pooled ping stays up (the incident) but /healthz is 503 on databaseLogin, fixed text only', async () => {
    await admin.query(`ALTER ROLE ${role} PASSWORD '${passwordB}'`);
    await sleep(DATABASE_LOGIN_PROBE_CACHE_MS + 100); // past the cached "up"
    // The incident: the warm pool still answers on its pre-change connection.
    await expect(pool.query('SELECT 1 AS ok')).resolves.toEqual([{ ok: 1 }]);
    const res = await healthz();
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({ databaseLogin: { status: 'down', message: DATABASE_LOGIN_DOWN_MESSAGE } });
    expect(res.body.details.database).toEqual({ status: 'up' });
    expectNoDetail(res.text);
  });

  it('restored: the next probe after the cache logs in again and /healthz is 200', async () => {
    await admin.query(`ALTER ROLE ${role} PASSWORD '${passwordA}'`);
    await sleep(DATABASE_LOGIN_PROBE_CACHE_MS + 100);
    const res = await healthz();
    expect(res.status).toBe(200);
    expect(res.body.info.databaseLogin).toEqual({ status: 'up' });
  });

  it('LOGIN revoked (NOLOGIN): down again; granted back: up', async () => {
    await admin.query(`ALTER ROLE ${role} NOLOGIN`);
    await sleep(DATABASE_LOGIN_PROBE_CACHE_MS + 100);
    const down = await healthz();
    expect(down.status).toBe(503);
    expect(down.body.error).toEqual({ databaseLogin: { status: 'down', message: DATABASE_LOGIN_DOWN_MESSAGE } });
    expectNoDetail(down.text);
    await admin.query(`ALTER ROLE ${role} LOGIN`);
    await sleep(DATABASE_LOGIN_PROBE_CACHE_MS + 100);
    const up = await healthz();
    expect({ status: up.status, body: up.body }).toMatchObject({ status: 200 });
  });

  it('bounded: a burst of 50 /healthz requests opens exactly one new connection', async () => {
    await sleep(DATABASE_LOGIN_PROBE_CACHE_MS + 100);
    const before = probesOpened;
    // 50 requests in flight at once over ONE keep-alive agent with 5 sockets: they queue on the agent instead of opening
    // 50 sockets (which reset under CI load: read ECONNRESET), and all of them still reach /healthz inside one probe.
    const { port } = app.getHttpServer().address() as AddressInfo;
    const agent = new Agent({ keepAlive: true, maxSockets: 5 });
    try {
      const statuses = await Promise.all(
        Array.from(
          { length: 50 },
          () =>
            new Promise<number>((resolve, reject) => {
              httpGet({ host: '127.0.0.1', port, path: '/healthz', agent }, (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
              }).on('error', reject);
            }),
        ),
      );
      expect(statuses.filter((s) => s !== 200)).toEqual([]);
    } finally {
      agent.destroy();
    }
    expect(probesOpened - before).toBe(1);
  });

  it('the production factory opens a dedicated read-only `health` session on the runtime login (no pool checkout)', async () => {
    let facts: { app: string; ro: string } | undefined;
    const indicator = new DatabaseLoginHealthIndicator(new HealthIndicatorService(), () => {
      const client = createDatabaseLoginProbeClient();
      const original = (client.query as (sql: string) => Promise<{ rows: Array<{ app: string; ro: string }> }>).bind(client);
      // Read the session facts on the probe's own connection, then run the probe's query.
      (client as unknown as { query: (sql: string) => Promise<unknown> }).query = async (sql: string) => {
        facts = (await original("SELECT current_setting('application_name') AS app, current_setting('default_transaction_read_only') AS ro")).rows[0];
        return original(sql);
      };
      return client;
    });
    await expect(indicator.isHealthy()).resolves.toEqual({ databaseLogin: { status: 'up' } });
    expect(facts?.app).toMatch(/-health$/);
    expect(facts?.ro).toBe('on');
  });
});
