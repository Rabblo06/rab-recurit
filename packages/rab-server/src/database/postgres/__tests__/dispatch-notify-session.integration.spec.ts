import { createPgDataSource, createPgPool } from '../create-pg-pool';
import { PgProcessRole, resolvePgEnvironment } from '../pg-config';

/**
 * Phase D, SQL review E-1, against the disposable test database (the restricted runtime login): the session setting
 * `crewflow.dispatch_notify` really reaches the server — 'on' for API/Worker sessions only in WORKER_DISPATCH_MODE=event,
 * absent otherwise — for a pg Pool across a reconnect (a NEW backend) and for a TypeORM DataSource. Setting a custom GUC
 * is a session parameter, not migration SQL; nothing is written.
 */
const appUrl = process.env.TEST_DATABASE_URL;
const describeDb = appUrl ? describe : describe.skip;

const SHOW = `SELECT pg_catalog.current_setting('crewflow.dispatch_notify', true) AS v, pg_catalog.pg_backend_pid() AS pid`;

function resolved(processRole: PgProcessRole, mode?: string) {
  return resolvePgEnvironment({ NODE_ENV: 'test', PG_DATABASE_URL: appUrl, ...(mode ? { WORKER_DISPATCH_MODE: mode } : {}) }, { processRole, enforceProcessPolicy: false });
}

describeDb('crewflow.dispatch_notify on a real PostgreSQL', () => {
  it.each(['api', 'worker'] as const)('%s: on in event mode, and still on after the pool reconnects (new backend)', async (role) => {
    const pool = createPgPool(resolved(role, 'event'), { purpose: 'runtime', max: 1 });
    try {
      const first = await pool.connect();
      const a = (await first.query(SHOW)).rows[0];
      first.release(true); // destroy the connection: the next checkout opens a new backend
      const second = await pool.connect();
      const b = (await second.query(SHOW)).rows[0];
      second.release();
      expect(a.v).toBe('on');
      expect(b.v).toBe('on');
      expect(b.pid).not.toBe(a.pid);
    } finally {
      await pool.end();
    }
  });

  it.each([undefined, 'poll'])('mode %p: the setting is absent (zero NOTIFY)', async (mode) => {
    const pool = createPgPool(resolved('api', mode), { purpose: 'runtime', max: 1 });
    try {
      expect((await pool.query(SHOW)).rows[0].v ?? null).toBeNull();
    } finally {
      await pool.end();
    }
  });

  it('the Worker lock endpoint and a TypeORM DataSource carry it; a CLI session never does', async () => {
    const lock = createPgPool(resolved('worker', 'event'), { endpoint: 'lock', purpose: 'lock', max: 1 });
    const cli = createPgPool(resolved('cli', 'event'), { purpose: 'runtime', max: 1 });
    const ds = createPgDataSource(resolved('api', 'event'), { purpose: 'runtime', max: 1 }, { name: `dispatch-notify-${Date.now()}`, entities: [] });
    await ds.initialize();
    try {
      expect((await lock.query(SHOW)).rows[0].v).toBe('on');
      expect((await cli.query(SHOW)).rows[0].v ?? null).toBeNull();
      expect((await ds.query(SHOW))[0].v).toBe('on');
    } finally {
      await lock.end();
      await cli.end();
      await ds.destroy();
    }
  });
});
