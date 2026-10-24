import 'reflect-metadata';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { SCAN_LOCK_NAMESPACE, ScanLock, scanLockName } from '../../core/locking/scan-lock';
import { SCAN_JOBS, schedulerIdOf } from '../../core/scheduler/scan-jobs';
import { LOGIN_HANDOFF_CLEANUP_LOCK } from '../../queues/rab-maintenance/login-handoff-cleanup.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TEST_DATABASE_CREWFLOW_URL, verifiedCrewflowUrl } from './helpers/verified-role-database';

/**
 * Lane A M3/M7 — the per-scan cluster lock on a REAL PostgreSQL (disposable test database), as crewflow_app.
 */
jest.setTimeout(120_000);
const APP_URL = process.env.DATABASE_URL;
const describeIfDb = APP_URL ? describe : describe.skip;
const logger = { log: jest.fn(), warn: jest.fn() };
const ID = 'crewflow:crewflow-scan-shifts:shift-monitor';

describeIfDb('scan lock (integration, crewflow_app)', () => {
  let admin: DataSource;
  beforeAll(async () => {
    admin = createAdminDataSource();
    await admin.initialize();
  });
  afterAll(async () => {
    await admin?.destroy();
  });

  it('one dedicated crewflow_app session; the second replica skips while the first holds the lock; released afterwards', async () => {
    const a = await ScanLock.open(APP_URL!, logger);
    const b = await ScanLock.open(APP_URL!, logger);
    let release!: () => void;
    const held = a.run(ID, () => new Promise<string>((r) => (release = () => r('done'))));
    await new Promise((r) => setTimeout(r, 100));
    const ran = jest.fn();
    await expect(b.run(ID, async () => ran())).resolves.toEqual({ acquired: false });
    expect(ran).not.toHaveBeenCalled();
    // A different scan is independent.
    await expect(b.run('crewflow:crewflow-scan-shifts:late-clock-in', async () => 'x')).resolves.toEqual({ acquired: true, value: 'x' });
    // Session identity: the lock lives on a crewflow_app backend.
    const holders: Array<{ usename: string }> = await admin.query(
      `SELECT a.usename FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND l.granted AND a.pid <> pg_backend_pid()`,
    );
    expect(holders.length).toBeGreaterThanOrEqual(1);
    expect(new Set(holders.map((h) => h.usename))).toEqual(new Set(['crewflow_app']));
    release();
    await expect(held).resolves.toEqual({ acquired: true, value: 'done' });
    await expect(b.run(ID, async () => 'second')).resolves.toEqual({ acquired: true, value: 'second' });
    expect(a.heldCount).toBe(0);
    await a.close();
    await b.close();
  });

  it('separate key namespace: no scan-lock key equals an inner cycle lock key', async () => {
    const outer = SCAN_JOBS.map((d) => scanLockName(schedulerIdOf(d)));
    expect(outer.every((n) => n.startsWith(SCAN_LOCK_NAMESPACE))).toBe(true);
    const inner = [LOGIN_HANDOFF_CLEANUP_LOCK, 'crewflow:outbox-retention:v1', 'shift_report:00000000-0000-0000-0000-000000000000', 'final_timesheet:00000000-0000-0000-0000-000000000000'];
    const rows: Array<{ k: string }> = await admin.query(`SELECT hashtextextended(n, 0)::text AS k FROM unnest($1::text[]) n`, [outer]);
    const innerRows: Array<{ k: string }> = await admin.query(
      `SELECT hashtextextended(n, 0)::text AS k FROM unnest($1::text[]) n UNION ALL SELECT hashtext('rab_account_invite_cleanup')::bigint::text`,
      [inner],
    );
    const outerKeys = new Set(rows.map((r) => r.k));
    expect(outerKeys.size).toBe(19);
    for (const r of innerRows) expect(outerKeys.has(r.k)).toBe(false);
  });

  it('a killed lock session releases its locks (crash-safe); the client reconnects and the scan is lockable again', async () => {
    const a = await ScanLock.open(APP_URL!, { log: jest.fn(), warn: jest.fn() });
    const b = await ScanLock.open(APP_URL!, logger);
    let release!: () => void;
    const held = a.run(ID, async () => {
      await new Promise<void>((r) => (release = r));
      return 'interrupted';
    });
    await new Promise((r) => setTimeout(r, 100));
    await expect(b.run(ID, async () => 'nope')).resolves.toEqual({ acquired: false });
    // Kill every crewflow_app backend holding an advisory lock (A's lock session).
    await admin.query(
      `SELECT pg_terminate_backend(l.pid) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND a.usename = 'crewflow_app' AND a.pid <> pg_backend_pid()`,
    );
    await new Promise((r) => setTimeout(r, 300));
    // B (a live session) can take it now: the server released A's lock with A's session.
    await expect(b.run(ID, async () => 'taken-over')).resolves.toEqual({ acquired: true, value: 'taken-over' });
    release();
    // A's work finishes; its release is skipped (never an unlock on a NEW session) and nothing throws.
    await expect(held).resolves.toEqual({ acquired: true, value: 'interrupted' });
    // A's client reconnects on the next use (backoff permitting) — retry briefly.
    let again: unknown;
    for (let i = 0; i < 20; i += 1) {
      again = await a.run(ID, async () => 'reconnected').catch((e: Error) => e);
      if (!(again instanceof Error)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(again).toEqual({ acquired: true, value: 'reconnected' });
    await a.close();
    await b.close();
  });

  it('refuses a lock connection that is not crewflow_app itself (fails closed at startup)', async () => {
    if (!process.env[TEST_DATABASE_CREWFLOW_URL]) return; // the privileged test URL is optional
    const crewflowUrl = await verifiedCrewflowUrl();
    await expect(ScanLock.open(crewflowUrl, logger)).rejects.toThrow(/Refusing to start: DATABASE_URL connects as "crewflow", not "crewflow_app"/);
    // Leak check: an unreachable lock database fails without printing the URL.
    const bad = 'postgres://crewflow_app:hunter2-not-a-real-password@127.0.0.1:1/rab';
    const error = await ScanLock.open(bad, logger).catch((e: Error) => e);
    expect(error).toBeTruthy();
    expect(String((error as Error).message)).not.toContain('hunter2');
  });

  it('no tenant context bound → the lock connection sees zero tenant rows (it is only ever used for advisory locks)', async () => {
    const client = new Client({ connectionString: APP_URL });
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM core.email_outbox`);
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});
