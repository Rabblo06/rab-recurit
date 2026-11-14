import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { AppModule } from '../../app.module';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { boundSchemaOf } from '../../engine/core-modules/tenant/schema-bound-entity-manager';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { Attendance, AttendanceCorrection, ShiftReport } from '../../modules/attendance/entities';
import { User, UserNote } from '../../modules/identity/entities';
import { ManagerVenue } from '../../modules/manager/entities';
import { JobOffer, ReplacementRequest } from '../../modules/offer/entities';
import { JobRole, Shift, ShiftAssignment, ShiftRequestStaff, VenueRoleRate } from '../../modules/scheduling/entities';
import { StaffProfile } from '../../modules/staff/entities';
import { Venue } from '../../modules/venue/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessSchema, hwsRuntimeOn } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Part C2-1 (HWS-AUDIT-C2-SIZING.md §6 option A, §7): the product binders hand out a SCHEMA-BOUND EntityManager, so the 14
 * workspace entities issue `"<schema>"."<table>"` themselves. Real PostgreSQL, the real AppModule, RLS on.
 *
 * Every entity operation below runs with search_path set to '' inside the transaction (the C2 runtime trap): an unqualified
 * workspace table would fail with 42P01 instead of silently resolving through search_path. Every logged statement of that
 * transaction is also parsed, and every reference to one of the 14 tables must carry the workspace's schema (`"core"` in the
 * HWS-off job). The methods are the ones the codebase uses per entity (C2-SIZING §2.1): find/findOne/findOneBy/findOneByOrFail/
 * findOneOrFail/findAndCount/count, create/merge/save, insert, update, delete, createQueryBuilder (select, joins, insert,
 * update) and the StaffProfile.jobRole / StaffProfile.user relations. Writes are checked on the superuser connection: the row
 * is in the workspace's schema and not in core or the other workspace's schema (HWS on).
 *
 * Cross-workspace isolation: workspace B's transaction never names A's schema, cannot read or change A's rows through any
 * entity method, and two concurrently open transactions (A and B) each stay on their own schema.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(240_000);

const ENTITY_TABLES = [
  'attendance', 'attendance_correction', 'shift_report', 'user_note', 'manager_venue', 'job_offer', 'replacement_request',
  'job_role', 'shift', 'shift_assignment', 'shift_request_staff', 'venue_role_rate', 'staff_profile', 'venue',
] as const;
const ENTITY_TABLE_SET = new Set<string>(ENTITY_TABLES);
const TRAP_SQL = `SELECT set_config('search_path', '', true)`;
const HOUR = 3_600_000;

interface TableRef {
  schema: string | null;
  table: string;
}

/** Table references after FROM / JOIN / INTO / UPDATE in one statement, quoted or bare, optionally schema-qualified. */
function tableRefs(sql: string): TableRef[] {
  const out: TableRef[] = [];
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:"([^"]+)"|([A-Za-z_]\w*))(?:\.(?:"([^"]+)"|([A-Za-z_]\w*)))?/gi;
  for (const m of sql.matchAll(re)) {
    const first = m[1] ?? m[2]!;
    const second = m[3] ?? m[4];
    out.push(second === undefined ? { schema: null, table: first } : { schema: first, table: second });
  }
  return out;
}

const pgCode = (e: unknown): string | undefined =>
  (e as { driverError?: { code?: string }; code?: string })?.driverError?.code ?? (e as { code?: string })?.code;

describeIfDb('C2-1 schema-bound EntityManager: the 14 workspace entities issue schema-qualified SQL (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let logged: Array<{ sql: string; runner: QueryRunner | undefined }>;

  interface Ws {
    orgId: string;
    manager: TestIdentity;
    staff: TestIdentity;
    schema: string;
    venueId: string;
    jobRoleId: string;
    shiftId: string;
    assignmentId: string;
    offerId: string;
  }
  let a: Ws;
  let b: Ws;

  const ctxOf = (ws: Ws) => ({ organisationId: ws.orgId, workspaceId: ws.manager.workspaceId, userId: ws.manager.userId, role: '' });

  /**
   * Runs `fn` in the product's tenant context for `ws` with the search_path trap set first, and returns its result plus every
   * statement this transaction's QueryRunner logged after the trap.
   */
  async function trapped<T>(ws: Ws, fn: (m: EntityManager) => Promise<T>): Promise<{ value: T; statements: string[] }> {
    let runner: QueryRunner | undefined;
    let from = 0;
    const value = await tenantContext.runInWorkspaceContext(ctxOf(ws), async (m, schema) => {
      expect(schema).toBe(ws.schema);
      expect(boundSchemaOf(m)).toBe(ws.schema);
      runner = m.queryRunner;
      await m.query(TRAP_SQL);
      from = logged.length;
      return fn(m);
    });
    const statements = logged.slice(from).filter((l) => l.runner === runner).map((l) => l.sql);
    return { value, statements };
  }

  /** Every reference to one of the 14 tables names exactly `schema`; returns the set of tables seen. */
  function expectQualified(statements: string[], schema: string): Set<string> {
    const seen = new Set<string>();
    for (const sql of statements) {
      for (const ref of tableRefs(sql)) {
        if (!ENTITY_TABLE_SET.has(ref.table)) continue;
        seen.add(ref.table);
        expect({ sql, schema: ref.schema }).toEqual({ sql, schema });
      }
    }
    return seen;
  }

  /** Superuser count of `id` in `schema.table` (the schema comes from the registry-derived fixture helper, never input). */
  async function countIn(schema: string, table: string, where: string, params: unknown[]): Promise<number> {
    if (!/^(core|workspace_[0-9a-f]{32})$/.test(schema) || !ENTITY_TABLE_SET.has(table)) throw new Error('bad fixture identifier');
    const rows: Array<{ n: number }> = await admin.query(`SELECT count(*)::int AS n FROM "${schema}"."${table}" WHERE ${where}`, params);
    return rows[0]!.n;
  }

  /** The row is in this workspace's schema; with HWS on, not in core and not in the other workspace's schema. */
  async function expectLandedOnlyIn(ws: Ws, other: Ws, table: string, where: string, params: unknown[]): Promise<void> {
    expect(await countIn(ws.schema, table, where, params)).toBe(1);
    if (hwsRuntimeOn()) {
      expect(await countIn('core', table, where, params)).toBe(0);
      expect(await countIn(other.schema, table, where, params)).toBe(0);
    }
  }

  async function seedWorkspace(label: string): Promise<Ws> {
    const org = await factory.createOrganisation(`c21-${label}`);
    const manager = await factory.createInternalManager(org, { permissions: 'production' });
    const staff = await factory.createStaff(org, { owner: manager, label: `c21-${label}-staff` });
    const schema = businessSchema(manager.workspaceId!);
    const token = await factory.login(manager);
    // Venue and job role through the schema-bound manager (no trap here: fixture setup).
    const { venueId, jobRoleId } = await tenantContext.runInWorkspaceContext(ctxOf({ orgId: org.id, manager } as Ws), async (m) => {
      const venue = await m.save(Venue, { organisationId: org.id, name: `Venue c21 ${label}`, workspaceId: manager.workspaceId!, createdBy: manager.userId });
      const role = await m.insert(JobRole, { organisationId: org.id, name: `Role-c21-${randomUUID().slice(0, 8)}`, defaultRatePence: 1500, workspaceId: manager.workspaceId!, createdBy: manager.userId });
      await m.update(StaffProfile, { id: staff.profileId! }, { employmentStatus: 'active' });
      return { venueId: venue.id, jobRoleId: role.identifiers[0]!.id as string };
    });
    const start = new Date(Date.now() + 72 * HOUR);
    const created = await request(app.getHttpServer())
      .post('/rest/v1/shifts/with-offers')
      .set({ Authorization: `Bearer ${token}` })
      .send({ venueId, jobRoleId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 8 * HOUR).toISOString(), requiredCount: 1, staffProfileIds: [staff.profileId] });
    expect(created.status).toBe(201);
    const shiftId = created.body.shiftId as string;
    const [row] = await admin.query(
      `SELECT sa.id AS assignment_id, o.id AS offer_id FROM "${schema}".shift_assignment sa JOIN "${schema}".job_offer o ON o.shift_assignment_id = sa.id WHERE sa.shift_id = $1`,
      [shiftId],
    );
    return { orgId: org.id, manager, staff, schema, venueId, jobRoleId, shiftId, assignmentId: row.assignment_id, offerId: row.offer_id };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    logged = [];
    const original = dataSource.logger.logQuery.bind(dataSource.logger);
    jest.spyOn(dataSource.logger, 'logQuery').mockImplementation((query: string, parameters?: unknown[], queryRunner?: QueryRunner) => {
      logged.push({ sql: query, runner: queryRunner });
      return original(query, parameters, queryRunner);
    });
    a = await seedWorkspace('a');
    b = await seedWorkspace('b');
    if (hwsRuntimeOn()) expect(a.schema).not.toBe(b.schema);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    await admin?.destroy();
  });

  it('base metadata is untouched: the shared DataSource still has no schema on the 14 entities (hws-startup-guard check 3)', () => {
    for (const target of [Attendance, AttendanceCorrection, ShiftReport, UserNote, ManagerVenue, JobOffer, ReplacementRequest, JobRole, Shift, ShiftAssignment, ShiftRequestStaff, VenueRoleRate, StaffProfile, Venue]) {
      const metadata = dataSource.getMetadata(target);
      expect([metadata.name, metadata.schema ?? null, metadata.tablePath]).toEqual([metadata.name, null, metadata.tableName]);
    }
    expect(dataSource.getMetadata(User).tablePath).toBe('core.user');
  });

  it('all 14 entities x the methods used: qualified SQL under the search_path trap, rows land in the workspace schema', async () => {
    const ws = a;
    const ids = await trapped(ws, async (m) => {
      const org = ws.orgId;
      const workspaceId = ws.manager.workspaceId!;
      // Venue: findOne, findOneByOrFail, count, find, getRepository().find, query builder, create+merge+save, update, save(new).
      const venue = await m.findOneByOrFail(Venue, { id: ws.venueId });
      expect(await m.findOne(Venue, { where: { id: ws.venueId } })).not.toBeNull();
      expect(await m.count(Venue, { where: { id: ws.venueId } })).toBe(1);
      expect(await m.find(Venue, { where: { id: ws.venueId } })).toHaveLength(1);
      expect(await m.getRepository(Venue).find({ where: { id: ws.venueId } })).toHaveLength(1);
      expect(await m.createQueryBuilder(Venue, 'v').where('v.id = :id', { id: ws.venueId }).getCount()).toBe(1);
      await m.save(m.merge(Venue, venue, { parking: 'c21-merge' }));
      await m.update(Venue, { id: ws.venueId }, { instructions: 'c21-update' });
      const venue2 = await m.save(m.create(Venue, { organisationId: org, name: 'Venue c21 second', workspaceId, createdBy: ws.manager.userId }));

      // JobRole: insert (setup), findOne, find, findOneByOrFail, update, create+save.
      expect(await m.findOne(JobRole, { where: { id: ws.jobRoleId } })).not.toBeNull();
      expect(await m.find(JobRole, { where: { id: ws.jobRoleId } })).toHaveLength(1);
      await m.findOneByOrFail(JobRole, { id: ws.jobRoleId });
      await m.update(JobRole, { id: ws.jobRoleId }, { defaultRatePence: 1600 });
      const role2 = await m.save(m.create(JobRole, { organisationId: org, name: `Role-c21-${randomUUID().slice(0, 8)}`, defaultRatePence: 1000, workspaceId, createdBy: ws.manager.userId }));

      // VenueRoleRate: create+save, findOne, find, findOneByOrFail, merge+save.
      const rate = await m.save(m.create(VenueRoleRate, { organisationId: org, venueId: ws.venueId, jobRoleId: ws.jobRoleId, workspaceId, payRatePence: 1200, chargeRatePence: 1800, effectiveFrom: '2026-01-01' }));
      expect(await m.findOne(VenueRoleRate, { where: { id: rate.id } })).not.toBeNull();
      expect(await m.find(VenueRoleRate, { where: { venueId: ws.venueId } })).toHaveLength(1);
      const rateRow = await m.findOneByOrFail(VenueRoleRate, { id: rate.id });
      await m.save(m.merge(VenueRoleRate, rateRow, { payRatePence: 1300 }));

      // StaffProfile: update, relations jobRole (workspace) + user (core), query builder joins, findOneBy/ByOrFail/OrFail, find.
      await m.update(StaffProfile, { id: ws.staff.profileId! }, { jobRoleId: ws.jobRoleId });
      const withRelations = await m.findOne(StaffProfile, { where: { id: ws.staff.profileId! }, relations: { jobRole: true, user: true } });
      expect(withRelations?.jobRole?.id).toBe(ws.jobRoleId);
      expect(withRelations?.user?.id).toBe(ws.staff.userId);
      const viaQb = await m
        .createQueryBuilder(StaffProfile, 'sp')
        .leftJoinAndSelect('sp.jobRole', 'jr')
        .leftJoinAndSelect('sp.user', 'u')
        .innerJoin(ShiftAssignment, 'sa', 'sa.staffProfileId = sp.id')
        .innerJoin(Shift, 's', 's.id = sa.shiftId')
        .leftJoin(Venue, 'v', 'v.id = s.venueId')
        .leftJoin(JobRole, 'r', 'r.id = s.jobRoleId')
        .where('sp.id = :id', { id: ws.staff.profileId })
        .getOne();
      expect(viaQb?.jobRole?.id).toBe(ws.jobRoleId);
      expect(viaQb?.user?.id).toBe(ws.staff.userId);
      await m.findOneBy(StaffProfile, { id: ws.staff.profileId! });
      await m.findOneByOrFail(StaffProfile, { id: ws.staff.profileId! });
      await m.findOneOrFail(StaffProfile, { where: { id: ws.staff.profileId! } });
      expect(await m.find(StaffProfile, { where: { id: ws.staff.profileId! } })).toHaveLength(1);

      // Shift: findOne, findOneByOrFail, findOneOrFail, find, findAndCount, update, query builder update + innerJoin.
      await m.findOneByOrFail(Shift, { id: ws.shiftId });
      await m.findOneOrFail(Shift, { where: { id: ws.shiftId } });
      expect(await m.findOne(Shift, { where: { id: ws.shiftId } })).not.toBeNull();
      expect(await m.find(Shift, { where: { id: ws.shiftId } })).toHaveLength(1);
      expect((await m.findAndCount(Shift, { where: { id: ws.shiftId } }))[1]).toBe(1);
      await m.update(Shift, { id: ws.shiftId }, { notes: 'c21-update' });
      await m.createQueryBuilder().update(Shift).set({ notes: 'c21-qb-update' }).where('id = :id', { id: ws.shiftId }).execute();
      expect(await m.createQueryBuilder(Shift, 's').innerJoin(Venue, 'v', 'v.id = s.venueId').where('s.id = :id', { id: ws.shiftId }).getCount()).toBe(1);

      // ShiftAssignment: findOne, findOneByOrFail, findOneOrFail, count, find, update.
      await m.findOneByOrFail(ShiftAssignment, { id: ws.assignmentId });
      await m.findOneOrFail(ShiftAssignment, { where: { id: ws.assignmentId } });
      expect(await m.findOne(ShiftAssignment, { where: { id: ws.assignmentId } })).not.toBeNull();
      expect(await m.count(ShiftAssignment, { where: { shiftId: ws.shiftId } })).toBe(1);
      expect(await m.find(ShiftAssignment, { where: { shiftId: ws.shiftId } })).toHaveLength(1);
      await m.update(ShiftAssignment, { id: ws.assignmentId }, { breakMinutes: 15 });

      // JobOffer: findOne, findOneByOrFail, find, findAndCount, update (via the query builder, the codebase's other form).
      await m.findOneByOrFail(JobOffer, { id: ws.offerId });
      expect(await m.findOne(JobOffer, { where: { id: ws.offerId } })).not.toBeNull();
      expect(await m.find(JobOffer, { where: { shiftAssignmentId: ws.assignmentId } })).toHaveLength(1);
      expect((await m.findAndCount(JobOffer, { where: { staffProfileId: ws.staff.profileId! } }))[1]).toBeGreaterThanOrEqual(1);
      expect((await m.update(JobOffer, { id: randomUUID() }, { declineReason: 'none' })).affected).toBe(0);

      // ShiftRequestStaff: delete, insert, find, count, findOne.
      await m.delete(ShiftRequestStaff, { shiftId: ws.shiftId, staffProfileId: ws.staff.profileId! });
      await m.insert(ShiftRequestStaff, { organisationId: org, shiftId: ws.shiftId, staffProfileId: ws.staff.profileId!, workspaceId });
      expect(await m.find(ShiftRequestStaff, { where: { shiftId: ws.shiftId } })).toHaveLength(1);
      expect(await m.count(ShiftRequestStaff, { where: { shiftId: ws.shiftId } })).toBe(1);
      expect(await m.findOne(ShiftRequestStaff, { where: { shiftId: ws.shiftId, staffProfileId: ws.staff.profileId! } })).not.toBeNull();

      // Attendance: query builder insert, create+save path is the same persistence; findOne, findOneOrFail, count, find, update.
      const inserted = await m
        .createQueryBuilder()
        .insert()
        .into(Attendance)
        .values({ organisationId: org, shiftAssignmentId: ws.assignmentId, shiftId: ws.shiftId, staffProfileId: ws.staff.profileId!, workspaceId, clockInAt: new Date(Date.now() - HOUR), status: 'scheduled' } as never)
        .returning(['id'])
        .execute();
      const attendanceId = inserted.identifiers[0]!.id as string;
      await m.findOneOrFail(Attendance, { where: { id: attendanceId } });
      expect(await m.findOne(Attendance, { where: { shiftAssignmentId: ws.assignmentId } })).not.toBeNull();
      expect(await m.count(Attendance, { where: { shiftId: ws.shiftId } })).toBe(1);
      expect(await m.find(Attendance, { where: { shiftId: ws.shiftId } })).toHaveLength(1);
      await m.update(Attendance, { id: attendanceId }, { breakMinutes: 10 });
      await m.createQueryBuilder().update(Attendance).set({ breakMinutes: 12 }).where('id = :id', { id: attendanceId }).execute();

      // AttendanceCorrection: save (create).
      const correction = await m.save(m.create(AttendanceCorrection, { organisationId: org, workspaceId, attendanceId, field: 'breakMinutes', oldValue: '10', newValue: '12', reason: 'c21', correctedBy: ws.manager.userId }));

      // ShiftReport: findOne, create+save (or update when the product already made one), count, update.
      const existingReport = await m.findOne(ShiftReport, { where: { shiftId: ws.shiftId } });
      const report = existingReport ?? (await m.save(m.create(ShiftReport, { organisationId: org, workspaceId, shiftId: ws.shiftId, status: 'pending' })));
      expect(await m.count(ShiftReport, { where: { shiftId: ws.shiftId } })).toBe(1);
      await m.update(ShiftReport, { id: report.id }, { status: 'pending' });

      // ReplacementRequest: create+save, findOne, findOneByOrFail, update, query builder.
      const rr = await m.save(m.create(ReplacementRequest, { organisationId: org, workspaceId, shiftId: ws.shiftId, declinedShiftAssignmentId: ws.assignmentId, status: 'no_candidates', candidatesSnapshot: [] } as never)) as unknown as ReplacementRequest;
      expect(await m.findOne(ReplacementRequest, { where: { id: rr.id } })).not.toBeNull();
      await m.findOneByOrFail(ReplacementRequest, { id: rr.id });
      await m.update(ReplacementRequest, { id: rr.id }, { notifiedUserId: ws.manager.userId });
      expect(await m.createQueryBuilder(ReplacementRequest, 'r').where('r.shiftId = :id', { id: ws.shiftId }).getCount()).toBe(1);

      // UserNote: insert, delete (one kept for the landing check).
      const note = await m.insert(UserNote, { organisationId: org, workspaceId, subjectUserId: ws.staff.userId, authorUserId: ws.manager.userId, body: 'c21 kept' });
      const gone = await m.insert(UserNote, { organisationId: org, workspaceId, subjectUserId: ws.staff.userId, authorUserId: ws.manager.userId, body: 'c21 deleted' });
      expect((await m.delete(UserNote, { id: gone.identifiers[0]!.id })).affected).toBe(1);

      // ManagerVenue: insert, query builder select with innerJoin (resource-scope's shape).
      await m.insert(ManagerVenue, { organisationId: org, managerProfileId: ws.manager.profileId!, venueId: ws.venueId, workspaceId });
      expect(
        await m.createQueryBuilder(ManagerVenue, 'mv').innerJoin(Venue, 'v', 'v.id = mv.venueId').where('mv.managerProfileId = :p', { p: ws.manager.profileId }).getCount(),
      ).toBe(1);

      // A savepoint (nested transaction) keeps the schema-bound manager.
      await m.transaction(async (nested) => {
        expect(boundSchemaOf(nested)).toBe(ws.schema);
        expect(await nested.findOne(Shift, { where: { id: ws.shiftId } })).not.toBeNull();
      });
      // The core entity through the same manager still resolves to core.
      expect(await m.findOne(User, { where: { id: ws.staff.userId } })).not.toBeNull();
      // Fail closed: nothing may open its own connection from the bound manager's metadata source.
      await expect(m.connection.manager.find(Shift)).rejects.toThrow(/not Connected/i);

      return { venue2: venue2.id, role2: role2.id, rate: rate.id, attendanceId, correction: correction.id, report: report.id, rr: rr.id, note: note.identifiers[0]!.id as string };
    });

    const seen = expectQualified(ids.statements, ws.schema);
    expect([...seen].sort()).toEqual([...ENTITY_TABLES].sort());
    expect(ids.statements.some((s) => /"core"\."user"/.test(s))).toBe(true);

    const v = ids.value;
    await expectLandedOnlyIn(a, b, 'venue', 'id = $1', [v.venue2]);
    await expectLandedOnlyIn(a, b, 'venue', `id = $1 AND parking = 'c21-merge' AND instructions = 'c21-update'`, [a.venueId]);
    await expectLandedOnlyIn(a, b, 'job_role', 'id = $1', [v.role2]);
    await expectLandedOnlyIn(a, b, 'job_role', 'id = $1 AND default_rate_pence = 1600', [a.jobRoleId]);
    await expectLandedOnlyIn(a, b, 'venue_role_rate', 'id = $1 AND pay_rate_pence = 1300', [v.rate]);
    await expectLandedOnlyIn(a, b, 'staff_profile', 'id = $1 AND job_role_id = $2', [a.staff.profileId, a.jobRoleId]);
    await expectLandedOnlyIn(a, b, 'shift', `id = $1 AND notes = 'c21-qb-update'`, [a.shiftId]);
    await expectLandedOnlyIn(a, b, 'shift_assignment', 'id = $1 AND break_minutes = 15', [a.assignmentId]);
    await expectLandedOnlyIn(a, b, 'job_offer', 'id = $1', [a.offerId]);
    await expectLandedOnlyIn(a, b, 'shift_request_staff', 'shift_id = $1 AND staff_profile_id = $2', [a.shiftId, a.staff.profileId]);
    await expectLandedOnlyIn(a, b, 'attendance', 'id = $1 AND break_minutes = 12', [v.attendanceId]);
    await expectLandedOnlyIn(a, b, 'attendance_correction', 'id = $1', [v.correction]);
    await expectLandedOnlyIn(a, b, 'shift_report', 'id = $1', [v.report]);
    await expectLandedOnlyIn(a, b, 'replacement_request', 'id = $1 AND notified_user_id = $2', [v.rr, a.manager.userId]);
    await expectLandedOnlyIn(a, b, 'user_note', 'id = $1', [v.note]);
    await expectLandedOnlyIn(a, b, 'manager_venue', 'manager_profile_id = $1 AND venue_id = $2', [a.manager.profileId, a.venueId]);
  });

  it('cross-workspace isolation: B never names A\'s schema and cannot read or change A\'s rows through any entity method', async () => {
    const result = await trapped(b, async (m) => ({
      venue: await m.findOne(Venue, { where: { id: a.venueId } }),
      role: await m.findOne(JobRole, { where: { id: a.jobRoleId } }),
      staff: await m.findOne(StaffProfile, { where: { id: a.staff.profileId! }, relations: { jobRole: true, user: true } }),
      shift: await m.findOne(Shift, { where: { id: a.shiftId } }),
      assignments: await m.count(ShiftAssignment, { where: { shiftId: a.shiftId } }),
      offer: await m.findOne(JobOffer, { where: { id: a.offerId } }),
      shiftUpdate: (await m.update(Shift, { id: a.shiftId }, { notes: 'c21-b-was-here' })).affected,
      venueUpdate: (await m.createQueryBuilder().update(Venue).set({ instructions: 'c21-b' }).where('id = :id', { id: a.venueId }).execute()).affected,
      noteDelete: (await m.delete(UserNote, { organisationId: a.orgId })).affected,
      own: await m.findOne(Venue, { where: { id: b.venueId } }),
    }));
    expect(result.value).toMatchObject({ venue: null, role: null, staff: null, shift: null, assignments: 0, offer: null, shiftUpdate: 0, venueUpdate: 0, noteDelete: 0 });
    expect(result.value.own?.id).toBe(b.venueId);
    expectQualified(result.statements, b.schema);
    if (hwsRuntimeOn()) expect(result.statements.join('\n')).not.toContain(a.schema);
    expect(await countIn(a.schema, 'shift', `id = $1 AND notes = 'c21-qb-update'`, [a.shiftId])).toBe(1);
    expect(await countIn(a.schema, 'venue', `id = $1 AND instructions = 'c21-update'`, [a.venueId])).toBe(1);
    expect(await countIn(a.schema, 'user_note', 'organisation_id = $1', [a.orgId])).toBe(1);
  });

  it('two transactions open at the same time (A and B) each stay on their own schema-bound metadata', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    let opened = 0;
    const both = (ws: Ws) =>
      trapped(ws, async (m) => {
        opened += 1;
        if (opened === 2) release();
        await barrier;
        return { mine: await m.findOne(Venue, { where: { id: ws.venueId } }), theirs: await m.findOne(Venue, { where: { id: (ws === a ? b : a).venueId } }), schema: boundSchemaOf(m) };
      });
    const [ra, rb] = await Promise.all([both(a), both(b)]);
    expect(ra.value.mine?.id).toBe(a.venueId);
    expect(rb.value.mine?.id).toBe(b.venueId);
    expect(ra.value.theirs).toBeNull();
    expect(rb.value.theirs).toBeNull();
    expect([ra.value.schema, rb.value.schema]).toEqual([a.schema, b.schema]);
    expectQualified(ra.statements, a.schema);
    expectQualified(rb.statements, b.schema);
    if (hwsRuntimeOn()) {
      expect(ra.statements.join('\n')).not.toContain(b.schema);
      expect(rb.statements.join('\n')).not.toContain(a.schema);
    }
  });

  it('runInTenantContext hands out the same schema-bound manager (the 370 general-purpose call sites)', async () => {
    const schema = await tenantContext.runInTenantContext(ctxOf(a), async (m) => {
      await m.query(TRAP_SQL);
      expect(await m.findOne(Venue, { where: { id: a.venueId } })).not.toBeNull();
      return boundSchemaOf(m);
    });
    expect(schema).toBe(a.schema);
    // A workspace-less context binds 'core' (search_path 'core' today): entity SQL names "core" too.
    const coreSchema = await tenantContext.runInTenantContext({ ...ctxOf(a), workspaceId: null }, async (m) => boundSchemaOf(m));
    expect(coreSchema).toBe('core');
  });

  it('control: without the schema-bound manager the trap really fails an unqualified workspace table with 42P01', async () => {
    const code = await tenantContext
      .runInWorkspaceContext(ctxOf(a), async (m) => {
        await m.query(TRAP_SQL);
        return m.query('SELECT 1 FROM venue LIMIT 1');
      })
      .then(
        () => 'ok',
        (e) => pgCode(e),
      );
    expect(code).toBe('42P01');
  });
});
