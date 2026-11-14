import 'reflect-metadata';
import { PermissionFlag } from '@rab/shared';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation } from '../../modules/identity/entities';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * QR review L3 (2026-11-14): `rotateShiftQr` scope and concurrency, on real PostgreSQL with RLS on.
 *  - a same-organisation shift owned by a DIFFERENT manager is 404 (never 403), nothing changes;
 *  - a venue-scoped role holding schedule.create: the route is manager-web only, so the Venue Manager app token is refused
 *    before the service (403 application); the service itself (layer 2 + assertShiftOwned) applies the venue scope —
 *    outside the role's venues 404, inside it rotates;
 *  - two rotations that overlap on the row: exactly one wins (201), the other is a clean 409, qr_version +1 exactly.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('shift QR rotation — scope and concurrency (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let schedulingService: SchedulingService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    schedulingService = moduleRef.get(SchedulingService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  const ctxOf = (who: TestIdentity) => ({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' });
  const rotate = (token: string, shiftId: string) =>
    request(app.getHttpServer()).post(`/rest/v1/shifts/${shiftId}/rotate-qr`).set('Authorization', `Bearer ${token}`).send();
  const qrVersionOf = async (shiftId: string): Promise<number> => (await adminDataSource.query(`SELECT qr_version FROM core.shift WHERE id = $1`, [shiftId]))[0].qr_version;

  /** A venue and an open shift there, created by `owner` inside the owner's workspace. */
  async function venueWithShift(org: Organisation, owner: TestIdentity, label: string): Promise<{ venueId: string; shiftId: string }> {
    return tenantContext.runInTenantContext(ctxOf(owner), async (m) => {
      const venue = await m.save(Venue, { organisationId: org.id, name: `${label} Venue`, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      const role = await m.save(JobRole, { organisationId: org.id, name: `${label} Role`, defaultRatePence: 1500, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      const startsAt = new Date(Date.now() + 2 * 3600_000);
      const shift = await m.save(Shift, {
        organisationId: org.id, venueId: venue.id, jobRoleId: role.id, startsAt, endsAt: new Date(startsAt.getTime() + 6 * 3600_000),
        breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: 'open', createdBy: owner.userId, workspaceId: owner.workspaceId!,
      });
      return { venueId: venue.id, shiftId: shift.id };
    });
  }

  it('a same-organisation shift owned by a different manager is 404 (never 403) and its QR version is unchanged', async () => {
    const org = await factory.createOrganisation('rotscope');
    const ownerA = await factory.createInternalManager(org, { label: 'mgra' });
    const ownerB = await factory.createInternalManager(org, { label: 'mgrb' });
    const { shiftId } = await venueWithShift(org, ownerA, 'A');
    const tokenB = await factory.login(ownerB);
    const res = await rotate(tokenB, shiftId);
    expect(res.status).toBe(404);
    await expect(schedulingService.rotateShiftQr(ctxOf(ownerB), shiftId)).rejects.toBeInstanceOf(NotFoundException);
    expect(await qrVersionOf(shiftId)).toBe(1);
    // Control: the owner can rotate it.
    expect((await rotate(await factory.login(ownerA), shiftId)).status).toBe(201);
    expect(await qrVersionOf(shiftId)).toBe(2);
  });

  it('a venue-scoped role with schedule.create: refused over HTTP (manager-web route), and the service scope is 404 outside its venues, rotates inside', async () => {
    const org = await factory.createOrganisation('rotvenue');
    const owner = await factory.createInternalManager(org, { label: 'owner' });
    const inside = await venueWithShift(org, owner, 'In');
    const outside = await venueWithShift(org, owner, 'Out');
    const vm = await factory.createVenueManager(org, {
      owner,
      venueIds: [inside.venueId],
      permissions: [PermissionFlag.SCHEDULE_VIEW, PermissionFlag.SCHEDULE_CREATE, PermissionFlag.VENUE_VIEW, PermissionFlag.ATTENDANCE_VIEW],
    });

    const vmToken = await factory.login(vm);
    expect((await rotate(vmToken, inside.shiftId)).status).toBe(403); // Venue Manager app credentials never reach a manager-web route

    await expect(schedulingService.rotateShiftQr(ctxOf(vm), outside.shiftId)).rejects.toBeInstanceOf(NotFoundException);
    expect(await qrVersionOf(outside.shiftId)).toBe(1);
    const rotated = await schedulingService.rotateShiftQr(ctxOf(vm), inside.shiftId);
    expect(rotated.qrVersion).toBe(2);
    expect(await qrVersionOf(inside.shiftId)).toBe(2);
  });

  it('two overlapping rotations (both read version 1, then queue on the row lock): exactly one 201 and one 409, qr_version +1 exactly', async () => {
    const org = await factory.createOrganisation('rotrace');
    const owner = await factory.createInternalManager(org, { label: 'owner' });
    const { shiftId } = await venueWithShift(org, owner, 'Race');
    const token = await factory.login(owner);

    // Hold the row so both requests read qr_version = 1 and then queue on rotateShiftQr's FOR UPDATE row lock: a
    // deterministic overlap. Waiters are counted only in THIS database and only when blocked by THIS holder (which locks
    // nothing but this shift's row), never another suite's activity.
    const holder = adminDataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    let both: Promise<request.Response[]>;
    try {
      await holder.query(`SELECT id FROM core.shift WHERE id = $1 FOR UPDATE`, [shiftId]);
      const [{ pid: holderPid }] = await holder.query(`SELECT pg_backend_pid() AS pid`);
      both = Promise.all([rotate(token, shiftId), rotate(token, shiftId)]);
      const deadline = Date.now() + 20_000;
      for (;;) {
        const [{ n }] = await adminDataSource.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))`,
          [holderPid],
        );
        if (n >= 2) break;
        if (Date.now() > deadline) throw new Error(`only ${n} rotation(s) reached the row lock`);
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
    }
    const results = await both!;
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await qrVersionOf(shiftId)).toBe(2);
    const [{ n }] = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE action = 'shift.qr_rotated' AND entity_id = $1`, [shiftId]);
    expect(n).toBe(1);
  });
});
