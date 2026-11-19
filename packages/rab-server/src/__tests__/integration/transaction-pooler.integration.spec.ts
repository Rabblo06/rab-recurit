import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource, EntityManager } from 'typeorm';

import { createPgDataSource, isTransactionScopedPool, probePgSessionAffinity, PgSessionProbeError, pgClientConfig, resolvePgEnvironment } from '../../database/postgres';
import { coreDataSourceOptions } from '../../database/typeorm/core/core.datasource';
import { integrationTestDatabase } from '../../database/typeorm/core/integration-test-database-gate';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { SchemaResolverService } from '../../engine/core-modules/tenant/schema-resolver.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { trackFixtureOrganisation } from './helpers/fixture-workspace-tracker';

/**
 * Transaction pooler support (owner instruction 2026-11-19, "Pooler like Twenty, only if it's safe"), proven against a REAL
 * PgBouncer in pool_mode=transaction in front of the disposable test PostgreSQL, as the crewflow_owner login:
 *   - the API / Worker runtime pool (endpoint 'runtime', PG_DATABASE_URL = PgBouncer, PG_DATABASE_SESSION_URL = the direct
 *     test database) is served by the transaction-scoped client;
 *   - TWO organisations (two workspaces) run interleaved, concurrent tenant transactions (reads and writes) on FEWER server
 *     backends than clients, so their transactions share backends: no row of the other organisation is ever visible, and the
 *     RLS GUCs never leak from one transaction into the next (tenant or not);
 *   - a POISONED backend (a session-level SET ROLE rab_secure_owner plus a session-level rab.organisation_id and search_path,
 *     left behind by a plain client, the G-09 injection model) is neutralised for every later runtime transaction. The
 *     control shows the poison is real: a plain client through the same PgBouncer still runs as rab_secure_owner;
 *   - the capability probe (pg-session-probe.ts) refuses the PgBouncer URL and accepts the direct one (no host matching).
 * Fail-first: with RESET ROLE removed from the per-transaction preamble, the poisoned-backend case fails (the role assertion
 * aborts every runtime transaction on a poisoned backend) — run on InstaBox, recorded in the PR.
 *
 * Needs Docker (Linux host networking) to start the PgBouncer container (alpine + its pgbouncer package). Skipped, NOT a
 * pass, when docker is not on PATH or the test database is not the owner login.
 */
const env = integrationTestDatabase();
const OWNER = env.app.login === 'crewflow_owner';
const DOCKER = (() => {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
})();
const suite = OWNER && DOCKER ? describe : describe.skip;
if (!(OWNER && DOCKER)) {
  // eslint-disable-next-line no-console
  console.warn(`[transaction-pooler] SKIPPED (NOT a pass): ${OWNER ? '' : 'TEST_DATABASE_URL is not crewflow_owner; '}${DOCKER ? '' : 'docker is not available'}`);
}

const POOL_SIZE = 2; // PgBouncer server connections per (user, database): far fewer than clients, so backends are shared.
const CLIENTS = 12; // the runtime pool's own max
const ROWS_PER_ORG = 3;

interface Seen {
  org: string;
  rows: string[];
  orgRows: string[];
  guc: string | null;
  cu: string;
  su: string;
  pid: number;
  statementTimeout: string;
}

suite('transaction pooler: two workspaces through PgBouncer (transaction mode)', () => {
  jest.setTimeout(600_000);

  const container = `crewflow-pgbouncer-test-${randomBytes(4).toString('hex')}`;
  const port = 16_000 + Math.floor(Math.random() * 2_000);
  const appUrl = new URL(env.appUrl);
  const password = decodeURIComponent(appUrl.password);
  const bouncerUrl = (() => {
    const u = new URL(`postgres://127.0.0.1:${port}/`);
    u.username = appUrl.username;
    u.password = appUrl.password;
    u.pathname = `/${appUrl.pathname.slice(1)}`;
    u.searchParams.set('sslmode', 'disable');
    return u.toString();
  })();
  const pgEnv: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    DB_TARGET: process.env.DB_TARGET,
    PG_SSL_CA_CERT: process.env.PG_SSL_CA_CERT,
    PG_SSL_CA_CERT_PATH: process.env.PG_SSL_CA_CERT_PATH,
    PG_SSL_ALLOW_SELF_SIGNED: process.env.PG_SSL_ALLOW_SELF_SIGNED,
    PG_DATABASE_URL: bouncerUrl,
    PG_DATABASE_SESSION_URL: env.appUrl,
  };

  let admin: DataSource;
  let runtime: DataSource;
  let tenant: TenantContextService;
  const plainClients: Client[] = [];
  let orgA: string;
  let orgB: string;

  const ctx = (organisationId: string) => ({ organisationId, workspaceId: null, userId: randomUUID(), role: '' });
  const plainBouncerClient = async (): Promise<Client> => {
    const c = new Client({ connectionString: bouncerUrl, connectionTimeoutMillis: 10_000 });
    c.on('error', () => undefined);
    await c.connect();
    plainClients.push(c);
    return c;
  };

  async function readAs(organisationId: string, delayMs: number): Promise<Seen> {
    return tenant.runInTenantContext(ctx(organisationId), async (m: EntityManager) => {
      // pg_sleep inside the transaction keeps it open while the other organisation's transactions run on the other backend.
      const [row] = (await m.query(
        `SELECT pg_catalog.pg_sleep($1::double precision / 1000), pg_catalog.current_setting('rab.organisation_id', true) AS guc,
                current_user::text AS cu, session_user::text AS su, pg_catalog.pg_backend_pid() AS pid,
                pg_catalog.current_setting('statement_timeout') AS st`,
        [delayMs],
      )) as Array<{ guc: string | null; cu: string; su: string; pid: number; st: string }>;
      const rows = ((await m.query(`SELECT organisation_id::text AS org FROM core.role WHERE key LIKE 'pooler-test-%'`)) as Array<{ org: string }>).map((r) => r.org);
      const orgRows = ((await m.query(`SELECT id::text AS id FROM core.organisation WHERE id IN ($1, $2)`, [orgA, orgB])) as Array<{ id: string }>).map((r) => r.id);
      return { org: organisationId, rows, orgRows, guc: row!.guc, cu: row!.cu, su: row!.su, pid: Number(row!.pid), statementTimeout: row!.st };
    });
  }

  function expectIsolated(seen: Seen): void {
    const other = seen.org === orgA ? orgB : orgA;
    expect(seen.rows.length).toBe(ROWS_PER_ORG);
    expect(seen.rows.every((o) => o === seen.org)).toBe(true);
    expect(seen.orgRows).not.toContain(other);
    expect(seen.guc).toBe(seen.org);
    expect(seen.cu).toBe('crewflow_owner');
    expect(seen.su).toBe('crewflow_owner');
    expect(seen.statementTimeout).toBe('30s');
  }

  /** Outside any tenant context, through the runtime pool (autocommit, wrapped by the transaction-scoped client). */
  async function bareRead(): Promise<{ guc: string | null; cu: string; roles: number; search: string }> {
    const [row] = (await runtime.query(
      `SELECT pg_catalog.current_setting('rab.organisation_id', true) AS guc, current_user::text AS cu,
              (SELECT pg_catalog.count(*)::int FROM core.role WHERE key LIKE 'pooler-test-%') AS roles,
              pg_catalog.current_setting('search_path') AS search`,
    )) as Array<{ guc: string | null; cu: string; roles: number; search: string }>;
    return row!;
  }

  beforeAll(async () => {
    const config = [
      '[databases]',
      `* = host=${appUrl.hostname === 'localhost' ? '127.0.0.1' : appUrl.hostname} port=${appUrl.port || '5432'}`,
      '[pgbouncer]',
      'listen_addr = 127.0.0.1',
      `listen_port = ${port}`,
      'unix_socket_dir =',
      'auth_type = scram-sha-256',
      'auth_file = /tmp/pgb/userlist.txt',
      'pool_mode = transaction',
      `default_pool_size = ${POOL_SIZE}`,
      'min_pool_size = 0',
      'reserve_pool_size = 0',
      'max_client_conn = 200',
      'server_tls_sslmode = prefer',
      'client_tls_sslmode = disable',
      'ignore_startup_parameters = extra_float_digits',
      'server_reset_query =',
      'server_round_robin = 0',
    ].join('\n');
    const userlist = `"${decodeURIComponent(appUrl.username)}" "${password.replace(/"/g, '""')}"\n`;
    const script = [
      'set -e',
      'apk add --no-cache pgbouncer >/dev/null',
      'adduser -D -H pgb 2>/dev/null || true',
      'mkdir -p /tmp/pgb',
      'echo "$PGB_CONFIG" | base64 -d > /tmp/pgb/pgbouncer.ini',
      'echo "$PGB_USERLIST" | base64 -d > /tmp/pgb/userlist.txt',
      'chown -R pgb /tmp/pgb && chmod 600 /tmp/pgb/userlist.txt',
      'exec pgbouncer -u pgb /tmp/pgb/pgbouncer.ini',
    ].join(' && ');
    execFileSync(
      'docker',
      [
        'run', '-d', '--rm', '--name', container, '--network', 'host',
        '-e', `PGB_CONFIG=${Buffer.from(config).toString('base64')}`,
        '-e', `PGB_USERLIST=${Buffer.from(userlist).toString('base64')}`,
        'alpine:3.21', 'sh', '-c', script,
      ],
      { stdio: 'ignore', timeout: 300_000 },
    );
    const deadline = Date.now() + 240_000;
    for (;;) {
      const probe = new Client({ connectionString: bouncerUrl, connectionTimeoutMillis: 3_000 });
      probe.on('error', () => undefined);
      try {
        await probe.connect();
        await probe.query('SELECT 1');
        await probe.end();
        break;
      } catch (error) {
        await probe.end().catch(() => undefined);
        if (Date.now() > deadline) throw new Error(`PgBouncer did not become ready: ${(error as Error).message}`);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }

    admin = createAdminDataSource();
    await admin.initialize();
    const org = async (label: string) => {
      const slug = `pooler-${label}-${randomUUID()}`;
      const result = await admin.manager.insert(Organisation, { name: slug, slug });
      const id = result.identifiers[0]!.id as string;
      trackFixtureOrganisation(id);
      return id;
    };
    orgA = await org('a');
    orgB = await org('b');

    const resolved = resolvePgEnvironment(pgEnv, { processRole: 'api' });
    expect(resolved.pooled?.transactionScoped).toBe(true);
    runtime = createPgDataSource(
      resolved,
      { endpoint: 'runtime', purpose: 'runtime', max: CLIENTS },
      { name: `pooler-runtime-${randomUUID()}`, entities: coreDataSourceOptions.entities, synchronize: false, logging: false },
    );
    await runtime.initialize();
    tenant = new TenantContextService(runtime, {} as SchemaResolverService, { get: () => false } as unknown as EnvironmentService);

    // Writes through the pooler, inside each organisation's own tenant transaction.
    for (const id of [orgA, orgB]) {
      for (let i = 0; i < ROWS_PER_ORG; i += 1) {
        await tenant.runInTenantContext(ctx(id), (m) =>
          m.query(`INSERT INTO core.role (organisation_id, key, name) VALUES ($1, $2, $3)`, [id, `pooler-test-${i}-${randomUUID()}`, 'Pooler test']),
        );
      }
    }
  });

  afterAll(async () => {
    for (const c of plainClients) await c.end().catch(() => undefined);
    await runtime?.destroy().catch(() => undefined);
    if (admin?.isInitialized) {
      await admin.query(`DELETE FROM core.role WHERE key LIKE 'pooler-test-%' AND organisation_id IN ($1, $2)`, [orgA, orgB]).catch(() => undefined);
      await admin.destroy().catch(() => undefined);
    }
    try {
      execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore', timeout: 60_000 });
    } catch {
      /* already gone */
    }
  });

  it('the runtime pool is transaction-scoped and really goes through PgBouncer (the capability probe refuses it; the session URL passes)', async () => {
    expect(isTransactionScopedPool((runtime.driver as unknown as { master: unknown }).master)).toBe(true);
    const resolved = resolvePgEnvironment(pgEnv, { processRole: 'api' });
    await probePgSessionAffinity(pgClientConfig(resolved, { endpoint: 'primary', purpose: 'probe', sessionSettings: false, queryTimeoutMs: 5_000 }), { label: 'direct' });
    const noSession = resolvePgEnvironment({ ...pgEnv, PG_DATABASE_SESSION_URL: undefined }, { processRole: 'api' });
    await expect(
      probePgSessionAffinity(pgClientConfig(noSession, { endpoint: 'primary', purpose: 'probe', sessionSettings: false, queryTimeoutMs: 5_000 }), { label: 'pgbouncer' }),
    ).rejects.toBeInstanceOf(PgSessionProbeError);
  });

  it('interleaved concurrent transactions of two organisations share backends and never see each other\'s rows or GUCs', async () => {
    const work: Array<Promise<Seen>> = [];
    for (let i = 0; i < 120; i += 1) work.push(readAs(i % 2 === 0 ? orgA : orgB, (i * 7) % 15));
    const seen = await Promise.all(work);
    for (const s of seen) expectIsolated(s);
    // Proof that the pooler mixed them: fewer backends than clients, and the same backend served both organisations.
    const pidsA = new Set(seen.filter((s) => s.org === orgA).map((s) => s.pid));
    const pidsB = new Set(seen.filter((s) => s.org === orgB).map((s) => s.pid));
    const all = new Set([...pidsA, ...pidsB]);
    expect(all.size).toBeLessThanOrEqual(POOL_SIZE);
    expect([...pidsA].some((pid) => pidsB.has(pid))).toBe(true);
  });

  it('no RLS GUC leaks between transactions: bare statements interleaved with tenant transactions see no tenant and zero tenant rows', async () => {
    const work: Array<Promise<unknown>> = [];
    for (let i = 0; i < 60; i += 1) {
      work.push(readAs(i % 2 === 0 ? orgA : orgB, 3).then(expectIsolated));
      work.push(
        bareRead().then((r) => {
          expect(r.guc ?? '').toBe('');
          expect(r.roles).toBe(0);
          expect(r.cu).toBe('crewflow_owner');
        }),
      );
    }
    await Promise.all(work);
  });

  it('a poisoned backend (session SET ROLE rab_secure_owner, session rab.organisation_id, session search_path) is neutralised for every runtime transaction', async () => {
    // Poison EVERY server backend of the pool: hold POOL_SIZE plain transactions open at once (each pins its own backend),
    // set session-level state in each, then COMMIT (a non-LOCAL SET persists on the backend after COMMIT).
    const poisoners = await Promise.all(Array.from({ length: POOL_SIZE }, () => plainBouncerClient()));
    for (const c of poisoners) await c.query('BEGIN');
    const pids = new Set<number>();
    for (const c of poisoners) {
      await c.query('SET ROLE rab_secure_owner');
      await c.query(`SELECT pg_catalog.set_config('rab.organisation_id', $1, false), pg_catalog.set_config('search_path', 'pg_catalog', false)`, [orgB]);
      pids.add(Number((await c.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0].pid));
    }
    expect(pids.size).toBe(POOL_SIZE);
    for (const c of poisoners) await c.query('COMMIT');

    // Control: the poison is real. A plain client through the same PgBouncer (no transaction-scoped client) lands on a poisoned
    // backend: it runs as rab_secure_owner with organisation B bound, though it bound nothing itself.
    const control = await plainBouncerClient();
    const [ctl] = (await control.query(`SELECT current_user::text AS cu, pg_catalog.current_setting('rab.organisation_id', true) AS guc`)).rows;
    expect(ctl).toEqual({ cu: 'rab_secure_owner', guc: orgB });

    // The runtime pool: every transaction starts with RESET ROLE + the assertion + the rab.* neutralisation.
    const work: Array<Promise<unknown>> = [];
    for (let i = 0; i < 40; i += 1) {
      work.push(readAs(i % 2 === 0 ? orgA : orgB, 2).then(expectIsolated));
      work.push(
        bareRead().then((r) => {
          expect(r.cu).toBe('crewflow_owner');
          expect(r.guc ?? '').toBe('');
          expect(r.roles).toBe(0);
          expect(r.search).not.toBe('pg_catalog');
        }),
      );
    }
    await Promise.all(work);

    // RESET ROLE inside a COMMITTED runtime transaction is session-level: the backends it ran on are clean again afterwards.
    const after = (await control.query('SELECT current_user::text AS cu')).rows[0].cu;
    expect(after).toBe('crewflow_owner');
  });

  it('the per-session settings travel per transaction: a plain client through PgBouncer sees the server defaults, the runtime pool its own', async () => {
    const plain = await plainBouncerClient();
    const plainTimeout = (await plain.query(`SELECT pg_catalog.current_setting('statement_timeout') AS st`)).rows[0].st as string;
    expect(plainTimeout).not.toBe('30s');
    const [mine] = (await runtime.query(`SELECT pg_catalog.current_setting('statement_timeout') AS st, pg_catalog.current_setting('idle_in_transaction_session_timeout') AS it`)) as Array<{ st: string; it: string }>;
    expect(mine).toEqual({ st: '30s', it: '1min' });
  });
});
