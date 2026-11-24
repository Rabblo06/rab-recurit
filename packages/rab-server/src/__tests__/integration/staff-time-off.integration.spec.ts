import 'reflect-metadata';
import {
  EmploymentStatus,
  InvalidTransitionError,
  PermissionFlag,
  PermissionFlagType,
} from '@rab/shared';
import {
  ForbiddenException,
  INestApplication,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { OfferService } from '../../modules/offer/services/offer.service';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { assertNoApprovedTimeOff } from '../../modules/staff/services/staff-time-off-check';
import { StaffTimeOffService } from '../../modules/staff/services/staff-time-off.service';
import { VenueService } from '../../modules/venue/services/venue.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTableOf, siblingTable } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * core.staff_time_off (StaffTimeOffSchema1786722230000, DRAFT; owner decisions 42 and 48) end to end on real PostgreSQL
 * with FORCE RLS: staff request → manager approve → the offer hard block at send AND at confirmation, judged on
 * organisation-local days (overnight, an organisation zone ahead of UTC, a daylight-saving change), and the abuse cases of
 * rab-workforce-architecture.md §1.2:
 *   - zero rows with no tenant context bound;
 *   - a staff member reads and cancels only their own rows (404 otherwise), never inserts approved rows or decides;
 *   - a Venue Manager sees nothing; another workspace's manager and another organisation's manager get 404;
 *   - a flag revoked → 403 in the service before any read, nothing written; forbidden body fields → 400;
 *   - a raw INSERT naming someone else's staff_user_id is refused by RLS; there is no DELETE grant; identity and date
 *     columns can never be updated.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

const pgCode = (error: unknown): string | undefined =>
  (error as { driverError?: { code?: string }; code?: string })?.driverError
    ?.code ?? (error as { code?: string })?.code;

async function sqlState(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return pgCode(error);
  }
  throw new Error('expected the statement to be refused, but it succeeded');
}

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** The calendar date `offset` days from today (UTC), as YYYY-MM-DD. */
const day = (offset: number) => isoDay(new Date(Date.now() + offset * DAY_MS));
/** `date` (YYYY-MM-DD) at hh:mm UTC. */
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00.000Z`);
const plusDays = (date: string, n: number) =>
  isoDay(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS));

/** The next last-Sunday-of-October (Europe/London leaves daylight saving at 01:00 UTC that day) at least 3 days away. */
function nextAutumnChange(): string {
  const now = new Date();
  for (let year = now.getUTCFullYear(); ; year++) {
    const lastOct = new Date(Date.UTC(year, 9, 31));
    lastOct.setUTCDate(31 - lastOct.getUTCDay());
    if (lastOct.getTime() > now.getTime() + 3 * DAY_MS) return isoDay(lastOct);
  }
}

describeIfDb(
  'staff time off: request, approval, the offer hard block and RLS (integration)',
  () => {
    jest.setTimeout(300_000);

    let app: INestApplication;
    let dataSource: DataSource;
    let admin: DataSource;
    let factory: TestIdentityFactory;
    let tenantContext: TenantContextService;
    let scheduling: SchedulingService;
    let venues: VenueService;
    let offers: OfferService;
    let timeOff: StaffTimeOffService;

    let a: TestIdentity; // manager, workspace A (owns the staff below)
    let b: TestIdentity; // manager, workspace B, same organisation
    let other: TestIdentity; // manager of another organisation
    let vm: TestIdentity; // Venue Manager in workspace A
    let worker: TestIdentity; // staff of A
    let peer: TestIdentity; // staff of A
    let tzStaff: TestIdentity; // staff of A, the organisation time-zone send
    let dstStaff: TestIdentity; // staff of A, the daylight-saving day computation
    let ctxA: AuthContext;
    let venueId: string;
    let roleId: string;
    let tokenA: string;
    let tokenWorker: string;
    let tokenPeer: string;

    const ctxOf = (id: TestIdentity): AuthContext => ({
      organisationId: id.organisationId,
      workspaceId: id.workspaceId,
      userId: id.userId,
      role: '',
    });
    const as = <T>(who: TestIdentity, fn: (m: EntityManager) => Promise<T>) =>
      tenantContext.runInTenantContext(ctxOf(who), fn);
    const http = () => request(app.getHttpServer());
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

    const setTimezone = (tz: string) =>
      admin.query(`UPDATE core.organisation SET timezone = $2 WHERE id = $1`, [
        a.organisationId,
        tz,
      ]);
    const shiftAt = async (startsAt: Date, hours: number) => {
      const shift = await scheduling.create(ctxA, {
        venueId,
        jobRoleId: roleId,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + hours * 3_600_000).toISOString(),
        requiredCount: 1,
        breakMinutes: 0,
      } as never);
      await scheduling.publish(ctxA, shift.id);
      return shift;
    };
    const send = (shiftId: string, staff: TestIdentity) =>
      offers.send(ctxA, shiftId, { staffProfileId: staff.profileId! } as never);
    const rowOf = async (id: string) =>
      (
        await admin.query(
          `SELECT status, decided_by, cancelled_by, decline_reason FROM core.staff_time_off WHERE id = $1`,
          [id],
        )
      )[0] as
        | {
            status: string;
            decided_by: string | null;
            cancelled_by: string | null;
            decline_reason: string | null;
          }
        | undefined;
    const countFor = async (staff: TestIdentity) =>
      Number(
        (
          await admin.query(
            `SELECT count(*)::int AS n FROM core.staff_time_off WHERE staff_profile_id = $1`,
            [staff.profileId],
          )
        )[0].n,
      );
    const request_ = (
      staff: TestIdentity,
      startsOn: string,
      endsOn = startsOn,
    ) =>
      timeOff.request(ctxOf(staff), {
        startsOn,
        endsOn,
        note: 'private reason',
      });

    const bumpSecurityVersion = (identity: TestIdentity) =>
      admin.query(
        `UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`,
        [identity.userId],
      );
    async function withRevoked<T>(
      identity: TestIdentity,
      flag: PermissionFlagType,
      fn: () => Promise<T>,
    ): Promise<T> {
      const inserted = (await admin.query(
        `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3 RETURNING user_id`,
        [identity.userId, identity.organisationId, flag],
      )) as unknown[];
      if (inserted.length !== 1)
        throw new Error(
          `test setup: permission ${flag} is not in the catalogue`,
        );
      await bumpSecurityVersion(identity);
      try {
        return await fn();
      } finally {
        await admin.query(
          `DELETE FROM core.user_permission_override WHERE user_id = $1 AND permission_id = (SELECT id FROM core.permission WHERE key = $2)`,
          [identity.userId, flag],
        );
        await bumpSecurityVersion(identity);
      }
    }

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = applyGlobalValidationPipe(moduleRef.createNestApplication());
      await app.init();
      dataSource = moduleRef.get(DataSource);
      tenantContext = moduleRef.get(TenantContextService);
      admin = createAdminDataSource();
      await admin.initialize();
      factory = new TestIdentityFactory({
        app,
        dataSource,
        adminDataSource: admin,
        tenantContext,
        passwordHashing: moduleRef.get(PasswordHashingService),
      });
      scheduling = moduleRef.get(SchedulingService);
      venues = moduleRef.get(VenueService);
      offers = moduleRef.get(OfferService);
      timeOff = moduleRef.get(StaffTimeOffService);

      const seeded = await factory.createOrganisationWithManagers(2, {
        permissions: 'production',
        workspace: true,
        label: 'sto',
      });
      [a, b] = seeded.managers as [TestIdentity, TestIdentity];
      ctxA = ctxOf(a);
      other = (
        await factory.createOrganisationWithManagers(1, {
          permissions: 'production',
          workspace: true,
          label: 'sto-other',
        })
      ).managers[0]!;
      venueId = (
        await venues.create(ctxA, {
          name: `STO Venue ${randomUUID().slice(0, 6)}`,
          type: 'hotel',
        } as never)
      ).id;
      roleId = (
        await scheduling.createJobRole(ctxA, {
          name: `STO Role ${randomUUID().slice(0, 8)}`,
          defaultRatePence: 1500,
        } as never)
      ).id;
      vm = await factory.createVenueManager(seeded.organisation, {
        owner: a,
        venueIds: [venueId],
      });
      worker = await factory.createStaff(seeded.organisation, {
        owner: a,
        label: 'sto-worker',
      });
      peer = await factory.createStaff(seeded.organisation, {
        owner: a,
        label: 'sto-peer',
      });
      tzStaff = await factory.createStaff(seeded.organisation, {
        owner: a,
        label: 'sto-tz',
      });
      dstStaff = await factory.createStaff(seeded.organisation, {
        owner: a,
        label: 'sto-dst',
      });
      for (const s of [worker, peer, tzStaff, dstStaff]) {
        await admin.query(
          `UPDATE ${await businessTableOf(admin, 'staff_profile', s.profileId)} SET employment_status = $2 WHERE id = $1`,
          [s.profileId, EmploymentStatus.ACTIVE],
        );
      }
      // Deterministic days: the organisation is UTC unless a test sets another zone (each restores UTC).
      await setTimezone('UTC');
      tokenA = await factory.login(a);
      tokenWorker = await factory.login(worker);
      tokenPeer = await factory.login(peer);
    });

    afterAll(async () => {
      await app?.close();
      await admin?.destroy();
    });

    // ------------------------------------------------------------------------------------------------ the hard block (decision 42)

    it('ZERO ROWS WITHOUT TENANT CONTEXT: the runtime login reads nothing from core.staff_time_off', async () => {
      await request_(peer, day(200));
      expect(
        await dataSource.manager.query(`SELECT id FROM core.staff_time_off`),
      ).toHaveLength(0);
      // The rows exist (the admin connection bypasses RLS): the zero above is RLS, not an empty table.
      expect(await countFor(peer)).toBeGreaterThan(0);
    });

    it('staff request (HTTP) → manager approve (HTTP) → the offer send is refused with 409 STAFF_TIME_OFF; cancelling lifts it', async () => {
      const d = day(20);
      const requested = await http()
        .post('/rest/v1/me/time-off')
        .set(bearer(tokenWorker))
        .send({ startsOn: d, endsOn: d, note: 'wedding' });
      expect(requested.status).toBe(201);
      expect(requested.body).toMatchObject({
        staffProfileId: worker.profileId,
        startsOn: d,
        endsOn: d,
        status: 'requested',
      });
      expect(requested.body.organisationId).toBeUndefined();
      expect(requested.body.staffUserId).toBeUndefined();

      const approved = await http()
        .post(`/rest/v1/time-off/${requested.body.id}/approve`)
        .set(bearer(tokenA))
        .send({});
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({
        status: 'approved',
        decidedBy: a.userId,
      });

      const shift = await shiftAt(at(d, '09:00'), 6);
      await expect(send(shift.id, worker)).rejects.toMatchObject({
        response: {
          code: 'STAFF_TIME_OFF',
          message: `This staff member has approved time off on ${d}.`,
        },
      });
      const viaHttp = await http()
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set(bearer(tokenA))
        .send({ staffProfileId: worker.profileId });
      expect(viaHttp.status).toBe(409);
      expect(viaHttp.body.code).toBe('STAFF_TIME_OFF');
      // Nothing was created for the refused send.
      const seatTable = siblingTable(
        await businessTableOf(admin, 'shift', shift.id),
        'shift_assignment',
      );
      expect(
        await admin.query(`SELECT id FROM ${seatTable} WHERE shift_id = $1`, [
          shift.id,
        ]),
      ).toHaveLength(0);

      // A manager cancels the approved time off: the block is gone.
      const cancelled = await http()
        .post(`/rest/v1/time-off/${requested.body.id}/cancel`)
        .set(bearer(tokenA))
        .send({});
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({
        status: 'cancelled',
        cancelledBy: a.userId,
        decidedBy: a.userId,
      });
      await expect(send(shift.id, worker)).resolves.toMatchObject({
        staffProfileId: worker.profileId,
      });
    });

    it('a requested (unapproved) range does not block (FLAGGED reading of decision 42)', async () => {
      const d = day(25);
      const pending = await request_(worker, d);
      expect(pending.status).toBe('requested');
      const shift = await shiftAt(at(d, '10:00'), 4);
      await expect(send(shift.id, worker)).resolves.toMatchObject({
        staffProfileId: worker.profileId,
      });
    });

    it('time off approved AFTER the offer was sent stops the confirmation (409 STAFF_TIME_OFF); the claim rolls back', async () => {
      const d = day(30);
      const shift = await shiftAt(at(d, '10:00'), 6);
      const offer = await send(shift.id, worker);
      await offers.staffAccept(ctxOf(worker), offer.id);
      const row = await request_(worker, d);
      await timeOff.approve(ctxA, row.id);
      await expect(offers.managerConfirm(ctxA, offer.id)).rejects.toMatchObject(
        { response: { code: 'STAFF_TIME_OFF' } },
      );
      const offerTable = siblingTable(
        await businessTableOf(admin, 'shift', shift.id),
        'job_offer',
      );
      const seatTable = siblingTable(offerTable, 'shift_assignment');
      const shiftTable = siblingTable(offerTable, 'shift');
      expect(
        (
          await admin.query(`SELECT status FROM ${offerTable} WHERE id = $1`, [
            offer.id,
          ])
        )[0].status,
      ).toBe('staff_accepted');
      expect(
        (
          await admin.query(
            `SELECT status FROM ${seatTable} WHERE shift_id = $1`,
            [shift.id],
          )
        )[0].status,
      ).toBe('staff_accepted');
      expect(
        (
          await admin.query(
            `SELECT filled_count FROM ${shiftTable} WHERE id = $1`,
            [shift.id],
          )
        )[0].filled_count,
      ).toBe(0);
    });

    it('organisation time zone: a shift at 23:30 UTC on D is D+1 in a UTC+1 organisation (time off on D blocks only under UTC, where it is overnight)', async () => {
      const d = day(40);
      await timeOff.enter(ctxA, tzStaff.profileId!, { startsOn: d, endsOn: d });
      const underUtc = await shiftAt(at(d, '23:30'), 2);
      const underLagos = await shiftAt(at(d, '23:30'), 2);
      try {
        // UTC: 23:30 D → 01:30 D+1 touches D (overnight) → blocked on D.
        await expect(send(underUtc.id, tzStaff)).rejects.toMatchObject({
          response: {
            code: 'STAFF_TIME_OFF',
            message: expect.stringContaining(d),
          },
        });
        // Africa/Lagos is UTC+1 all year (no daylight saving): 00:30 → 02:30 on D+1 only → not blocked.
        await setTimezone('Africa/Lagos');
        await expect(send(underLagos.id, tzStaff)).resolves.toMatchObject({
          staffProfileId: tzStaff.profileId,
        });
      } finally {
        await setTimezone('UTC');
      }
    });

    it('day computation on real PostgreSQL: overnight touches both days, a window ending at local midnight does not touch the next, daylight saving uses the offset in force', async () => {
      const o = nextAutumnChange(); // Europe/London: BST (UTC+1) until 01:00 UTC on o, GMT (UTC+0) after
      await timeOff.enter(ctxA, dstStaff.profileId!, {
        startsOn: o,
        endsOn: o,
      });
      const staff = {
        staffProfileId: dstStaff.profileId!,
        staffUserId: dstStaff.userId,
      };
      const check = (startsAt: Date, endsAt: Date) =>
        as(a, (m) => assertNoApprovedTimeOff(m, staff, { startsAt, endsAt }));
      const prev = plusDays(o, -1);
      const next = plusDays(o, 1);
      try {
        await setTimezone('Europe/London');
        // BST: 23:30Z on o-1 is 00:30 on o → blocked.
        await expect(
          check(at(prev, '23:30'), at(o, '00:15')),
        ).rejects.toMatchObject({ response: { code: 'STAFF_TIME_OFF' } });
        // BST: 22:00Z → 23:00Z on o-1 is 23:00 → 00:00 local, ending exactly at midnight: o-1 only → not blocked.
        await expect(
          check(at(prev, '22:00'), at(prev, '23:00')),
        ).resolves.toBeUndefined();
        // GMT after the change: 23:15Z → 23:45Z on o is still o → blocked (BST would have made it o+1).
        await expect(
          check(at(o, '23:15'), at(o, '23:45')),
        ).rejects.toMatchObject({ response: { code: 'STAFF_TIME_OFF' } });
        // Overnight o+1: 22:00Z on o → 04:00Z on o+1 touches o → blocked; wholly on o+1 → not blocked.
        await expect(
          check(at(o, '22:00'), at(next, '04:00')),
        ).rejects.toMatchObject({ response: { code: 'STAFF_TIME_OFF' } });
        await expect(
          check(at(next, '00:30'), at(next, '06:00')),
        ).resolves.toBeUndefined();
      } finally {
        await setTimezone('UTC');
      }
      // Fail closed: with no tenant context the organisation zone is invisible → refused, never a pass.
      await expect(
        dataSource.transaction((m) =>
          assertNoApprovedTimeOff(m, staff, {
            startsAt: at(o, '10:00'),
            endsAt: at(o, '11:00'),
          }),
        ),
      ).rejects.toMatchObject({
        response: { code: 'STAFF_TIME_OFF_UNVERIFIABLE' },
      });
      // A session that cannot see this staff member's time off (a Venue Manager) is refused, never passed.
      await expect(
        as(vm, (m) =>
          assertNoApprovedTimeOff(m, staff, {
            startsAt: at(o, '10:00'),
            endsAt: at(o, '11:00'),
          }),
        ),
      ).rejects.toMatchObject({
        response: { code: 'STAFF_TIME_OFF_UNVERIFIABLE' },
      });
    });

    // ------------------------------------------------------------------------------------------------ RLS and abuse cases

    it("a staff member reads and cancels only their own rows: another staff member's row is invisible and a 404", async () => {
      const row = await request_(worker, day(60));
      expect(
        await as(
          peer,
          async (m) =>
            (
              await m.query(
                `SELECT id FROM core.staff_time_off WHERE id = $1`,
                [row.id],
              )
            ).length,
        ),
      ).toBe(0);
      expect(
        await as(
          worker,
          async (m) =>
            (
              await m.query(
                `SELECT id FROM core.staff_time_off WHERE id = $1`,
                [row.id],
              )
            ).length,
        ),
      ).toBe(1);
      const peerList = await http()
        .get('/rest/v1/me/time-off')
        .set(bearer(tokenPeer));
      expect(peerList.status).toBe(200);
      expect(peerList.body.data.map((r: { id: string }) => r.id)).not.toContain(
        row.id,
      );
      const cancel = await http()
        .post(`/rest/v1/me/time-off/${row.id}/cancel`)
        .set(bearer(tokenPeer))
        .send({});
      expect(cancel.status).toBe(404);
      await expect(
        timeOff.cancelMine(ctxOf(peer), row.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      // A raw cancel by the other staff member touches nothing (RLS USING hides the row).
      const [, touched] = await as(peer, (m) =>
        m.query(
          `UPDATE core.staff_time_off SET status = 'cancelled', cancelled_by = $2, cancelled_at = now() WHERE id = $1`,
          [row.id, peer.userId],
        ),
      );
      expect(touched).toBe(0);
      expect((await rowOf(row.id))!.status).toBe('requested');
      // The owner may withdraw their own request; approved time off is a manager's to cancel (409).
      const own = await http()
        .post(`/rest/v1/me/time-off/${row.id}/cancel`)
        .set(bearer(tokenWorker))
        .send({});
      expect(own.status).toBe(200);
      expect(own.body).toMatchObject({
        status: 'cancelled',
        cancelledBy: worker.userId,
        decidedBy: null,
      });
      const approvedRow = await request_(worker, day(61));
      await timeOff.approve(ctxA, approvedRow.id);
      const refused = await http()
        .post(`/rest/v1/me/time-off/${approvedRow.id}/cancel`)
        .set(bearer(tokenWorker))
        .send({});
      expect(refused.status).toBe(409);
      expect((await rowOf(approvedRow.id))!.status).toBe('approved');
    });

    it('a staff member cannot insert approved rows or decide: RLS WITH CHECK refuses (42501) and the manager routes refuse', async () => {
      const row = await request_(worker, day(65));
      expect(
        await sqlState(
          as(worker, (m) =>
            m.query(
              `INSERT INTO core.staff_time_off (organisation_id, workspace_id, staff_profile_id, staff_user_id, starts_on, ends_on, status, requested_by, decided_by, decided_at)
             VALUES ($1, $2, $3, $4, $5, $5, 'approved', $4, $4, now())`,
              [
                worker.organisationId,
                worker.workspaceId,
                worker.profileId,
                worker.userId,
                day(66),
              ],
            ),
          ),
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          as(worker, (m) =>
            m.query(
              `UPDATE core.staff_time_off SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`,
              [row.id, worker.userId],
            ),
          ),
        ),
      ).toBe('42501');
      for (const [method, path] of [
        ['post', `/rest/v1/time-off/${row.id}/approve`],
        ['post', `/rest/v1/time-off/${row.id}/decline`],
        ['post', `/rest/v1/staff/${worker.profileId}/time-off`],
        ['get', '/rest/v1/time-off'],
      ] as const) {
        const res =
          method === 'post'
            ? await http()
                .post(path)
                .set(bearer(tokenWorker))
                .send({ reason: 'x', startsOn: day(66), endsOn: day(66) })
            : await http().get(path).set(bearer(tokenWorker));
        expect([401, 403]).toContain(res.status);
      }
      expect((await rowOf(row.id))!.status).toBe('requested');
    });

    it("a raw INSERT bypassing the service with someone else's staff_user_id (or author) is refused by RLS (42501)", async () => {
      const insert = (
        who: TestIdentity,
        staffUserId: string,
        requestedBy: string,
        status = 'requested',
      ) =>
        as(who, (m) =>
          m.query(
            `INSERT INTO core.staff_time_off (organisation_id, workspace_id, staff_profile_id, staff_user_id, starts_on, ends_on, status, requested_by)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`,
            [
              who.organisationId,
              who.workspaceId,
              peer.profileId,
              staffUserId,
              day(70),
              status,
              requestedBy,
            ],
          ),
        );
      const before = await countFor(peer);
      expect(await sqlState(insert(worker, peer.userId, worker.userId))).toBe(
        '42501',
      );
      expect(await sqlState(insert(worker, peer.userId, peer.userId))).toBe(
        '42501',
      );
      // A manager writes only approved rows they decided themselves (never a `requested` row on someone's behalf).
      expect(await sqlState(insert(a, peer.userId, a.userId))).toBe('42501');
      expect(await sqlState(insert(vm, peer.userId, vm.userId))).toBe('42501');
      expect(await countFor(peer)).toBe(before);
    });

    it('a Venue Manager sees and changes nothing and is refused at every route', async () => {
      const row = await request_(peer, day(75));
      expect(
        await as(
          vm,
          async (m) =>
            (await m.query(`SELECT id FROM core.staff_time_off`)).length,
        ),
      ).toBe(0);
      const [, touched] = await as(vm, (m) =>
        m.query(
          `UPDATE core.staff_time_off SET status = 'declined', decided_by = $2, decided_at = now(), decline_reason = 'x' WHERE id = $1`,
          [row.id, vm.userId],
        ),
      );
      expect(touched).toBe(0);
      const token = await factory.login(vm);
      for (const path of [
        '/rest/v1/me/time-off',
        '/rest/v1/time-off',
        `/rest/v1/staff/${peer.profileId}/time-off`,
      ]) {
        expect([401, 403]).toContain(
          (await http().get(path).set(bearer(token))).status,
        );
      }
      expect([401, 403]).toContain(
        (
          await http()
            .post(`/rest/v1/time-off/${row.id}/approve`)
            .set(bearer(token))
            .send({})
        ).status,
      );
      expect((await rowOf(row.id))!.status).toBe('requested');
    });

    it("another workspace's manager and another organisation's manager read nothing and get 404; nothing written", async () => {
      const row = await request_(peer, day(80));
      for (const who of [b, other]) {
        expect(
          await as(
            who,
            async (m) =>
              (
                await m.query(
                  `SELECT id FROM core.staff_time_off WHERE id = $1`,
                  [row.id],
                )
              ).length,
          ),
        ).toBe(0);
        await expect(
          timeOff.approve(ctxOf(who), row.id),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          timeOff.decline(ctxOf(who), row.id, { reason: 'no' }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          timeOff.listForStaff(ctxOf(who), peer.profileId!),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          timeOff.enter(ctxOf(who), peer.profileId!, {
            startsOn: day(81),
            endsOn: day(81),
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
        const listed = await timeOff.listWorkspace(ctxOf(who), {});
        expect(listed.data.map((r) => r.id)).not.toContain(row.id);
        const token = await factory.login(who);
        expect(
          (
            await http()
              .post(`/rest/v1/time-off/${row.id}/approve`)
              .set(bearer(token))
              .send({})
          ).status,
        ).toBe(404);
      }
      expect(await rowOf(row.id)).toMatchObject({
        status: 'requested',
        decided_by: null,
      });
    });

    it('a revoked flag is a 403 in the service before any read; nothing is written', async () => {
      const row = await request_(peer, day(85));
      await withRevoked(a, PermissionFlag.STAFF_EDIT, async () => {
        await expect(timeOff.approve(ctxA, row.id)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(
          timeOff.enter(ctxA, peer.profileId!, {
            startsOn: day(86),
            endsOn: day(86),
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        // 403 for any id, existing or not (never an existence oracle).
        await expect(
          timeOff.approve(ctxA, randomUUID()),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
      await withRevoked(a, PermissionFlag.STAFF_VIEW, async () => {
        await expect(timeOff.listWorkspace(ctxA, {})).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });
      const before = await countFor(peer);
      await withRevoked(peer, PermissionFlag.OFFER_RESPOND, async () => {
        await expect(request_(peer, day(87))).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(
          timeOff.cancelMine(ctxOf(peer), row.id),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
      expect(await countFor(peer)).toBe(before);
      expect(await rowOf(row.id)).toMatchObject({
        status: 'requested',
        decided_by: null,
        cancelled_by: null,
      });
    });

    it('forbidden body fields (organisationId, status, staffUserId, decidedBy, ...) are a 400 and write nothing', async () => {
      const before = await countFor(worker);
      for (const extra of [
        { organisationId: other.organisationId },
        { workspaceId: b.workspaceId },
        { status: 'approved' },
        { staffUserId: peer.userId },
        { staffProfileId: peer.profileId },
        { decidedBy: a.userId },
        { requestedBy: a.userId },
      ]) {
        const res = await http()
          .post('/rest/v1/me/time-off')
          .set(bearer(tokenWorker))
          .send({ startsOn: day(90), endsOn: day(90), ...extra });
        expect(res.status).toBe(400);
        const managerRes = await http()
          .post(`/rest/v1/staff/${worker.profileId}/time-off`)
          .set(bearer(tokenA))
          .send({ startsOn: day(90), endsOn: day(90), ...extra });
        expect(managerRes.status).toBe(400);
      }
      expect(await countFor(worker)).toBe(before);
      const row = await request_(worker, day(91));
      expect(
        (
          await http()
            .post(`/rest/v1/time-off/${row.id}/decline`)
            .set(bearer(tokenA))
            .send({ reason: 'no', status: 'approved' })
        ).status,
      ).toBe(400);
      expect(
        (
          await http()
            .post(`/rest/v1/time-off/${row.id}/approve`)
            .set(bearer(tokenA))
            .send({ decidedBy: b.userId })
        ).status,
      ).toBe(400);
      expect((await rowOf(row.id))!.status).toBe('requested');
    });

    it('no DELETE grant (time off is only declined or cancelled), and identity / date columns can never be updated (42501)', async () => {
      const row = await request_(worker, day(95));
      expect(
        (
          await admin.query(
            `SELECT has_table_privilege('crewflow_app', 'core.staff_time_off', 'DELETE') AS d`,
          )
        )[0].d,
      ).toBe(false);
      for (const who of [a, worker]) {
        expect(
          await sqlState(
            as(who, (m) =>
              m.query(`DELETE FROM core.staff_time_off WHERE id = $1`, [
                row.id,
              ]),
            ),
          ),
        ).toBe('42501');
      }
      for (const [who, column, value] of [
        [a, 'starts_on', day(96)],
        [a, 'staff_user_id', peer.userId],
        [a, 'staff_profile_id', peer.profileId],
        [a, 'requested_by', a.userId],
        [worker, 'ends_on', day(99)],
        [worker, 'note', 'changed'],
        [a, 'workspace_id', b.workspaceId],
      ] as const) {
        expect(
          await sqlState(
            as(who, (m) =>
              m.query(
                `UPDATE core.staff_time_off SET ${column} = $2 WHERE id = $1`,
                [row.id, value],
              ),
            ),
          ),
        ).toBe('42501');
      }
      expect((await rowOf(row.id))!.status).toBe('requested');
    });

    it('decisions follow the transition table: a decided row is never re-decided (409); overlapping approved ranges are a 409', async () => {
      const row = await request_(peer, day(100), day(102));
      await timeOff.decline(ctxA, row.id, { reason: 'rota full' });
      await expect(timeOff.approve(ctxA, row.id)).rejects.toBeInstanceOf(
        InvalidTransitionError,
      );
      await expect(timeOff.cancel(ctxA, row.id)).rejects.toBeInstanceOf(
        InvalidTransitionError,
      );
      expect(
        (
          await http()
            .post(`/rest/v1/time-off/${row.id}/approve`)
            .set(bearer(tokenA))
            .send({})
        ).status,
      ).toBe(409);
      expect(await rowOf(row.id)).toMatchObject({
        status: 'declined',
        decline_reason: 'rota full',
      });
      // A manager's raw re-decision of a declined row touches nothing (RLS USING: requested / approved rows only).
      const [, touched] = await as(a, (m) =>
        m.query(
          `UPDATE core.staff_time_off SET status = 'approved', decline_reason = NULL WHERE id = $1`,
          [row.id],
        ),
      );
      expect(touched).toBe(0);
      await timeOff.enter(ctxA, peer.profileId!, {
        startsOn: day(105),
        endsOn: day(107),
      });
      const overlapping = await request_(peer, day(107), day(108));
      await expect(timeOff.approve(ctxA, overlapping.id)).rejects.toMatchObject(
        { response: { code: 'STAFF_TIME_OFF_OVERLAP' } },
      );
      expect((await rowOf(overlapping.id))!.status).toBe('requested');
    });

    it('HTTP manager views and audit: listed by workspace and by staff member; every write audited with ids and dates, never the note or reason', async () => {
      const created = await http()
        .post('/rest/v1/me/time-off')
        .set(bearer(tokenPeer))
        .send({ startsOn: day(110), endsOn: day(111), note: 'secret note' });
      expect(created.status).toBe(201);
      const listed = await http()
        .get('/rest/v1/time-off?status=requested&limit=200')
        .set(bearer(tokenA));
      expect(listed.status).toBe(200);
      expect(listed.body.data.map((r: { id: string }) => r.id)).toContain(
        created.body.id,
      );
      expect(
        listed.body.data.every(
          (r: { status: string }) => r.status === 'requested',
        ),
      ).toBe(true);
      const byStaff = await http()
        .get(`/rest/v1/staff/${peer.profileId}/time-off`)
        .set(bearer(tokenA));
      expect(byStaff.status).toBe(200);
      expect(byStaff.body.data.map((r: { id: string }) => r.id)).toContain(
        created.body.id,
      );
      expect(
        (await http().get('/rest/v1/time-off?status=bogus').set(bearer(tokenA)))
          .status,
      ).toBe(400);
      const declined = await http()
        .post(`/rest/v1/time-off/${created.body.id}/decline`)
        .set(bearer(tokenA))
        .send({ reason: 'secret reason' });
      expect(declined.status).toBe(200);
      expect(declined.body).toMatchObject({
        status: 'declined',
        declineReason: 'secret reason',
        decidedBy: a.userId,
      });
      const entered = await http()
        .post(`/rest/v1/staff/${peer.profileId}/time-off`)
        .set(bearer(tokenA))
        .send({ startsOn: day(115), endsOn: day(115) });
      expect(entered.status).toBe(201);
      expect(entered.body).toMatchObject({
        status: 'approved',
        requestedBy: a.userId,
        decidedBy: a.userId,
      });
      const audit = (await admin.query(
        `SELECT action, metadata FROM core.audit_log WHERE organisation_id = $1 AND entity_id IN ($2, $3) ORDER BY created_at`,
        [a.organisationId, created.body.id, entered.body.id],
      )) as Array<{ action: string; metadata: Record<string, unknown> }>;
      expect(audit.map((r) => r.action)).toEqual([
        'staff_time_off.requested',
        'staff_time_off.declined',
        'staff_time_off.entered',
      ]);
      expect(audit[0]!.metadata).toMatchObject({
        staffProfileId: peer.profileId,
        startsOn: day(110),
        endsOn: day(111),
      });
      for (const r of audit)
        expect(JSON.stringify(r.metadata)).not.toMatch(/secret/);
    });
  },
);
