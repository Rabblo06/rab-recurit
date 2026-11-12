import 'reflect-metadata';
import { ShiftAssignmentStatus } from '@rab/shared';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { coreDataSourceOptions } from '@rab/server/database/typeorm/core/core.datasource';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import Redis from 'ioredis';
import * as advisoryLock from '../../core/locking/advisory-lock';
import { discoverMembersInWorkspaces, WalkMember } from '../../core/database/workspace-discovery';
import { WorkerRuntime } from '../../core/runtime/worker-runtime';
import { combinedShiftScanMemberDefs } from '../../core/scheduler/scan-jobs';
import type { WorkerJobDependencies } from '../../core/scheduler/worker-dependencies';
import { bindCombinedShiftScanMembers, CombinedShiftScan } from '../../queues/rab-shifts/shift-scan-combined.job';
import { runShiftReportSchedulerCycle } from '../../queues/rab-reports/shift-report-scheduler.job';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { Attendance } from '@rab/server/modules/attendance/entities/attendance.entity';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '@rab/server/modules/scheduling/utils/tstzrange';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { runAttendanceMonitorCycle } from '../../queues/rab-shifts/attendance-monitor.job';
import { runLateClockInCycle } from '../../queues/rab-shifts/late-clock-in.job';
import { runShiftMonitorCycle } from '../../queues/rab-shifts/shift-monitor.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * D-Q4a test preparation (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §D-Q4a). CHARACTERISATION of today's SEPARATE shift
 * scans on real PostgreSQL (RLS on, the crewflow_app runtime login, worker tenant context), so the PROPOSED combined
 * scan (`WORKER_SHIFT_SCAN_MODE=combined`) can be proven equivalent: the same subjects get the same `core.worker_event`
 * keys and statuses, the same business status changes, under the same organisation and workspace.
 *
 * Fixture (one workspace per organisation, one staff member per subject so assignment periods never overlap):
 *   S1 reminder   confirmed, starts in 20 min           → shift-reminder-24h / -2h / -30m (clock-in-window opens at 15 min: not yet)
 *   S2 late       confirmed, started 15 min ago          → late-clock-in (grace 10); too early for no-show (30)
 *   S3 no-show    confirmed, started 45 min ago, no clock-in → no-show (+ late-clock-in ONLY if late-clock-in runs first)
 *   S4 clock-out  clocked in, assignment ended 45 min ago → missing-clock-out (attendance → missing_clock_out)
 *   S5 org B      confirmed, started 15 min ago          → late-clock-in recorded under organisation B
 *
 * FINDING pinned here (plan §D-Q4a "member order"): S3's late-clock-in event depends on which scan processes it first.
 * Separate mode has no fixed order (independent timers), so both outcomes occur in production. The combined scan must
 * pick one documented order; Order A (late-clock-in before shift-monitor) reproduces the outcome of the most common
 * separate-mode case and is the plan's PROPOSED order — an owner-visible choice, flagged, not decided here.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(240_000);

const MIN = 60_000;
const GRACE_MINUTES = 10;
const CLOCK_IN_EARLY_MINUTES = 15;

describeIfDb('D-Q4a characterisation: separate shift scans (equivalence baseline for the combined scan)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let notificationService: NotificationService;
  let auditService: AuditService;
  let factory: TestIdentityFactory;

  interface Org {
    manager: TestIdentity;
    venueId: string;
    jobRoleId: string;
  }
  interface Subject {
    org: Org;
    shiftId: string;
    assignmentId: string;
    attendanceId?: string;
  }

  const ctx = (o: Org) => ({ organisationId: o.manager.organisationId, workspaceId: o.manager.workspaceId, userId: o.manager.userId, role: '' });
  const withOrg = <T>(o: Org, fn: (m: EntityManager) => Promise<T>) => tenantContext.runInTenantContext(ctx(o), fn);

  async function seedOrg(label: string): Promise<Org> {
    const organisation = await factory.createOrganisation(label);
    const manager = await factory.createInternalManager(organisation, { permissions: 'production', label });
    const ids = await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, async (m) => {
      const venue = await m.save(Venue, { organisationId: organisation.id, name: `${label} Venue`, createdBy: manager.userId, workspaceId: manager.workspaceId! });
      const jobRole = await m.save(JobRole, { organisationId: organisation.id, name: `Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: manager.userId, workspaceId: manager.workspaceId! });
      return { venueId: venue.id, jobRoleId: jobRole.id };
    });
    return { manager, ...ids };
  }

  async function seedSubject(o: Org, startsAt: Date, endsAt: Date, opts: { clockedInAt?: Date } = {}): Promise<Subject> {
    const staff = await factory.createStaff({ id: o.manager.organisationId } as never, { owner: o.manager, label: 'dq4' });
    return withOrg(o, async (m) => {
      const shift = await m.save(Shift, {
        organisationId: o.manager.organisationId, venueId: o.venueId, jobRoleId: o.jobRoleId, startsAt, endsAt, breakMinutes: 0,
        requiredCount: 1, payRatePence: 1500, status: 'confirmed', createdBy: o.manager.userId, workspaceId: o.manager.workspaceId!,
      });
      const assignment = await m.save(ShiftAssignment, {
        organisationId: o.manager.organisationId, shiftId: shift.id, staffProfileId: staff.profileId!, status: ShiftAssignmentStatus.CONFIRMED,
        payRateSnapshotPence: 1500, assignedBy: o.manager.userId, confirmedAt: new Date(), period: toTstzRange(startsAt, endsAt), workspaceId: o.manager.workspaceId!,
      });
      let attendanceId: string | undefined;
      if (opts.clockedInAt) {
        const attendance = await m.save(Attendance, {
          organisationId: o.manager.organisationId, workspaceId: o.manager.workspaceId!, shiftId: shift.id, shiftAssignmentId: assignment.id,
          staffProfileId: staff.profileId!, clockInAt: opts.clockedInAt, status: 'clocked_in' as never,
        });
        attendanceId = attendance.id;
      }
      return { org: o, shiftId: shift.id, assignmentId: assignment.id, attendanceId };
    });
  }

  /** Every worker_event of a subject (assignment and attendance ids), as `<key-slug>=<status>@<org-matches>`. */
  async function eventsOf(s: Subject): Promise<string[]> {
    const ids = [s.assignmentId, s.attendanceId].filter(Boolean);
    const rows = await withOrg(s.org, (m) =>
      m.query<Array<{ event_key: string; status: string; organisation_id: string; workspace_id: string | null }>>(
        `SELECT event_key, status, organisation_id, workspace_id FROM core.worker_event WHERE entity_id::text = ANY($1::text[]) ORDER BY event_key`,
        [ids],
      ),
    );
    return rows.map((r) => {
      const slug = r.event_key.split(':')[0];
      const scoped = r.organisation_id === s.org.manager.organisationId && r.workspace_id === s.org.manager.workspaceId ? 'own-scope' : 'WRONG-SCOPE';
      return `${slug}=${r.status}@${scoped}`;
    }).sort();
  }

  async function statusOf(s: Subject): Promise<{ assignment: string; attendance: string | null }> {
    return withOrg(s.org, async (m) => ({
      assignment: (await m.query(`SELECT status FROM shift_assignment WHERE id = $1`, [s.assignmentId]))[0].status,
      attendance: s.attendanceId ? (await m.query(`SELECT status FROM attendance WHERE id = $1`, [s.attendanceId]))[0].status : null,
    }));
  }

  async function notificationCount(s: Subject): Promise<number> {
    const ids = [s.assignmentId, s.attendanceId].filter(Boolean);
    const rows = await withOrg(s.org, (m) => m.query(`SELECT count(*)::int AS n FROM core.notification WHERE related_entity_id::text = ANY($1::text[])`, [ids]));
    return rows[0].n;
  }

  const late = () => runLateClockInCycle(dataSource, tenantContext, notificationService, auditService, GRACE_MINUTES);
  const monitor = () => runShiftMonitorCycle(dataSource, tenantContext, notificationService, auditService, CLOCK_IN_EARLY_MINUTES);
  const attendance = () => runAttendanceMonitorCycle(dataSource, tenantContext, notificationService, auditService);

  async function seedAll(label: string) {
    const a = await seedOrg(`${label}a`);
    const b = await seedOrg(`${label}b`);
    const now = Date.now();
    return {
      s1: await seedSubject(a, new Date(now + 20 * MIN), new Date(now + 260 * MIN)),
      s2: await seedSubject(a, new Date(now - 15 * MIN), new Date(now + 225 * MIN)),
      s3: await seedSubject(a, new Date(now - 45 * MIN), new Date(now + 195 * MIN)),
      s4: await seedSubject(a, new Date(now - 285 * MIN), new Date(now - 45 * MIN), { clockedInAt: new Date(now - 284 * MIN) }),
      s5: await seedSubject(b, new Date(now - 15 * MIN), new Date(now + 225 * MIN)),
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    notificationService = app.get(NotificationService);
    auditService = app.get(AuditService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = createTestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
    // D-Q4a (review): the combined path reads CLOCK_IN_EARLY_MINUTES from EnvironmentService, the separate baseline uses the
    // constant; the equivalence comparison is only meaningful when they are the same window.
    expect(app.get(EnvironmentService).get('CLOCK_IN_EARLY_MINUTES')).toBe(CLOCK_IN_EARLY_MINUTES);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('Order A (late-clock-in → shift-monitor → attendance-monitor): keys, statuses and scope per subject', async () => {
    const s = await seedAll('dq4A');
    await late();
    await monitor();
    await attendance();

    expect(await eventsOf(s.s1)).toEqual(['shift-reminder-24h=completed@own-scope', 'shift-reminder-2h=completed@own-scope', 'shift-reminder-30m=completed@own-scope']);
    expect(await eventsOf(s.s2)).toEqual(['late-clock-in=completed@own-scope']);
    expect(await eventsOf(s.s3)).toEqual(['late-clock-in=completed@own-scope', 'no-show=completed@own-scope']);
    expect(await eventsOf(s.s4)).toEqual(['missing-clock-out=completed@own-scope']);
    expect(await eventsOf(s.s5)).toEqual(['late-clock-in=completed@own-scope']); // organisation B's own scope

    expect(await statusOf(s.s1)).toEqual({ assignment: 'confirmed', attendance: null });
    expect(await statusOf(s.s2)).toEqual({ assignment: 'confirmed', attendance: null });
    expect(await statusOf(s.s3)).toEqual({ assignment: 'no_show', attendance: null });
    expect(await statusOf(s.s4)).toEqual({ assignment: 'confirmed', attendance: 'missing_clock_out' });
  });

  it('Order B (shift-monitor → late-clock-in): S3 is flipped to no-show first and gets NO late-clock-in event', async () => {
    const s = await seedAll('dq4B');
    await monitor();
    await late();
    await attendance();
    expect(await eventsOf(s.s3)).toEqual(['no-show=completed@own-scope']);
    expect(await eventsOf(s.s2)).toEqual(['late-clock-in=completed@own-scope']);
    expect(await statusOf(s.s3)).toEqual({ assignment: 'no_show', attendance: null });
  });

  it('idempotent: a second pass of all three scans creates no new event and no new notification', async () => {
    const s = await seedAll('dq4C');
    await late();
    await monitor();
    await attendance();
    const before = await Promise.all(Object.values(s).map(async (x) => [await eventsOf(x), await notificationCount(x)]));
    await late();
    await monitor();
    await attendance();
    const after = await Promise.all(Object.values(s).map(async (x) => [await eventsOf(x), await notificationCount(x)]));
    expect(after).toEqual(before);
  });

  it('isolation: organisation A\'s context cannot see organisation B\'s worker_event rows (RLS)', async () => {
    const s = await seedAll('dq4D');
    await late();
    const crossRead = await withOrg(s.s2.org, (m) => m.query(`SELECT count(*)::int AS n FROM core.worker_event WHERE entity_id::text = $1`, [s.s5.assignmentId]));
    expect(crossRead[0].n).toBe(0);
    expect(await eventsOf(s.s5)).toEqual(['late-clock-in=completed@own-scope']);
  });

  // ── D-Q4a: WORKER_SHIFT_SCAN_MODE=combined (owner approval 2026-11-04, OD-1) ──────────────────────────────────────────
  // The combined scan is driven exactly as main.ts wires it (CombinedShiftScan + the production member binding + the shared
  // walk on the runtime DataSource + a WorkerRuntime), on a Redis stand-in (interval mode needs no Redis to find work).
  // The shift members are compared with separate mode on every subject. The two report members are exercised separately
  // below, narrowed to the fixture's organisation, because a global report walk would render every other suite's shifts.

  /** Minimal in-memory Redis for WorkerRuntime's stats writes (or a dead client: Redis loss). */
  function memoryRedis() {
    const hash: Record<string, string> = {};
    const chain: Record<string, unknown> = {};
    chain.hset = (_k: string, a: Record<string, unknown> | string, b?: unknown) => {
      Object.entries(typeof a === 'string' ? { [a]: b } : a).forEach(([k, v]) => (hash[k] = String(v)));
      return chain;
    };
    chain.hincrby = (_k: string, f: string, by: number) => ((hash[f] = String(Number(hash[f] ?? 0) + by)), chain);
    chain.expire = () => chain;
    chain.exec = async () => [];
    return { redis: { hset: async (_k: string, o: Record<string, unknown>) => (chain.hset as (k: string, o: unknown) => unknown)(_k, o), multi: () => chain } as unknown as Redis, hash };
  }

  function workerDeps(directDataSource: DataSource): WorkerJobDependencies {
    return {
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined } as never,
      runtimeDataSource: dataSource,
      directDataSource,
      tenantContext,
      auditService,
      notificationService,
      environmentService: app.get(EnvironmentService),
      attendanceQrService: app.get(AttendanceQrService),
      qrImageService: app.get(QrImageService),
      emailOutboxService: app.get(EmailOutboxService),
      fileService: app.get(FileService),
    } as unknown as WorkerJobDependencies;
  }

  const SHIFT_MEMBERS = ['shift-monitor', 'attendance-monitor'];

  /** One combined scanner (one "replica"): its own runtime; `wrap` may decorate a member's discovery (fault injection). */
  function combinedScanner(opts: { members?: string[]; redis?: Redis; direct?: DataSource; wrap?: (key: string, m: WalkMember['discover']) => WalkMember['discover']; narrowTo?: string } = {}) {
    const mem = memoryRedis();
    const runtime = new WorkerRuntime(opts.redis ?? mem.redis, { metricsLogMs: 0, statsWrite: 'fields' });
    const members = combinedShiftScanMemberDefs().filter((d) => (opts.members ?? SHIFT_MEMBERS).includes(d.jobName));
    const scan = new CombinedShiftScan({
      members,
      bind: () => {
        const bound = bindCombinedShiftScanMembers(workerDeps(opts.direct ?? dataSource));
        const out = new Map<string, { discover: WalkMember['discover']; process: (rows: unknown[]) => Promise<void> }>();
        for (const [key, m] of bound) {
          const discover = opts.wrap ? opts.wrap(key, m.discover) : m.discover;
          // Report members only: narrow processing to the fixture organisation (the walk itself stays global).
          const process = opts.narrowTo
            ? (rows: unknown[]) => m.process(rows.filter((r) => (r as { organisation_id: string }).organisation_id === opts.narrowTo))
            : m.process;
          out.set(key, { discover, process });
        }
        return out;
      },
      walk: (walkMembers) => discoverMembersInWorkspaces(dataSource, tenantContext, walkMembers),
      intervalOf: () => 300_000,
      tickMs: 300_000,
      runtime,
    });
    const tick = async () => {
      const report = await scan.tick();
      const outcomes = await Promise.all(report.started);
      return { report, outcomes };
    };
    return { scan, runtime, stats: mem.hash, tick };
  }

  async function snapshot(s: Awaited<ReturnType<typeof seedAll>>) {
    return Promise.all(Object.values(s).map(async (x) => ({ events: await eventsOf(x), status: await statusOf(x), notifications: await notificationCount(x) })));
  }

  it('D-Q4a equivalence, Order A: late-clock-in → COMBINED (shift monitor + attendance monitor) gives exactly the separate-mode keys, statuses, scopes and notifications', async () => {
    const separate = await seedAll('dq4E1s');
    await late();
    await monitor();
    await attendance();
    const expected = await snapshot(separate);

    const combinedFixture = await seedAll('dq4E1c');
    await late();
    const { outcomes, report } = await combinedScanner().tick();
    expect(report.discovered).toEqual(SHIFT_MEMBERS);
    expect(outcomes).toEqual(['succeeded', 'succeeded']);
    expect(await snapshot(combinedFixture)).toEqual(expected);
    // The pinned Order A outcome, explicitly.
    expect(await eventsOf(combinedFixture.s3)).toEqual(['late-clock-in=completed@own-scope', 'no-show=completed@own-scope']);
    expect(await eventsOf(combinedFixture.s4)).toEqual(['missing-clock-out=completed@own-scope']);
    expect(await eventsOf(combinedFixture.s5)).toEqual(['late-clock-in=completed@own-scope']);
  });

  it('D-Q4a scan order (plan A1 / OD-2): late clock-in is NOT a member, so COMBINED → late-clock-in reproduces separate Order B (no-show only)', async () => {
    const s = await seedAll('dq4E2');
    await combinedScanner().tick();
    await late();
    expect(await eventsOf(s.s3)).toEqual(['no-show=completed@own-scope']);
    expect(await eventsOf(s.s2)).toEqual(['late-clock-in=completed@own-scope']);
    expect(await statusOf(s.s3)).toEqual({ assignment: 'no_show', attendance: null });
  });

  it('D-Q4a idempotent: a second combined pass, and a rollback to SEPARATE mode after it, create no new event and no new notification', async () => {
    const s = await seedAll('dq4E3');
    await late();
    await combinedScanner().tick();
    const before = await snapshot(s);
    // Second combined tick (a fresh scanner: every member due again): same events, same notifications.
    await combinedScanner().tick();
    expect(await snapshot(s)).toEqual(before);
    // Flag rollback (WORKER_SHIFT_SCAN_MODE=separate): the separate scans meet the same keys and do nothing new.
    await monitor();
    await attendance();
    await late();
    expect(await snapshot(s)).toEqual(before);
  });

  it('D-Q4a two replicas in parallel: each event key exactly once and every notification exactly once', async () => {
    const reference = await seedAll('dq4E4r');
    await late();
    await combinedScanner().tick();
    const expected = await snapshot(reference);

    const s = await seedAll('dq4E4');
    await late();
    const [a, b] = [combinedScanner(), combinedScanner()];
    await Promise.all([a.tick(), b.tick()]);
    expect(await snapshot(s)).toEqual(expected);
    for (const x of Object.values(s)) {
      const keys = await withOrg(x.org, (m) =>
        m.query<Array<{ event_key: string; n: number }>>(`SELECT event_key, count(*)::int AS n FROM core.worker_event WHERE entity_id::text = ANY($1::text[]) GROUP BY 1`, [[x.assignmentId, x.attendanceId].filter(Boolean)]),
      );
      for (const k of keys) expect(k.n).toBe(1);
    }
  });

  it('D-Q4a SAVEPOINT: a member query that errors in one workspace fails only that member; the next member in the SAME transaction still runs', async () => {
    const s = await seedAll('dq4E5');
    const failIn = s.s1.org.manager.workspaceId;
    const scanner = combinedScanner({
      wrap: (key, discover) =>
        key === 'shift-monitor'
          ? async (m) => {
              const [{ ws }] = await m.query<Array<{ ws: string | null }>>(`SELECT core.current_workspace()::text AS ws`);
              if (ws === failIn) await m.query('SELECT 1/0'); // a real PostgreSQL error: aborts the transaction without the savepoint
              return discover(m);
            }
          : discover,
    });
    const { report, outcomes } = await scanner.tick();
    expect(report.failed).toEqual(['shift-monitor']);
    expect(report.discovered).toEqual(['attendance-monitor']);
    expect(outcomes).toEqual(['failed', 'succeeded']);
    // attendance-monitor ran after the failed member, in the same workspace transaction: S4 is flagged.
    expect(await eventsOf(s.s4)).toEqual(['missing-clock-out=completed@own-scope']);
    expect(await statusOf(s.s4)).toEqual({ assignment: 'confirmed', attendance: 'missing_clock_out' });
    // shift-monitor failed for the whole tick (as a failing separate scan would): nothing of it was processed anywhere.
    expect(await eventsOf(s.s1)).toEqual([]);
    expect(await eventsOf(s.s3)).toEqual([]);
    expect(scanner.stats.shiftMonitorFailures).toBe('1');
    expect(scanner.stats.lastShiftMonitorAt).toBeUndefined();
    expect(scanner.stats.lastAttendanceMonitorAt).toBeDefined();
    // Retried on its next due tick (here: a healthy scanner): the member recovers.
    await combinedScanner().tick();
    expect(await eventsOf(s.s3)).toEqual(['no-show=completed@own-scope']);
  });

  it('D-Q4a report members: per-shift advisory locks on the DIRECT DataSource; same reports as the separate scan', async () => {
    const direct = new DataSource({ ...coreDataSourceOptions, name: `dq4-direct-${randomUUID().slice(0, 8)}`, extra: { ...(coreDataSourceOptions.extra as object), max: 2 } } as never);
    await direct.initialize();
    try {
      const minutes = app.get(EnvironmentService).get('REPORT_AVAILABLE_BEFORE_MINUTES');
      const separate = await seedAll('dq4E6s');
      const sepOrg = separate.s1.org.manager.organisationId;
      const sepResult = await runShiftReportSchedulerCycle(direct, tenantContext, app.get(AttendanceQrService), app.get(QrImageService), app.get(EmailOutboxService), app.get(FileService), minutes, {
        organisationId: sepOrg,
        audit: auditService,
      });

      const s = await seedAll('dq4E6c');
      const org = s.s1.org.manager.organisationId;
      const spy = jest.spyOn(advisoryLock, 'withAdvisoryLock');
      try {
        const { report, outcomes } = await combinedScanner({ members: ['shift-report-scheduler', 'final-timesheet'], direct, narrowTo: org }).tick();
        expect(report.discovered).toEqual(['shift-report-scheduler', 'final-timesheet']);
        expect(outcomes).toEqual(['succeeded', 'succeeded']);
        const shiftReportLocks = spy.mock.calls.filter(([, name]) => String(name).startsWith('shift_report:'));
        expect(shiftReportLocks.length).toBe(sepResult.generated + sepResult.failed + sepResult.skippedLocked);
        for (const [ds] of spy.mock.calls) expect(ds).toBe(direct); // never the pooled runtime DataSource
      } finally {
        spy.mockRestore();
      }
      const reportsOf = async (fx: typeof s) =>
        (await Promise.all(Object.values(fx).map((x) => withOrg(x.org, (m) => m.query(`SELECT status FROM shift_report WHERE shift_id = $1`, [x.shiftId]))))).map((r) => r[0]?.status ?? null);
      expect(await reportsOf(s)).toEqual(await reportsOf(separate));
    } finally {
      await direct.destroy();
    }
  });

  it('D-Q4a isolation: no tenant context bound → every member discovery query returns zero rows or is refused, never rows', async () => {
    await seedAll('dq4E7');
    const bound = bindCombinedShiftScanMembers(workerDeps(dataSource));
    for (const [key, member] of bound) {
      const outcome = await dataSource
        .transaction(async (m) => {
          await m.query('SET TRANSACTION READ ONLY');
          const rows = await member.discover(m);
          // shift-monitor returns one discovery object per workspace: count the rows inside it.
          return rows.flatMap((r) => ('assignments' in (r as object) ? [...(r as { assignments: unknown[] }).assignments, ...(r as { lifecycleCandidates: unknown[] }).lifecycleCandidates] : [r])).length;
        })
        // Only a refusal to resolve the workspace tables (no workspace schema routed: undefined_table) or a privilege
        // refusal counts as fail-closed; any other error (broken query, lost connection) fails the test (review).
        .catch((error: { code?: string }) => {
          if (error?.code === '42P01' || error?.code === '42501') return 'refused' as const;
          throw error;
        });
      expect({ key, outcome: [0, 'refused'].includes(outcome) ? 'none' : outcome }).toEqual({ key, outcome: 'none' });
    }
  });

  it('D-Q4a isolation: after a combined tick, organisation A cannot read organisation B\'s events, and every event carries its own scope', async () => {
    const s = await seedAll('dq4E8');
    await late();
    await combinedScanner().tick();
    const crossRead = await withOrg(s.s1.org, (m) => m.query(`SELECT count(*)::int AS n FROM core.worker_event WHERE entity_id::text = $1`, [s.s5.assignmentId]));
    expect(crossRead[0].n).toBe(0);
    for (const x of Object.values(s)) for (const e of await eventsOf(x)) expect(e).toMatch(/@own-scope$/);
  });

  it('D-Q4a Redis loss: with Redis unreachable the combined scan still finds and processes its work (stats writes are best-effort)', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
    dead.on('error', () => undefined);
    try {
      const s = await seedAll('dq4E9');
      await late();
      const { outcomes } = await combinedScanner({ redis: dead }).tick();
      expect(outcomes).toEqual(['succeeded', 'succeeded']);
      expect(await eventsOf(s.s3)).toEqual(['late-clock-in=completed@own-scope', 'no-show=completed@own-scope']);
      expect(await eventsOf(s.s4)).toEqual(['missing-clock-out=completed@own-scope']);
    } finally {
      dead.disconnect();
    }
  });
});
