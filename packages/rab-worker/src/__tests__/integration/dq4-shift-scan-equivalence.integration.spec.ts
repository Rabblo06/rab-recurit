import 'reflect-metadata';
import { ShiftAssignmentStatus } from '@rab/shared';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
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

  it.todo('PROPOSED D-Q4a: WORKER_SHIFT_SCAN_MODE=combined on the same fixture yields exactly the Order A keys, statuses and scopes');
  it.todo('PROPOSED D-Q4a: combined mode, second pass — no new event and no new notification (same as separate mode)');
  it.todo('PROPOSED D-Q4a: combined mode, two Worker replicas in parallel — each event key exactly once, every notification exactly once');
  it.todo('PROPOSED D-Q4a: combined mode, one member query throws for one workspace — the other members of that workspace still run (SAVEPOINT)');
  it.todo('PROPOSED D-Q4a: combined mode with the two report members — the advisory lock is still taken on the DIRECT DataSource per shift');
  it.todo('PROPOSED D-Q4a: combined mode, no tenant context bound for a member query → zero rows (fail closed), never another workspace\'s rows');
});
