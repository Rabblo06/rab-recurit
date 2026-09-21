import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '../../modules/attendance/services/attendance-qr.service';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { beginRlsDiscovery, isLockUnavailable } from '../../queue-worker/shared/discovery-lock';
import { createAdminDataSource } from '../integration/helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from '../integration/helpers/test-identities';

/**
 * ATTENDANCE CLOCK-IN LOAD TEST (opt-in — excluded from the default suite; run with
 * `RAB_LOAD_TEST=1 npx jest --config jest.config.ts --testPathIgnorePatterns=/node_modules/ attendance-clock-in.load`).
 *
 * What is REAL: the API is the COMPILED production build (`dist/main.js`) running as a separate OS process on a
 * real TCP port, against the real PostgreSQL (forced RLS, `rab_app`) and real Redis; every request is a genuine
 * HTTP `POST /rest/v1/attendance/clock-in` carrying a real JWT for a distinct, legitimately assigned, CONFIRMED
 * staff member, a real signed shift QR, and a real GPS payload inside the geofence. Auth, the QR check, the
 * geofence check, the global IP throttler and the per-user throttler are ALL active — nothing is bypassed.
 *
 * What is emulated (and labelled so): each simulated phone sends its own `CF-Connecting-IP` (10.x.y.z), because
 * in production every phone reaches the API from its own address through Cloudflare. Without this, one load
 * generator IP would trip the per-IP throttle (120/min) — a property of the test rig, not of the system.
 *
 * Limits of this rig: the load generator, PostgreSQL, Redis and the API all share ONE Windows developer machine,
 * so absolute latencies are not production numbers; they are a same-machine baseline and a correctness test under
 * contention (no 5xx, no duplicate rows, no deadlocks).
 */
const RUN = process.env.RAB_LOAD_TEST === '1';
const describeIf = RUN ? describe : describe.skip;
jest.setTimeout(30 * 60_000);

const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}/rest/v1`;
const INSIDE = { lat: 51.508, lng: -0.1281, accuracyM: 6 };
const TIERS = [10, 25, 50, 100];
const MIN = 60_000;
const OUT = process.env.RAB_LOAD_OUT ?? 'C:/Rab-recruit/.audit/prod-readiness/load-results.json';

interface Sample { status: number; ms: number }
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

function procStats(pid: number): { rssMb: number; cpuSeconds: number } {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid}; "{0} {1}" -f $p.WorkingSet64, $p.TotalProcessorTime.TotalSeconds`], { encoding: 'utf8' }).trim();
  const [ws, cpu] = out.split(' ');
  return { rssMb: Number(ws) / 1024 / 1024, cpuSeconds: Number((cpu ?? '0').replace(',', '.')) };
}

describeIf('clock-in load test', () => {
  let app: INestApplication;
  let api: ChildProcess;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let qr: AttendanceQrService;
  let factory: TestIdentityFactory;
  let redis: Redis;
  let monitor: DataSource; // superuser, read-only: sees every backend's state / wait events (rab_owner cannot)
  let org: Awaited<ReturnType<TestIdentityFactory['createOrganisation']>>;
  let im: TestIdentity;
  let vm: TestIdentity;
  let venueId: string;
  let jobRoleId: string;
  const results: Record<string, unknown> = {};

  let seedUrl = '';
  const http = () => request(seedUrl);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const ctx = () => ({ organisationId: org.id, workspaceId: im.workspaceId, userId: im.userId, role: '' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0); // ONE real listener: supertest's per-request ephemeral listen() breaks under concurrent calls
    seedUrl = await app.getUrl();
    tenantContext = moduleRef.get(TenantContextService);
    qr = moduleRef.get(AttendanceQrService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    redis = new Redis(process.env.REDIS_URL!);
    monitor = new DataSource({ type: 'postgres', url: process.env.RAB_LOAD_MONITOR_URL ?? 'postgres://rab:rab@localhost:55432/rab', entities: [] });
    await monitor.initialize();

    // The API under test: the compiled production build, its own process, its own pools.
    api = spawn('node', ['packages/rab-server/dist/main.js'], {
      cwd: 'C:/Rab-recruit',
      env: { ...process.env, PORT: String(PORT), EMAIL_DRIVER: 'LOGGER', JEST_WORKER_ID: undefined, RAB_DISABLE_RATE_LIMIT: undefined, NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let booted = false;
    api.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('listening on')) booted = true; });
    api.stderr!.on('data', () => undefined);
    for (let i = 0; i < 120 && !booted; i += 1) await new Promise((r) => setTimeout(r, 500));
    if (!booted) throw new Error('API process did not boot');

    org = await factory.createOrganisation('load');
    im = await factory.createInternalManager(org);
    const imToken = await factory.login(im);
    const venue = await http().post('/rest/v1/venues').set(auth(imToken)).send({ name: 'Load Hotel', type: 'hotel', lat: 51.508, lng: -0.1281, geofenceRadiusM: 100, enforceGeofence: true });
    venueId = venue.body.id;
    jobRoleId = (await http().post('/rest/v1/job-roles').set(auth(imToken)).send({ name: 'Bar', defaultRatePence: 1500 })).body.id;
    vm = await factory.createVenueManager(org, { owner: im, venueIds: [venueId] });
  }, 240_000);

  afterAll(async () => {
    writeFileSync(OUT, JSON.stringify(results, null, 2));
    api?.kill();
    await redis?.quit();
    await app?.close();
    await adminDataSource?.destroy();
    await monitor?.destroy();
  });

  /** Seeds one CONFIRMED shift (starting in 10 min, i.e. inside the clock-in window) for `n` distinct staff; returns their tokens + QR. */
  async function seedShift(n: number): Promise<{ shiftId: string; qrToken: string; staff: Array<{ token: string; profileId: string }> }> {
    const imToken = await factory.login(im);
    const vmToken = await factory.login(vm);
    const staff: TestIdentity[] = [];
    for (let i = 0; i < n; i += 5) {
      staff.push(...(await Promise.all(Array.from({ length: Math.min(5, n - i) }, (_, k) => factory.createStaff(org, { owner: im, label: `ld${n}-${i + k}` })))));
    }
    for (let i = 0; i < n; i += 10) {
      await Promise.all(staff.slice(i, i + 10).map((s) => http().post(`/rest/v1/staff/venue-directory/team/${s.profileId}`).set(auth(vmToken))));
    }
    const startsAt = new Date(Date.now() + 10 * MIN);
    const shift = await http()
      .post('/rest/v1/shifts/request')
      .set(auth(vmToken))
      .send({ venueId, jobRoleId, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 8 * 60 * MIN).toISOString(), staffRequired: n, staffProfileIds: staff.map((s) => s.profileId), breakMinutes: 30 });
    expect(shift.status).toBe(201);
    expect((await http().post(`/rest/v1/shifts/${shift.body.id}/approve`).set(auth(imToken)).send({})).status).toBeLessThan(300);
    const tokens: Array<{ token: string; profileId: string }> = [];
    for (let i = 0; i < n; i += 10) {
      const batch = await Promise.all(
        staff.slice(i, i + 10).map(async (s) => {
          const token = await factory.login(s);
          const offers = await http().get('/rest/v1/offers/mine').set(auth(token));
          const list = (offers.body.data ?? offers.body) as Array<{ id: string }>;
          const accepted = await http().post(`/rest/v1/offers/${list[0]!.id}/accept`).set(auth(token));
          expect(accepted.status).toBeLessThan(300);
          return { token, profileId: s.profileId as string };
        }),
      );
      tokens.push(...batch);
    }
    const qrToken = await tenantContext.runInTenantContext(ctx(), async (m) => qr.sign(await m.findOneByOrFail(Shift, { id: shift.body.id })));
    return { shiftId: shift.body.id, qrToken, staff: tokens };
  }

  async function dbSnapshot() {
    const [row] = await adminDataSource.query(`SELECT deadlocks, xact_commit, xact_rollback FROM pg_stat_database WHERE datname = current_database()`);
    return row as { deadlocks: string; xact_commit: string; xact_rollback: string };
  }

  async function fireTier(label: string, shiftId: string, qrToken: string, clients: Array<{ token: string }>, ipBase: number) {
    // Warm every client's keep-alive connection first (auth'd read, not the endpoint under test).
    await Promise.all(clients.map((c, i) => fetch(`${BASE}/auth/capabilities`, { headers: { Authorization: `Bearer ${c.token}`, 'CF-Connecting-IP': `10.${ipBase}.${Math.floor(i / 250)}.${(i % 250) + 1}` } }).then((r) => r.arrayBuffer())));

    const before = procStats(api.pid!);
    const dbBefore = await dbSnapshot();
    const redisBefore = Number(/total_commands_processed:(\d+)/.exec(await redis.info('stats'))![1]);
    let maxLockWaiters = 0;
    let maxActive = 0;
    let maxTotal = 0;
    let maxUngranted = 0;
    const waitSeen = new Map<string, number>();
    let peakRss = before.rssMb;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const [r] = await monitor.query(
          `SELECT count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS lock_waiters, count(*) FILTER (WHERE state = 'active')::int AS active, count(*)::int AS total,
                  (SELECT count(*)::int FROM pg_locks WHERE NOT granted) AS ungranted
             FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename = 'rab_app'`,
        );
        if (r.lock_waiters > 0) {
          const waits = await monitor.query(
            `SELECT l.locktype, coalesce(c.relname, '') AS rel, left(a.query, 110) AS q
               FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid LEFT JOIN pg_class c ON c.oid = l.relation
              WHERE NOT l.granted AND a.usename = 'rab_app'`,
          );
          for (const w of waits as Array<{ locktype: string; rel: string; q: string }>) {
            const k = `${w.locktype} ${w.rel} :: ${w.q}`;
            waitSeen.set(k, (waitSeen.get(k) ?? 0) + 1);
          }
        }
        maxTotal = Math.max(maxTotal, r.total);
        maxUngranted = Math.max(maxUngranted, r.ungranted);
        maxLockWaiters = Math.max(maxLockWaiters, r.lock_waiters);
        maxActive = Math.max(maxActive, r.active);
        await new Promise((res) => setTimeout(res, 10));
      }
    })();
    const rssSampler = (async () => {
      while (sampling) {
        try { peakRss = Math.max(peakRss, procStats(api.pid!).rssMb); } catch { /* sampling only */ }
        await new Promise((res) => setTimeout(res, 400));
      }
    })();

    const started = performance.now();
    const samples: Sample[] = await Promise.all(
      clients.map(async (c, i): Promise<Sample> => {
        const t0 = performance.now();
        const res = await fetch(`${BASE}/attendance/clock-in`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${c.token}`, 'content-type': 'application/json', 'CF-Connecting-IP': `10.${ipBase}.${Math.floor(i / 250)}.${(i % 250) + 1}` },
          body: JSON.stringify({ shiftId, qrToken, ...INSIDE }),
        });
        await res.arrayBuffer();
        return { status: res.status, ms: performance.now() - t0 };
      }),
    );
    const wallMs = performance.now() - started;
    sampling = false;
    await Promise.all([sampler, rssSampler]);
    const after = procStats(api.pid!);
    const dbAfter = await dbSnapshot();
    const redisAfter = Number(/total_commands_processed:(\d+)/.exec(await redis.info('stats'))![1]);

    const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
    const byStatus: Record<string, number> = {};
    for (const s of samples) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    const rows = await tenantContext.runInTenantContext(ctx(), (m) => m.query(`SELECT count(*)::int AS n, count(DISTINCT staff_profile_id)::int AS distinct_staff FROM core.attendance WHERE shift_id = $1`, [shiftId]));
    const ok = byStatus['201'] ?? 0;
    const summary = {
      label,
      concurrentClockIns: clients.length,
      statusCodes: byStatus,
      errorRatePct: Number((((samples.length - ok) / samples.length) * 100).toFixed(2)),
      serverErrors5xx: samples.filter((s) => s.status >= 500).length,
      latencyMs: { p50: Number(pct(lat, 50).toFixed(1)), p95: Number(pct(lat, 95).toFixed(1)), p99: Number(pct(lat, 99).toFixed(1)), max: Number(lat[lat.length - 1]!.toFixed(1)) },
      wallMs: Number(wallMs.toFixed(0)),
      throughputRps: Number((clients.length / (wallMs / 1000)).toFixed(1)),
      db: { attendanceRows: rows[0].n, distinctStaff: rows[0].distinct_staff, maxLockWaiters, maxUngrantedLocks: maxUngranted, maxActiveBackends: maxActive, maxRabAppConnections: maxTotal, deadlocksDelta: Number(dbAfter.deadlocks) - Number(dbBefore.deadlocks), rollbacksDelta: Number(dbAfter.xact_rollback) - Number(dbBefore.xact_rollback) },
      lockWaitSamples: [...waitSeen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
      redis: { commandsDelta: redisAfter - redisBefore },
      api: { cpuSeconds: Number((after.cpuSeconds - before.cpuSeconds).toFixed(2)), cpuPctOfOneCore: Number((((after.cpuSeconds - before.cpuSeconds) / (wallMs / 1000)) * 100).toFixed(0)), rssMbBefore: Number(before.rssMb.toFixed(0)), rssMbPeak: Number(peakRss.toFixed(0)) },
    };
    results[label] = summary;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary));
    return summary;
  }

  it.each(TIERS)('%i simultaneous, legitimate clock-ins on one shift', async (n) => {
    const { shiftId, qrToken, staff } = await seedShift(n);
    const s = await fireTier(`tier-${n}`, shiftId, qrToken, staff, n === 10 ? 1 : n === 25 ? 2 : n === 50 ? 3 : 4);
    // Correctness under contention: every legitimate clock-in succeeded exactly once, nothing 5xx, no duplicate rows, no deadlock.
    expect(s.statusCodes).toEqual({ 201: n });
    expect(s.db.attendanceRows).toBe(n);
    expect(s.db.distinctStaff).toBe(n);
    expect(s.db.deadlocksDelta).toBe(0);
  });

  it('100 clock-ins WHILE worker-style discovery hammers the tables (ALTER TABLE ... DISABLE/ENABLE ROW LEVEL SECURITY at ~20 Hz)', async () => {
    const { shiftId, qrToken, staff } = await seedShift(100);
    let stop = false;
    let cycles = 0;
    let yielded = 0;
    let slowestCycleMs = 0;
    // The worker's two-phase discovery brackets its cross-tenant scan in DISABLE/ENABLE RLS (ACCESS EXCLUSIVE on the
    // table until commit). The real cadence is one scan per job per 5 minutes; this is ~1000x more aggressive.
    const hammer = (async () => {
      while (!stop) {
        const t0 = performance.now();
        try {
          await adminDataSource.transaction(async (m) => {
            await beginRlsDiscovery(m); // the production policy: bounded wait, then yield to API traffic
            await m.query(`ALTER TABLE core.shift DISABLE ROW LEVEL SECURITY`);
            await m.query(`ALTER TABLE core.shift_assignment DISABLE ROW LEVEL SECURITY`);
            await m.query(`SELECT id FROM core.shift WHERE starts_at > now() AND starts_at < now() + interval '4 hours' LIMIT 500`);
            await m.query(`ALTER TABLE core.shift ENABLE ROW LEVEL SECURITY`);
            await m.query(`ALTER TABLE core.shift_assignment ENABLE ROW LEVEL SECURITY`);
          });
        } catch (error) {
          if (!isLockUnavailable(error)) throw error;
          yielded += 1; // the scan yielded to clock-in traffic; production retries on its next tick
        }
        slowestCycleMs = Math.max(slowestCycleMs, performance.now() - t0);
        cycles += 1;
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    const s = await fireTier('tier-100-with-worker-discovery-hammer', shiftId, qrToken, staff, 5);
    stop = true;
    await hammer;
    (results['tier-100-with-worker-discovery-hammer'] as Record<string, unknown>).hammer = { discoveryCycles: cycles, cyclesThatYielded: yielded, slowestDiscoveryCycleMs: Number(slowestCycleMs.toFixed(0)) };
    expect(s.statusCodes).toEqual({ 201: 100 }); // discovery never causes a failed clock-in, only (bounded) waiting
    expect(s.db.attendanceRows).toBe(100);
    expect(s.serverErrors5xx).toBe(0);
    expect(s.db.deadlocksDelta).toBe(0);
    // RLS must be back ON for every table the hammer touched.
    const rls = await adminDataSource.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'core'::regnamespace AND relname IN ('shift','shift_assignment')`);
    expect(rls.every((r: { relrowsecurity: boolean; relforcerowsecurity: boolean }) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
  });

  it('duplicate concurrent clock-in: ONE staff member, ONE shift, 10 simultaneous taps of the same request', async () => {
    const { shiftId, qrToken, staff } = await seedShift(1);
    const one = staff[0]!;
    const samples = await Promise.all(
      Array.from({ length: 10 }, async (): Promise<Sample> => {
        const t0 = performance.now();
        const res = await fetch(`${BASE}/attendance/clock-in`, { method: 'POST', headers: { Authorization: `Bearer ${one.token}`, 'content-type': 'application/json', 'CF-Connecting-IP': '10.9.9.9' }, body: JSON.stringify({ shiftId, qrToken, ...INSIDE }) });
        await res.arrayBuffer();
        return { status: res.status, ms: performance.now() - t0 };
      }),
    );
    const byStatus: Record<string, number> = {};
    for (const s of samples) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    const rows = await tenantContext.runInTenantContext(ctx(), (m) => m.query(`SELECT count(*)::int AS n FROM core.attendance WHERE shift_id = $1 AND staff_profile_id = $2`, [shiftId, one.profileId]));
    results['duplicate-single-staff'] = { attempts: 10, statusCodes: byStatus, attendanceRows: rows[0].n, serverErrors5xx: samples.filter((s) => s.status >= 500).length };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(results['duplicate-single-staff']));
    expect(byStatus['201']).toBe(1);
    expect(rows[0].n).toBe(1);
    expect(samples.filter((s) => s.status >= 500)).toHaveLength(0);
  });
});
