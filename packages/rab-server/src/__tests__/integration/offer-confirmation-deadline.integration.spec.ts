import 'reflect-metadata';
import { CONFIRMATION_DEADLINE_MESSAGES, CONFIRMATION_DEADLINE_NOTIFICATION } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation } from '../../modules/identity/entities';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * Owner rule 2026-11-06 — the manager-confirmation deadline through the REAL HTTP stack (guard → service → org-scoped CAS
 * → RLS → ownership), as the real Internal Manager / staff member / Venue Manager. THREAT-MODEL "No automatic
 * confirmation" abuse cases:
 *  AC1 a manager confirming after the deadline gets 409 CONFIRMATION_DEADLINE_PASSED and the acceptance is withdrawn
 *      (one audit, the exact staff notice), never booked;
 *  AC2 a Venue Manager cannot confirm at all (403: they categorically lack offer.confirm — they may see the offer);
 *      staff cannot confirm their own offer;
 *  AC3 another organisation's manager gets 404 (never 403) and nothing changes;
 *  AC4 a client can never move the deadline or send a status: the confirm action reads no body, so a smuggled
 *      `status` / `organisationId` / `approvalDeadlineAt` changes nothing (the server clock decides: still the 409);
 *  AC5 a staff accept after the deadline is a 409 and the offer stays pending; a STANDARD send after it is a 409;
 *  AC6 the projections are computed on the server clock (GET /offers, GET /offers/mine).
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const MIN = 60_000;
const HOUR = 60 * MIN;

describeIfDb('manager-confirmation deadline over HTTP (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  type Staff = TestIdentity & { profileId: string };
  async function activeStaff(org: Organisation, owner: TestIdentity, label: string): Promise<Staff> {
    const staff = await factory.createStaff(org, { owner, label });
    await adminDataSource.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = $1`, [staff.profileId]);
    return { ...staff, profileId: staff.profileId! };
  }

  async function seed(label: string) {
    const org = await factory.createOrganisation(label);
    const manager = await factory.createInternalManager(org, { permissions: 'production' });
    const managerToken = await factory.login(manager);
    const venue = await tenantContext.runInTenantContext(
      { organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' },
      (m) => m.save(Venue, { organisationId: org.id, name: `Venue ${label}`, workspaceId: manager.workspaceId!, createdBy: manager.userId }),
    );
    const role = await http().post('/rest/v1/job-roles').set(auth(managerToken)).send({ name: `Role-${randomUUID().slice(0, 8)}`, defaultRatePence: 1500 });
    expect(role.status).toBe(201);
    const staff = await activeStaff(org, manager, `${label}-staff`);
    const staffToken = await factory.login(staff);
    return { org, manager, managerToken, venue, jobRoleId: role.body.id as string, staff, staffToken };
  }
  type Fx = Awaited<ReturnType<typeof seed>>;

  /** A shift `startsInMin` ahead with one offer to the fixture's staff member (sent while sending is still allowed). */
  async function offerOn(fx: Fx, startsInMin = 180): Promise<{ shiftId: string; offerId: string }> {
    const start = new Date(Date.now() + startsInMin * MIN);
    const created = await http().post('/rest/v1/shifts/with-offers').set(auth(fx.managerToken)).send({
      venueId: fx.venue.id,
      jobRoleId: fx.jobRoleId,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 8 * HOUR).toISOString(),
      requiredCount: 1,
      staffProfileIds: [fx.staff.profileId],
    });
    expect(created.status).toBe(201);
    return { shiftId: created.body.shiftId as string, offerId: created.body.results[0].offerId as string };
  }

  /** FIXTURE (tests only): move the offer's assignment so its standard deadline is `offsetMin` from now. */
  async function moveDeadline(offerId: string, offsetMin: number) {
    await adminDataSource.query(
      `UPDATE core.shift_assignment sa SET period = tstzrange(now() + make_interval(mins => $2 + 30), now() + make_interval(mins => $2 + 30 + 480), '[)')
         FROM core.job_offer o WHERE o.id = $1 AND sa.id = o.shift_assignment_id`,
      [offerId, offsetMin],
    );
  }
  const offerRow = async (offerId: string) => (await adminDataSource.query(`SELECT o.*, sa.status AS assignment_status FROM core.job_offer o JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id WHERE o.id = $1`, [offerId]))[0];
  const accept = (fx: Fx, offerId: string) => http().post(`/rest/v1/offers/${offerId}/accept`).set(auth(fx.staffToken));
  const confirm = (token: string, offerId: string, body?: object) => http().post(`/rest/v1/offers/${offerId}/confirm`).set(auth(token)).send(body ?? {});

  it('AC1: confirm after the deadline → 409 CONFIRMATION_DEADLINE_PASSED; withdrawn (rejected_by NULL), one audit, the exact staff notice, no seat', async () => {
    const fx = await seed('dlHttp1');
    const { shiftId, offerId } = await offerOn(fx);
    expect((await accept(fx, offerId)).status).toBe(201);
    await moveDeadline(offerId, -5);
    const res = await confirm(fx.managerToken, offerId);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ statusCode: 409, code: 'CONFIRMATION_DEADLINE_PASSED', message: CONFIRMATION_DEADLINE_MESSAGES.CONFIRM });
    const row = await offerRow(offerId);
    expect(row).toMatchObject({ status: 'manager_rejected', rejected_by: null, rejection_reason: 'confirmation_deadline_passed', confirmed_by: null, assignment_status: 'rejected' });
    expect((await adminDataSource.query(`SELECT filled_count FROM core.shift WHERE id = $1`, [shiftId]))[0].filled_count).toBe(0);
    const audits = await adminDataSource.query(`SELECT actor_user_id FROM core.audit_log WHERE entity_id = $1 AND action = 'offer.rejected_by_worker'`, [offerId]);
    expect(audits).toEqual([{ actor_user_id: null }]);
    const notes = await adminDataSource.query(`SELECT title, message FROM core.notification WHERE user_id = $1 AND related_entity_id = $2 AND type = 'offer_rejected'`, [fx.staff.userId, offerId]);
    expect(notes).toEqual([{ title: 'Shift offer withdrawn', message: CONFIRMATION_DEADLINE_NOTIFICATION.STAFF.message }]);
    // A retry is the same coded 409 and changes nothing.
    expect((await confirm(fx.managerToken, offerId)).body.code).toBe('CONFIRMATION_DEADLINE_PASSED');
    expect(await adminDataSource.query(`SELECT 1 FROM core.audit_log WHERE entity_id = $1 AND action = 'offer.rejected_by_worker'`, [offerId])).toHaveLength(1);
  });

  it('AC1b: confirm before the deadline books the seat with confirmed_by = the manager', async () => {
    const fx = await seed('dlHttp1b');
    const { offerId } = await offerOn(fx);
    expect((await accept(fx, offerId)).status).toBe(201);
    const res = await confirm(fx.managerToken, offerId);
    expect(res.status).toBe(201);
    expect(await offerRow(offerId)).toMatchObject({ status: 'manager_confirmed', confirmed_by: fx.manager.userId, assignment_status: 'confirmed' });
  });

  it('AC2: a Venue Manager of the venue gets 403 (lacks offer.confirm); the staff member cannot confirm their own offer', async () => {
    const fx = await seed('dlHttp2');
    const vm = await factory.createVenueManager(fx.org, { owner: fx.manager, venueIds: [fx.venue.id] });
    const vmToken = await factory.login(vm);
    const { offerId } = await offerOn(fx);
    expect((await accept(fx, offerId)).status).toBe(201);
    expect((await confirm(vmToken, offerId)).status).toBe(403);
    expect([401, 403]).toContain((await confirm(fx.staffToken, offerId)).status);
    expect((await offerRow(offerId)).status).toBe('staff_accepted');
  });

  it('AC3: another organisation’s manager gets 404, not 403, before or after the deadline; nothing changes', async () => {
    const fx = await seed('dlHttp3');
    const other = await seed('dlHttp3other');
    const { offerId } = await offerOn(fx);
    expect((await accept(fx, offerId)).status).toBe(201);
    expect((await confirm(other.managerToken, offerId)).status).toBe(404);
    await moveDeadline(offerId, -5);
    expect((await confirm(other.managerToken, offerId)).status).toBe(404);
    expect((await offerRow(offerId)).status).toBe('staff_accepted'); // the foreign request never triggered the lazy withdrawal
  });

  it('AC4: no client field can confirm, move the deadline or set a status — the confirm action reads no body, the server clock decides', async () => {
    const fx = await seed('dlHttp4');
    const { offerId } = await offerOn(fx);
    expect((await accept(fx, offerId)).status).toBe(201);
    await moveDeadline(offerId, -5);
    for (const body of [{ status: 'manager_confirmed' }, { organisationId: fx.org.id }, { approvalDeadlineAt: new Date(Date.now() + HOUR).toISOString() }]) {
      const res = await confirm(fx.managerToken, offerId, body);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFIRMATION_DEADLINE_PASSED');
    }
    expect(await offerRow(offerId)).toMatchObject({ status: 'manager_rejected', confirmed_by: null });
  });

  it('AC5: a staff accept after the deadline is a 409 (offer stays pending); a STANDARD send within 30 minutes of start is a 409', async () => {
    const fx = await seed('dlHttp5');
    const { offerId } = await offerOn(fx);
    await moveDeadline(offerId, -5);
    const res = await accept(fx, offerId);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ statusCode: 409, code: 'CONFIRMATION_DEADLINE_PASSED', message: CONFIRMATION_DEADLINE_MESSAGES.ACCEPT });
    expect((await offerRow(offerId)).status).toBe('pending');

    const start = new Date(Date.now() + 20 * MIN);
    const late = await http().post('/rest/v1/shifts/with-offers').set(auth(fx.managerToken)).send({
      venueId: fx.venue.id, jobRoleId: fx.jobRoleId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 6 * HOUR).toISOString(),
      requiredCount: 1, staffProfileIds: [fx.staff.profileId],
    });
    expect(late.status).toBe(409);
    expect(late.body).toEqual({ statusCode: 409, code: 'CONFIRMATION_DEADLINE_PASSED', message: CONFIRMATION_DEADLINE_MESSAGES.SEND });
  });

  it('AC6: projections on the server clock — GET /offers (manager) and GET /offers/mine (staff)', async () => {
    const fx = await seed('dlHttp6');
    const { offerId } = await offerOn(fx);
    let mine = (await http().get('/rest/v1/offers/mine').set(auth(fx.staffToken))).body.find((o: { id: string }) => o.id === offerId);
    expect(mine).toMatchObject({ canAccept: true, awaitingManagerConfirmation: false, closedReason: null });
    expect(mine).not.toHaveProperty('canConfirm');
    expect((await accept(fx, offerId)).status).toBe(201);
    const list = async () => (await http().get('/rest/v1/offers').set(auth(fx.managerToken))).body.data.find((o: { id: string }) => o.id === offerId);
    expect(await list()).toMatchObject({ awaitingManagerConfirmation: true, canConfirm: true, closedReason: null });
    await moveDeadline(offerId, -5);
    expect(await list()).toMatchObject({ status: 'staff_accepted', awaitingManagerConfirmation: false, canConfirm: false, closedReason: 'confirmation_deadline_passed' });
    mine = (await http().get('/rest/v1/offers/mine').set(auth(fx.staffToken))).body.find((o: { id: string }) => o.id === offerId);
    expect(mine.presentation).toMatchObject({ state: 'rejected', closedReason: 'confirmation_deadline_passed', canAccept: false });
    const deadline = new Date(mine.approvalDeadlineAt).getTime();
    const start = new Date(mine.startsAt).getTime();
    expect(start - deadline).toBe(30 * MIN);
  });
});
