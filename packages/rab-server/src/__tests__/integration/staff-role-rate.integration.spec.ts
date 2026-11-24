import 'reflect-metadata';
import {
  EmploymentStatus,
  PermissionFlag,
  PermissionFlagType,
  payForMinutes,
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
import { resolveSeatPayRate } from '../../modules/staff/services/staff-role-rate-resolution';
import { StaffRoleRateService } from '../../modules/staff/services/staff-role-rate.service';
import { VenueService } from '../../modules/venue/services/venue.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import {
  businessTable,
  businessTableOf,
  hwsRuntimeOn,
  siblingTable,
} from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * core.staff_role_rate (StaffRoleRateSchema1786722210000, DRAFT) end to end on real PostgreSQL with FORCE RLS: the
 * confirmation snapshot (architecture §1 A6, CLAUDE.md "Rate resolution is snapshotted at confirmation ... never
 * recalculated later"), the send-time estimate, the five enforcement layers of the management endpoints and the abuse cases
 * of rab-workforce-architecture.md §1.2:
 *   - zero rows with no tenant context bound;
 *   - another workspace's manager (same organisation) and another organisation's manager read nothing and get 404;
 *   - a Venue Manager and a staff member read and write nothing through RLS and are refused at the route;
 *   - a flag revoked → 403 in the service before any read, nothing written;
 *   - organisationId / createdBy / staffProfileId in a body → 400; an overlapping period → 409;
 *   - RLS WITH CHECK refuses a raw insert naming another author; created_by can never be updated;
 *   - orphan rows (no foreign key by design) are never read or applied.
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

describeIfDb(
  'staff role rates: snapshot, endpoints and RLS (integration)',
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
    let rates: StaffRoleRateService;

    let a: TestIdentity; // manager, workspace A (owns the staff below)
    let b: TestIdentity; // manager, workspace B, same organisation
    let other: TestIdentity; // manager of another organisation
    let vm: TestIdentity; // Venue Manager in workspace A
    let worker: TestIdentity; // staff of A, has staff role rates
    let plain: TestIdentity; // staff of A, no staff role rate
    let ctxA: AuthContext;
    let venueId: string;
    let tokenA: string;

    const ctxOf = (id: TestIdentity): AuthContext => ({
      organisationId: id.organisationId,
      workspaceId: id.workspaceId,
      userId: id.userId,
      role: '',
    });
    const as = <T>(who: TestIdentity, fn: (m: EntityManager) => Promise<T>) =>
      tenantContext.runInTenantContext(ctxOf(who), fn);
    const day = (offsetDays: number) =>
      new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
    const http = () => request(app.getHttpServer());
    let shiftDay = 5;
    const newShift = async (jobRoleId: string) => {
      const start = new Date(Date.now() + shiftDay++ * 86_400_000);
      return scheduling.create(ctxA, {
        venueId,
        jobRoleId,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 6 * 3_600_000).toISOString(),
        requiredCount: 1,
        breakMinutes: 0,
      } as never);
    };
    const newRole = async (defaultRatePence: number) =>
      (
        await scheduling.createJobRole(ctxA, {
          name: `SRR Role ${randomUUID().slice(0, 8)}`,
          defaultRatePence,
        } as never)
      ).id;
    const rowCount = async (staffProfileId: string) =>
      Number(
        (
          await admin.query(
            `SELECT count(*)::int AS n FROM core.staff_role_rate WHERE staff_profile_id = $1`,
            [staffProfileId],
          )
        )[0].n,
      );
    const seatOf = async (shiftId: string, staffProfileId: string) => {
      const seatTable = siblingTable(
        await businessTableOf(admin, 'shift', shiftId),
        'shift_assignment',
      );
      return (
        await admin.query(
          `SELECT status, pay_rate_snapshot_pence FROM ${seatTable} WHERE shift_id = $1 AND staff_profile_id = $2`,
          [shiftId, staffProfileId],
        )
      )[0] as {
        status: string;
        pay_rate_snapshot_pence: string;
      };
    };
    const offerEstimate = async (shiftId: string, offerId: string) =>
      (
        await admin.query(
          `SELECT estimated_pay_pence FROM ${siblingTable(await businessTableOf(admin, 'shift', shiftId), 'job_offer')} WHERE id = $1`,
          [offerId],
        )
      )[0].estimated_pay_pence as string;
    const sendAcceptConfirm = async (shiftId: string, staff: TestIdentity) => {
      const offer = await offers.send(ctxA, shiftId, {
        staffProfileId: staff.profileId!,
      } as never);
      await offers.staffAccept(ctxOf(staff), offer.id);
      await offers.managerConfirm(ctxA, offer.id);
      return offer;
    };

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
      rates = moduleRef.get(StaffRoleRateService);

      const seeded = await factory.createOrganisationWithManagers(2, {
        permissions: 'production',
        workspace: true,
        label: 'srr',
      });
      [a, b] = seeded.managers as [TestIdentity, TestIdentity];
      ctxA = ctxOf(a);
      other = (
        await factory.createOrganisationWithManagers(1, {
          permissions: 'production',
          workspace: true,
          label: 'srr-other',
        })
      ).managers[0]!;
      venueId = (
        await venues.create(ctxA, {
          name: `SRR Venue ${randomUUID().slice(0, 6)}`,
          type: 'hotel',
        } as never)
      ).id;
      vm = await factory.createVenueManager(seeded.organisation, {
        owner: a,
        venueIds: [venueId],
      });
      worker = await factory.createStaff(seeded.organisation, {
        owner: a,
        label: 'srr-worker',
      });
      plain = await factory.createStaff(seeded.organisation, {
        owner: a,
        label: 'srr-plain',
      });
      for (const s of [worker, plain]) {
        await admin.query(
          `UPDATE ${await businessTableOf(admin, 'staff_profile', s.profileId)} SET employment_status = $2 WHERE id = $1`,
          [s.profileId, EmploymentStatus.ACTIVE],
        );
      }
      tokenA = await factory.login(a);
    });

    afterAll(async () => {
      await app?.close();
      await admin?.destroy();
    });

    // ------------------------------------------------------------------------------------------------ resolution + snapshot

    it('confirmation snapshots the staff role rate in force (over the venue rate and the default); latest wins; future and ended ignored; no rate → shift rate', async () => {
      const role = await newRole(1400);
      await venues.createRoleRate(ctxA, venueId, {
        jobRoleId: role,
        payRatePence: 2000,
        effectiveFrom: day(-90),
      } as never);
      await rates.create(ctxA, worker.profileId!, {
        jobRoleId: role,
        payRatePence: 2100,
        effectiveFrom: day(-60),
        effectiveTo: day(-11),
      }); // ended
      await rates.create(ctxA, worker.profileId!, {
        jobRoleId: role,
        payRatePence: 2300,
        effectiveFrom: day(-10),
        effectiveTo: day(200),
      }); // in force, latest
      await rates.create(ctxA, worker.profileId!, {
        jobRoleId: role,
        payRatePence: 9000,
        effectiveFrom: day(400),
      }); // future

      const shift = await newShift(role);
      await scheduling.publish(ctxA, shift.id);
      const offer = await offers.send(ctxA, shift.id, {
        staffProfileId: worker.profileId!,
      } as never);
      // Send time: the seat and the estimate already use the staff rate (6 h, no break), the summary shows the seat's rate.
      expect(await seatOf(shift.id, worker.profileId!)).toEqual({
        status: 'offered',
        pay_rate_snapshot_pence: '2300',
      });
      expect(await offerEstimate(shift.id, offer.id)).toBe(
        String(payForMinutes(2300, 360)),
      );
      expect(
        (await offers.list(ctxA)).data.find((o) => o.id === offer.id)
          ?.payRatePence,
      ).toBe(2300);
      await offers.staffAccept(ctxOf(worker), offer.id);
      await offers.managerConfirm(ctxA, offer.id);
      expect(await seatOf(shift.id, worker.profileId!)).toEqual({
        status: 'confirmed',
        pay_rate_snapshot_pence: '2300',
      });

      // Another staff member with no staff role rate: the shift's (venue) rate, exactly as before.
      const shift2 = await newShift(role);
      await scheduling.publish(ctxA, shift2.id);
      await sendAcceptConfirm(shift2.id, plain);
      expect(await seatOf(shift2.id, plain.profileId!)).toEqual({
        status: 'confirmed',
        pay_rate_snapshot_pence: '2000',
      });
    });

    it('a staff rate for another job role never applies', async () => {
      const role = await newRole(1500);
      const otherRole = await newRole(1500);
      await rates.create(ctxA, worker.profileId!, {
        jobRoleId: otherRole,
        payRatePence: 3100,
        effectiveFrom: day(-30),
      });
      const shift = await newShift(role);
      await scheduling.publish(ctxA, shift.id);
      await sendAcceptConfirm(shift.id, worker);
      expect(
        (await seatOf(shift.id, worker.profileId!)).pay_rate_snapshot_pence,
      ).toBe('1500');
    });

    it('a staff rate created between send and confirmation is taken at confirmation (confirmation is authoritative)', async () => {
      const role = await newRole(1600);
      const shift = await newShift(role);
      await scheduling.publish(ctxA, shift.id);
      const offer = await offers.send(ctxA, shift.id, {
        staffProfileId: worker.profileId!,
      } as never);
      expect(
        (await seatOf(shift.id, worker.profileId!)).pay_rate_snapshot_pence,
      ).toBe('1600');
      await offers.staffAccept(ctxOf(worker), offer.id);
      await rates.create(ctxA, worker.profileId!, {
        jobRoleId: role,
        payRatePence: 1950,
        effectiveFrom: day(-1),
      });
      await offers.managerConfirm(ctxA, offer.id);
      expect(
        (await seatOf(shift.id, worker.profileId!)).pay_rate_snapshot_pence,
      ).toBe('1950');
    });

    it('a later edit or delete of the staff rate never changes a confirmed snapshot; only seats confirmed afterwards see it', async () => {
      const role = await newRole(1400);
      const rate = await rates.create(ctxA, worker.profileId!, {
        jobRoleId: role,
        payRatePence: 2200,
        effectiveFrom: day(-30),
      });
      const shift = await newShift(role);
      await scheduling.publish(ctxA, shift.id);
      await sendAcceptConfirm(shift.id, worker);
      expect(
        (await seatOf(shift.id, worker.profileId!)).pay_rate_snapshot_pence,
      ).toBe('2200');

      await rates.update(ctxA, worker.profileId!, rate.id, {
        payRatePence: 2700,
      });
      expect(
        (await seatOf(shift.id, worker.profileId!)).pay_rate_snapshot_pence,
      ).toBe('2200');
      await rates.remove(ctxA, worker.profileId!, rate.id);
      expect(
        (await seatOf(shift.id, worker.profileId!)).pay_rate_snapshot_pence,
      ).toBe('2200');
      expect(await rowCount(worker.profileId!)).toBeGreaterThan(0); // other tests' rows remain; this one is gone
      expect(
        await admin.query(`SELECT 1 FROM core.staff_role_rate WHERE id = $1`, [
          rate.id,
        ]),
      ).toHaveLength(0);

      const later = await newShift(role);
      await scheduling.publish(ctxA, later.id);
      await sendAcceptConfirm(later.id, worker);
      expect(
        (await seatOf(later.id, worker.profileId!)).pay_rate_snapshot_pence,
      ).toBe('1400'); // rate deleted → default
    });

    // ------------------------------------------------------------------------------------------------ RLS (layers 4–5)

    it('ZERO ROWS WITHOUT TENANT CONTEXT: the runtime login reads nothing from core.staff_role_rate', async () => {
      const role = await newRole(1000);
      await rates.create(ctxA, plain.profileId!, {
        jobRoleId: role,
        payRatePence: 1111,
        effectiveFrom: day(-5),
      });
      expect(
        await dataSource.manager.query(`SELECT id FROM core.staff_role_rate`),
      ).toHaveLength(0);
      // The rows exist (the admin connection bypasses RLS): the zero above is RLS, not an empty table.
      expect(await rowCount(plain.profileId!)).toBeGreaterThan(0);
    });

    it('only a non-venue manager of the workspace sees rows: workspace B, another organisation, a Venue Manager and staff read and change nothing', async () => {
      const role = await newRole(1000);
      const rate = await rates.create(ctxA, plain.profileId!, {
        jobRoleId: role,
        payRatePence: 1212,
        effectiveFrom: day(-5),
      });
      const visible = (who: TestIdentity) =>
        as(
          who,
          async (m) =>
            (
              await m.query(
                `SELECT id FROM core.staff_role_rate WHERE id = $1`,
                [rate.id],
              )
            ).length,
        );
      expect(await visible(a)).toBe(1);
      for (const who of [b, other, vm, worker, plain]) {
        expect(await visible(who)).toBe(0);
        const [, updated] = await as(who, (m) =>
          m.query(
            `UPDATE core.staff_role_rate SET pay_rate_pence = 1 WHERE id = $1`,
            [rate.id],
          ),
        );
        expect(updated).toBe(0);
        const [, deleted] = await as(who, (m) =>
          m.query(`DELETE FROM core.staff_role_rate WHERE id = $1`, [rate.id]),
        );
        expect(deleted).toBe(0);
      }
      expect(
        (
          await admin.query(
            `SELECT pay_rate_pence FROM core.staff_role_rate WHERE id = $1`,
            [rate.id],
          )
        )[0].pay_rate_pence,
      ).toBe('1212');
      // A seat priced by a Venue Manager session could never see the rate either (fail closed to the shift rate).
      const seen = await as(vm, (m) =>
        resolveSeatPayRate(m, {
          shiftId: randomUUID(),
          staffProfileId: plain.profileId!,
          jobRoleId: role,
          startsAt: new Date(),
          fallbackPence: 7,
        }),
      );
      expect(seen).toEqual({ payRatePence: 7, source: 'shift' });
    });

    it('RLS WITH CHECK: a raw insert naming another author, another workspace, or by a Venue Manager / staff is refused (42501)', async () => {
      const role = await newRole(1000);
      const insert = (
        who: TestIdentity,
        row: { workspaceId?: string | null; createdBy?: string },
      ) =>
        as(who, (m) =>
          m.query(
            `INSERT INTO core.staff_role_rate (organisation_id, workspace_id, staff_profile_id, job_role_id, pay_rate_pence, effective_from, created_by)
           VALUES ($1, $2, $3, $4, 1000, $5, $6)`,
            [
              who.organisationId,
              row.workspaceId ?? who.workspaceId,
              plain.profileId,
              role,
              day(-300),
              row.createdBy ?? who.userId,
            ],
          ),
        );
      expect(await sqlState(insert(a, { createdBy: b.userId }))).toBe('42501');
      expect(await sqlState(insert(a, { workspaceId: b.workspaceId }))).toBe(
        '42501',
      );
      expect(await sqlState(insert(vm, {}))).toBe('42501');
      expect(await sqlState(insert(worker, {}))).toBe('42501');
    });

    it('created_by, the staff member and the job role can never be updated, even by the manager who wrote the row (42501)', async () => {
      const role = await newRole(1000);
      const rate = await rates.create(ctxA, plain.profileId!, {
        jobRoleId: role,
        payRatePence: 1313,
        effectiveFrom: day(-500),
        effectiveTo: day(-400),
      });
      for (const [column, value] of [
        ['created_by', b.userId],
        ['staff_profile_id', worker.profileId],
        ['job_role_id', randomUUID()],
        ['workspace_id', b.workspaceId],
      ] as const) {
        expect(
          await sqlState(
            as(a, (m) =>
              m.query(
                `UPDATE core.staff_role_rate SET ${column} = $2 WHERE id = $1`,
                [rate.id, value],
              ),
            ),
          ),
        ).toBe('42501');
      }
    });

    it('overlapping periods for one staff member and job role are refused by the database (409 through the service and HTTP); another role or staff member may overlap', async () => {
      const role = await newRole(1000);
      await rates.create(ctxA, plain.profileId!, {
        jobRoleId: role,
        payRatePence: 1400,
        effectiveFrom: day(10),
        effectiveTo: day(20),
      });
      await expect(
        rates.create(ctxA, plain.profileId!, {
          jobRoleId: role,
          payRatePence: 1500,
          effectiveFrom: day(20),
          effectiveTo: day(30),
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        rates.create(ctxA, plain.profileId!, {
          jobRoleId: role,
          payRatePence: 1500,
          effectiveFrom: day(1),
        }),
      ).rejects.toMatchObject({ status: 409 });
      const res = await http()
        .post(`/rest/v1/staff/${plain.profileId}/role-rates`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ jobRoleId: role, payRatePence: 1500, effectiveFrom: day(15) });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STAFF_ROLE_RATE_OVERLAP');
      await expect(
        rates.create(ctxA, plain.profileId!, {
          jobRoleId: role,
          payRatePence: 1500,
          effectiveFrom: day(21),
          effectiveTo: day(30),
        }),
      ).resolves.toBeDefined();
      await expect(
        rates.create(ctxA, worker.profileId!, {
          jobRoleId: role,
          payRatePence: 1500,
          effectiveFrom: day(10),
          effectiveTo: day(20),
        }),
      ).resolves.toBeDefined();
    });

    // ------------------------------------------------------------------------------------------------ service + route (layers 1–3)

    it.each([
      ['read without payroll.view', PermissionFlag.PAYROLL_VIEW, 'list'],
      ['write without staff.edit', PermissionFlag.STAFF_EDIT, 'create'],
      ['write without payroll.view', PermissionFlag.PAYROLL_VIEW, 'create'],
    ] as const)(
      '%s: 403 in the service before any read, and at the route; nothing written',
      async (_label, flag, op) => {
        const role = await newRole(1000);
        const before = await rowCount(plain.profileId!);
        await withRevoked(a, flag, async () => {
          const call =
            op === 'list'
              ? rates.list(ctxA, plain.profileId!)
              : rates.create(ctxA, plain.profileId!, {
                  jobRoleId: role,
                  payRatePence: 1,
                  effectiveFrom: day(-700),
                });
          await expect(call).rejects.toBeInstanceOf(ForbiddenException);
          // Same 403 for an unknown staff id: no existence oracle.
          await expect(
            op === 'list'
              ? rates.list(ctxA, randomUUID())
              : rates.create(ctxA, randomUUID(), {
                  jobRoleId: role,
                  payRatePence: 1,
                  effectiveFrom: day(-700),
                }),
          ).rejects.toBeInstanceOf(ForbiddenException);
          const res =
            op === 'list'
              ? await http()
                  .get(`/rest/v1/staff/${plain.profileId}/role-rates`)
                  .set('Authorization', `Bearer ${tokenA}`)
              : await http()
                  .post(`/rest/v1/staff/${plain.profileId}/role-rates`)
                  .set('Authorization', `Bearer ${tokenA}`)
                  .send({
                    jobRoleId: role,
                    payRatePence: 1,
                    effectiveFrom: day(-700),
                  });
          expect(res.status).toBe(403);
        });
        expect(await rowCount(plain.profileId!)).toBe(before);
      },
    );

    it("another workspace's manager (same organisation) and another organisation's manager get 404 for A's staff member and A's rate, nothing written", async () => {
      const role = await newRole(1000);
      const rate = await rates.create(ctxA, plain.profileId!, {
        jobRoleId: role,
        payRatePence: 1414,
        effectiveFrom: day(-800),
        effectiveTo: day(-750),
      });
      for (const who of [b, other]) {
        const ctx = ctxOf(who);
        await expect(rates.list(ctx, plain.profileId!)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await expect(
          rates.create(ctx, plain.profileId!, {
            jobRoleId: role,
            payRatePence: 1,
            effectiveFrom: day(-900),
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          rates.update(ctx, plain.profileId!, rate.id, { payRatePence: 1 }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          rates.remove(ctx, plain.profileId!, rate.id),
        ).rejects.toBeInstanceOf(NotFoundException);
        const token = await factory.login(who);
        expect(
          (
            await http()
              .get(`/rest/v1/staff/${plain.profileId}/role-rates`)
              .set('Authorization', `Bearer ${token}`)
          ).status,
        ).toBe(404);
      }
      expect(
        (
          await admin.query(
            `SELECT pay_rate_pence FROM core.staff_role_rate WHERE id = $1`,
            [rate.id],
          )
        )[0].pay_rate_pence,
      ).toBe('1414');
    });

    it("a job role of another manager (B's own role) is a 404; an archived job role is a 409", async () => {
      const bRole = (
        await scheduling.createJobRole(ctxOf(b), {
          name: `SRR B Role ${randomUUID().slice(0, 8)}`,
          defaultRatePence: 1000,
        } as never)
      ).id;
      await expect(
        rates.create(ctxA, plain.profileId!, {
          jobRoleId: bRole,
          payRatePence: 1,
          effectiveFrom: day(-950),
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      const role = await newRole(1000);
      await scheduling.archiveJobRole(ctxA, role);
      await expect(
        rates.create(ctxA, plain.profileId!, {
          jobRoleId: role,
          payRatePence: 1,
          effectiveFrom: day(-950),
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('a Venue Manager and a staff member are refused at the route', async () => {
      for (const who of [vm, worker]) {
        const token = await factory.login(who);
        const res = await http()
          .get(`/rest/v1/staff/${plain.profileId}/role-rates`)
          .set('Authorization', `Bearer ${token}`);
        expect([401, 403]).toContain(res.status);
        const write = await http()
          .post(`/rest/v1/staff/${plain.profileId}/role-rates`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            jobRoleId: randomUUID(),
            payRatePence: 1,
            effectiveFrom: day(-1),
          });
        expect([401, 403]).toContain(write.status);
      }
    });

    it('mass assignment: organisationId, workspaceId, createdBy or staffProfileId in a body is a 400 and writes nothing', async () => {
      const role = await newRole(1000);
      const before = await rowCount(plain.profileId!);
      for (const extra of [
        { organisationId: other.organisationId },
        { workspaceId: b.workspaceId },
        { createdBy: b.userId },
        { staffProfileId: worker.profileId },
      ]) {
        const res = await http()
          .post(`/rest/v1/staff/${plain.profileId}/role-rates`)
          .set('Authorization', `Bearer ${tokenA}`)
          .send({
            jobRoleId: role,
            payRatePence: 1000,
            effectiveFrom: day(-1000),
            ...extra,
          });
        expect(res.status).toBe(400);
      }
      const rate = await rates.create(ctxA, plain.profileId!, {
        jobRoleId: role,
        payRatePence: 1000,
        effectiveFrom: day(-1000),
        effectiveTo: day(-990),
      });
      const patch = await http()
        .patch(`/rest/v1/staff/${plain.profileId}/role-rates/${rate.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ payRatePence: 1100, jobRoleId: randomUUID() });
      expect(patch.status).toBe(400);
      expect(await rowCount(plain.profileId!)).toBe(before + 1);
      expect(
        (
          await admin.query(
            `SELECT pay_rate_pence, created_by FROM core.staff_role_rate WHERE id = $1`,
            [rate.id],
          )
        )[0],
      ).toEqual({ pay_rate_pence: '1000', created_by: a.userId });
    });

    it('HTTP happy path: create, list, update, delete; each write audited with no amount', async () => {
      const role = await newRole(1000);
      const created = await http()
        .post(`/rest/v1/staff/${plain.profileId}/role-rates`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          jobRoleId: role,
          payRatePence: 1777,
          effectiveFrom: day(-1100),
          effectiveTo: day(-1050),
        });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        staffProfileId: plain.profileId,
        jobRoleId: role,
        payRatePence: 1777,
        createdBy: a.userId,
      });
      expect(created.body.organisationId).toBeUndefined();
      const listed = await http()
        .get(`/rest/v1/staff/${plain.profileId}/role-rates`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(listed.status).toBe(200);
      expect(listed.body.map((r: { id: string }) => r.id)).toContain(
        created.body.id,
      );
      const patched = await http()
        .patch(
          `/rest/v1/staff/${plain.profileId}/role-rates/${created.body.id}`,
        )
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ payRatePence: 1888 });
      expect(patched.status).toBe(200);
      expect(patched.body.payRatePence).toBe(1888);
      // The rate is addressed only with its own staff member: the same id under another staff member is a 404.
      expect(
        (
          await http()
            .delete(
              `/rest/v1/staff/${worker.profileId}/role-rates/${created.body.id}`,
            )
            .set('Authorization', `Bearer ${tokenA}`)
        ).status,
      ).toBe(404);
      expect(
        (
          await http()
            .delete(
              `/rest/v1/staff/${plain.profileId}/role-rates/${created.body.id}`,
            )
            .set('Authorization', `Bearer ${tokenA}`)
        ).status,
      ).toBe(204);
      const audit = (await admin.query(
        `SELECT action, metadata FROM core.audit_log WHERE organisation_id = $1 AND entity_id = $2 ORDER BY created_at`,
        [a.organisationId, created.body.id],
      )) as Array<{ action: string; metadata: Record<string, unknown> }>;
      expect(audit.map((r) => r.action)).toEqual([
        'staff_role_rate.created',
        'staff_role_rate.updated',
        'staff_role_rate.deleted',
      ]);
      for (const row of audit)
        expect(JSON.stringify(row.metadata)).not.toMatch(/1777|1888/);
    });

    // ------------------------------------------------------------------------------------------------ orphans (no foreign key by design)

    it('orphans: a row whose staff profile does not exist is never listed or applied; a deactivated staff member cannot be offered, so their rate is never applied', async () => {
      const role = await newRole(1300);
      const ghost = randomUUID();
      await admin.query(
        `INSERT INTO core.staff_role_rate (organisation_id, workspace_id, staff_profile_id, job_role_id, pay_rate_pence, effective_from, created_by)
       VALUES ($1, $2, $3, $4, 9999, $5, $6)`,
        [a.organisationId, a.workspaceId, ghost, role, day(-30), a.userId],
      );
      await expect(rates.list(ctxA, ghost)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(
        (
          await http()
            .get(`/rest/v1/staff/${ghost}/role-rates`)
            .set('Authorization', `Bearer ${tokenA}`)
        ).status,
      ).toBe(404);
      // A real staff member's seat on the same role is unaffected by the orphan.
      const shift = await newShift(role);
      await scheduling.publish(ctxA, shift.id);
      await sendAcceptConfirm(shift.id, plain);
      expect(
        (await seatOf(shift.id, plain.profileId!)).pay_rate_snapshot_pence,
      ).toBe('1300');

      // Deactivated (the step before archive): the rate is kept, but no offer — so no seat — can be created for them.
      const leaver = await factory.createStaff(
        { id: a.organisationId },
        { owner: a, label: 'srr-leaver' },
      );
      await rates.create(ctxA, leaver.profileId!, {
        jobRoleId: role,
        payRatePence: 2500,
        effectiveFrom: day(-30),
      });
      await admin.query(
        `UPDATE ${await businessTableOf(admin, 'staff_profile', leaver.profileId)} SET employment_status = $2 WHERE id = $1`,
        [leaver.profileId, EmploymentStatus.INACTIVE],
      );
      const shift2 = await newShift(role);
      await scheduling.publish(ctxA, shift2.id);
      await expect(
        offers.send(ctxA, shift2.id, {
          staffProfileId: leaver.profileId!,
        } as never),
      ).rejects.toBeDefined();
      expect(await seatOf(shift2.id, leaver.profileId!)).toBeUndefined();
      expect(await rowCount(leaver.profileId!)).toBe(1);
    });

    // ------------------------------------------------------------------------------------------------ decisions 41 / 97 (which shifts take a staff rate)

    const shiftWith = async (
      jobRoleId: string,
      extra: Record<string, unknown> = {},
    ) => {
      const start = new Date(Date.now() + shiftDay++ * 86_400_000);
      return scheduling.create(ctxA, {
        venueId,
        jobRoleId,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 6 * 3_600_000).toISOString(),
        requiredCount: 1,
        breakMinutes: 0,
        ...extra,
      } as never);
    };
    const markerOf = async (shiftId: string) =>
      admin.query(
        `SELECT created_by FROM core.shift_resolved_rate WHERE shift_id = $1`,
        [shiftId],
      );

    it('decision 41: a rate typed on the shift wins over the staff role rate at send and at confirmation; a resolved rate takes the staff rate', async () => {
      const role = await newRole(1400);
      await rates.create(ctxA, worker.profileId!, {
        jobRoleId: role,
        payRatePence: 2300,
        effectiveFrom: day(-10),
      });
      const typed = await shiftWith(role, { payRatePence: 1777 });
      expect(await markerOf(typed.id)).toEqual([]); // a typed rate is never marked resolved
      await scheduling.publish(ctxA, typed.id);
      const offer = await offers.send(ctxA, typed.id, {
        staffProfileId: worker.profileId!,
      } as never);
      expect(
        (await seatOf(typed.id, worker.profileId!)).pay_rate_snapshot_pence,
      ).toBe('1777');
      expect(await offerEstimate(typed.id, offer.id)).toBe(
        String(payForMinutes(1777, 360)),
      );
      await offers.staffAccept(ctxOf(worker), offer.id);
      await offers.managerConfirm(ctxA, offer.id);
      expect(await seatOf(typed.id, worker.profileId!)).toEqual({
        status: 'confirmed',
        pay_rate_snapshot_pence: '1777',
      });
      // A staff rate edit afterwards changes nothing (the snapshot is never recalculated).
      const [existing] = (await rates.list(ctxA, worker.profileId!)).filter(
        (x) => x.jobRoleId === role,
      );
      await rates.update(ctxA, worker.profileId!, existing!.id, {
        payRatePence: 2900,
      });
      expect(
        (await seatOf(typed.id, worker.profileId!)).pay_rate_snapshot_pence,
      ).toBe('1777');

      const resolved = await shiftWith(role);
      expect(await markerOf(resolved.id)).toEqual([{ created_by: a.userId }]);
      await scheduling.publish(ctxA, resolved.id);
      await sendAcceptConfirm(resolved.id, worker);
      expect(
        (await seatOf(resolved.id, worker.profileId!)).pay_rate_snapshot_pence,
      ).toBe('2900');
    });

    it('decision 97: a shift created before staff rates existed (no resolved-rate marker) keeps its own rate at confirmation', async () => {
      const role = await newRole(1400);
      await rates.create(ctxA, worker.profileId!, {
        jobRoleId: role,
        payRatePence: 2600,
        effectiveFrom: day(-10),
      });
      const legacy = await shiftWith(role);
      // What a pre-migration shift looks like: no marker (the migration never back-fills one). Removed with the superuser
      // admin connection, which the parity guard lets through; no application role can do this.
      await admin.query(
        `DELETE FROM core.shift_resolved_rate WHERE shift_id = $1`,
        [legacy.id],
      );
      await scheduling.publish(ctxA, legacy.id);
      await sendAcceptConfirm(legacy.id, worker);
      expect(
        (await seatOf(legacy.id, worker.profileId!)).pay_rate_snapshot_pence,
      ).toBe('1400');
    });

    it('marker: zero rows without tenant context; only a non-venue manager of the workspace reads it; no direct writes for the runtime login', async () => {
      const shift = await shiftWith(await newRole(1400));
      expect(
        await dataSource.manager.query(
          `SELECT shift_id FROM core.shift_resolved_rate`,
        ),
      ).toHaveLength(0);
      expect((await markerOf(shift.id)).length).toBe(1);
      const visible = (who: TestIdentity) =>
        as(
          who,
          async (m) =>
            (
              await m.query(
                `SELECT 1 FROM core.shift_resolved_rate WHERE shift_id = $1`,
                [shift.id],
              )
            ).length,
        );
      expect(await visible(a)).toBe(1);
      for (const who of [b, other, vm, worker])
        expect(await visible(who)).toBe(0);
      expect(
        await sqlState(
          as(a, (m) =>
            m.query(
              `UPDATE core.shift_resolved_rate SET created_by = $2 WHERE shift_id = $1`,
              [shift.id, b.userId],
            ),
          ),
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          as(a, (m) =>
            m.query(
              `DELETE FROM core.shift_resolved_rate WHERE shift_id = $1`,
              [shift.id],
            ),
          ),
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          as(a, (m) =>
            m.query(
              `INSERT INTO core.shift_resolved_rate (shift_id, organisation_id, workspace_id, created_by) VALUES ($1, $2, $3, $4)`,
              [randomUUID(), a.organisationId, a.workspaceId, a.userId],
            ),
          ),
        ),
      ).toBe('42501');
    });

    it('marker definer: refuses a non-existent shift, a shift of another manager, a shift created in an earlier transaction, and a Venue Manager or staff caller (42501); nothing is written', async () => {
      const mark = (who: TestIdentity, shiftId: string) =>
        as(who, (m) =>
          m.query(`SELECT core.mark_shift_rate_resolved($1)`, [shiftId]),
        );
      const typed = await shiftWith(await newRole(1400), {
        payRatePence: 1500,
      }); // the shift of a, no marker
      expect(await sqlState(mark(a, randomUUID()))).toBe('42501'); // non-existent
      expect(await sqlState(mark(b, typed.id))).toBe('42501'); // another manager (another workspace)
      expect(await sqlState(mark(a, typed.id))).toBe('42501'); // own shift, but created in an earlier transaction
      expect(await sqlState(mark(vm, typed.id))).toBe('42501');
      expect(await sqlState(mark(worker, typed.id))).toBe('42501');
      expect(await markerOf(typed.id)).toEqual([]);
    });

    it('marker through the AI executor path: createDraftTx in the caller transaction marks the shift with created_by = ctx.userId = current_uid()', async () => {
      const role = await newRole(1400);
      const start = new Date(Date.now() + shiftDay++ * 86_400_000);
      const shift = await tenantContext.runInWorkspaceContext(ctxA, (m) =>
        scheduling.createDraftTx(m, ctxA, {
          venueId,
          jobRoleId: role,
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
          requiredCount: 1,
        } as never),
      );
      expect(await markerOf(shift.id)).toEqual([{ created_by: a.userId }]);
      const uid = await as(
        a,
        async (m) =>
          (await m.query(`SELECT core.current_uid()::text AS uid`))[0].uid,
      );
      expect(uid).toBe(ctxA.userId);
    });

    it('a venue of another workspace than the bound one is refused cleanly (404 before any insert), never a half-created shift', async () => {
      const bVenue = (
        await venues.create(ctxOf(b), {
          name: `SRR B Venue ${randomUUID().slice(0, 6)}`,
          type: 'hotel',
        } as never)
      ).id;
      const role = await newRole(1400);
      const start = new Date(Date.now() + shiftDay++ * 86_400_000);
      await expect(
        scheduling.create(ctxA, {
          venueId: bVenue,
          jobRoleId: role,
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
          requiredCount: 1,
        } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        await admin.query(
          `SELECT 1 FROM ${businessTable(b.workspaceId!, 'shift')} WHERE venue_id = $1`,
          [bVenue],
        ),
      ).toEqual([]);
    });

    /**
     * L1: the definer reads exactly ONE authoritative copy from core.hws_cutover_state. Each case runs in ONE admin
     * transaction that is rolled back (nothing persists): the tenant GUCs bound, the cutover state set, a shift planted in
     * that transaction (session_replication_role = replica skips the foreign keys of the planted row), then the definer.
     */
    const inCutoverState = async (
      state: 'verified' | 'started',
      plantIn: 'core' | 'workspace',
    ) => {
      const qr = admin.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await qr.query(
          `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`,
          [a.organisationId, a.workspaceId, a.userId],
        );
        await qr.query(
          `INSERT INTO core.hws_cutover_state (workspace_id, organisation_id, state, verified_at) VALUES ($1, $2, $3, CASE WHEN $3 = 'verified' THEN now() END)
           ON CONFLICT (workspace_id) DO UPDATE SET state = EXCLUDED.state, verified_at = EXCLUDED.verified_at`,
          [a.workspaceId, a.organisationId, state],
        );
        await qr.query(`SET LOCAL session_replication_role = replica`);
        const table =
          plantIn === 'core'
            ? 'core.shift'
            : businessTable(a.workspaceId!, 'shift');
        const [{ id }] = await qr.query(
          `INSERT INTO ${table} (organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by, status)
           VALUES ($1, $2, $3, $4, now() + interval '30 days', now() + interval '30 days 2 hours', 1, 1500, $5, 'draft') RETURNING id`,
          [a.organisationId, a.workspaceId, venueId, randomUUID(), a.userId],
        );
        try {
          await qr.query(`SELECT core.mark_shift_rate_resolved($1)`, [id]);
          return {
            code: undefined as string | undefined,
            marked: (
              await qr.query(
                `SELECT 1 FROM core.shift_resolved_rate WHERE shift_id = $1`,
                [id],
              )
            ).length,
          };
        } catch (error) {
          return { code: pgCode(error), marked: 0 };
        }
      } finally {
        await qr.rollbackTransaction();
        await qr.release();
      }
    };

    (hwsRuntimeOn() ? it : it.skip)(
      'L1 cut over (verified): a shift planted in the CORE copy is refused; only the workspace copy counts',
      async () => {
        expect(await inCutoverState('verified', 'core')).toEqual({
          code: '42501',
          marked: 0,
        });
        expect(await inCutoverState('verified', 'workspace')).toEqual({
          code: undefined,
          marked: 1,
        });
      },
    );

    (hwsRuntimeOn() ? it : it.skip)(
      'L1 mid-upgrade (started): refused (42501) even for a shift in the workspace copy',
      async () => {
        expect(await inCutoverState('started', 'workspace')).toEqual({
          code: '42501',
          marked: 0,
        });
      },
    );

    // ------------------------------------------------------------------------------------------------ decision 40 (org-local date)

    it('decision 40: the staff rate period is judged on the organisation-local date (23:30 UTC on D is D+1 in a UTC+1 organisation)', async () => {
      const role = await newRole(1400);
      const at = new Date(Date.now() + 70 * 86_400_000);
      at.setUTCHours(23, 30, 0, 0);
      const d = at.toISOString().slice(0, 10);
      const next = new Date(at.getTime() + 86_400_000)
        .toISOString()
        .slice(0, 10);
      await rates.create(ctxA, plain.profileId!, {
        jobRoleId: role,
        payRatePence: 2100,
        effectiveFrom: day(-10),
        effectiveTo: d,
      });
      await rates.create(ctxA, plain.profileId!, {
        jobRoleId: role,
        payRatePence: 2900,
        effectiveFrom: next,
      });
      const shift = await shiftWith(role); // a resolved rate: staff rates may apply
      const seat = () =>
        as(a, (m) =>
          resolveSeatPayRate(m, {
            shiftId: shift.id,
            staffProfileId: plain.profileId!,
            jobRoleId: role,
            startsAt: at,
            fallbackPence: 1400,
          }),
        );
      const [{ timezone: before }] = await admin.query(
        `SELECT timezone FROM core.organisation WHERE id = $1`,
        [a.organisationId],
      );
      try {
        // Africa/Lagos is UTC+1 all year (no daylight saving), so the expectation never depends on the test date.
        await admin.query(
          `UPDATE core.organisation SET timezone = 'Africa/Lagos' WHERE id = $1`,
          [a.organisationId],
        );
        expect(await seat()).toEqual({
          payRatePence: 2900,
          source: 'staff_role_rate',
        });
        await admin.query(
          `UPDATE core.organisation SET timezone = 'UTC' WHERE id = $1`,
          [a.organisationId],
        );
        expect(await seat()).toEqual({
          payRatePence: 2100,
          source: 'staff_role_rate',
        }); // inclusive end date: D still uses the rate ending on D
      } finally {
        await admin.query(
          `UPDATE core.organisation SET timezone = $2 WHERE id = $1`,
          [a.organisationId, before],
        );
      }
    });
  },
);
