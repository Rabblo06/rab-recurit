import 'reflect-metadata';
import { OfferStatus, ShiftStatus } from '@rab/shared';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { RealtimeEventService } from '@rab/server/engine/core-modules/realtime/realtime-event.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '@rab/server/modules/identity/entities/index';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { JobOffer } from '@rab/server/modules/offer/entities/job-offer.entity';
import { OfferService } from '@rab/server/modules/offer/services/offer.service';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { runManagerConfirmationTimeoutCycle } from '../../queues/rab-offers/offer-expiry.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Replacement & standby offers (2026-10-21) vs the manager-confirmation timeout worker. Real Postgres, RLS on, no mocks.
 *  - A STANDBY acceptance is never system-confirmed (no pointer is scheduled, and a stray/legacy pointer is ignored).
 *  - A REPLACEMENT acceptance keeps the existing timeout rule and goes through the same seat claim; re-running the cycle
 *    (retry / second replica) never confirms twice, never claims a second seat, never audits twice.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

const TIMEOUT_MINUTES = 1;
const MIN = 60_000;
const HOUR = 60 * MIN;

describeIfDb('replacement & standby offers vs manager-confirmation timeout (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let notificationService: NotificationService;
  let realtimeEventService: RealtimeEventService;
  let offerService: OfferService;
  let factory: TestIdentityFactory;

  const ctxOf = (identity: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>, role = 'manager'): AuthContext => ({
    organisationId: identity.organisationId,
    workspaceId: identity.workspaceId,
    userId: identity.userId,
    role,
  });

  async function withContext<T>(ctx: { organisationId?: string | null; workspaceId?: string | null; userId: string }, fn: (m: DataSource['manager']) => Promise<T>): Promise<T> {
    return dataSource.transaction(async (m) => {
      await m.query(`SELECT set_config('search_path', 'core', true)`);
      await m.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ctx.organisationId ?? '']);
      await m.query(`SELECT set_config('rab.workspace_id', $1, true)`, [ctx.workspaceId ?? '']);
      await m.query(`SELECT set_config('rab.user_id', $1, true)`, [ctx.userId]);
      await m.query(`SELECT set_config('rab.role', '', true)`);
      return fn(m);
    });
  }

  const runCycle = () => runManagerConfirmationTimeoutCycle(adminDataSource, tenantContext, notificationService, auditService, realtimeEventService, TIMEOUT_MINUTES);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    auditService = app.get(AuditService);
    notificationService = app.get(NotificationService);
    realtimeEventService = app.get(RealtimeEventService);
    offerService = app.get(OfferService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  /** One booked seat on a shift that started an hour ago; the booked staff member is a provisional or confirmed no-show. */
  async function seed(label: string, noShow: 'provisional' | 'confirmed') {
    const organisation: Organisation = await factory.createOrganisation(label);
    const manager = await factory.createInternalManager(organisation, { permissions: 'production' });
    const mctx = ctxOf(manager);
    const { venueId, jobRoleId } = await withContext(mctx, async (m) => {
      const venue = await m.save(Venue, { organisationId: organisation.id, name: `${label} Venue`, createdBy: manager.userId, workspaceId: manager.workspaceId! });
      const role = await m.save(JobRole, { organisationId: organisation.id, name: `Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: manager.userId, workspaceId: manager.workspaceId! });
      return { venueId: venue.id, jobRoleId: role.id };
    });
    const startsAt = new Date(Date.now() + 3 * HOUR);
    const shift = await withContext(mctx, (m) => m.save(Shift, {
      organisationId: organisation.id, venueId, jobRoleId, startsAt, endsAt: new Date(startsAt.getTime() + 8 * HOUR), breakMinutes: 0,
      requiredCount: 1, payRatePence: 1500, status: ShiftStatus.OPEN, createdBy: manager.userId, workspaceId: manager.workspaceId!,
    }));
    const booked = await factory.createStaff(organisation, { owner: manager, label: 'booked' });
    const offer = await offerService.send(mctx, shift.id, { staffProfileId: booked.profileId! });
    await offerService.staffAccept(ctxOf(booked, 'staff'), offer.id);
    await offerService.managerConfirm(mctx, offer.id);
    const realStart = new Date(Date.now() - HOUR);
    const realEnd = new Date(realStart.getTime() + 8 * HOUR);
    await withContext(mctx, async (m) => {
      await m.query(`UPDATE shift SET starts_at = $2, ends_at = $3, default_starts_at = $2, default_ends_at = $3 WHERE id = $1`, [shift.id, realStart, realEnd]);
      await m.query(`UPDATE shift_assignment SET period = tstzrange($2, $3, '[)'), status = 'no_show' WHERE shift_id = $1`, [shift.id, realStart, realEnd]);
      if (noShow === 'confirmed') await m.query(`UPDATE shift_assignment SET attendance_reviewed_at = now(), attendance_reviewed_by = $2 WHERE shift_id = $1`, [shift.id, manager.userId]);
    });
    const candidate = await factory.createStaff(organisation, { owner: manager, label: 'cand' });
    const sent = await offerService.sendReplacementBulk(mctx, shift.id, { staffProfileIds: [candidate.profileId!], mode: 'replacement' });
    expect(sent.results[0]!.ok).toBe(true);
    const replacementOfferId = sent.results[0]!.offerId!;
    const accepted = await offerService.staffAccept(ctxOf(candidate, 'staff'), replacementOfferId);
    expect(accepted.status).toBe(OfferStatus.STAFF_ACCEPTED);
    // Land the acceptance past the timeout deadline (the only thing under test is the worker's decision).
    await withContext(mctx, (m) => m.query(`UPDATE job_offer SET staff_accepted_at = now() - interval '5 minutes' WHERE id = $1`, [replacementOfferId]));
    return { organisation, manager, mctx, shift, offerKind: sent.offerKind, replacementOfferId };
  }

  const read = (fx: { mctx: AuthContext }, sql: string, params: unknown[]) => withContext(fx.mctx, (m) => m.query(sql, params));

  it('W1: a STANDBY acceptance gets no timeout pointer, and even a stray pointer never confirms it', async () => {
    const fx = await seed('stbyT', 'provisional');
    expect(fx.offerKind).toBe('standby');
    expect(await adminDataSource.query(`SELECT 1 FROM core.worker_due_work WHERE subject_id = $1`, [fx.replacementOfferId])).toHaveLength(0);
    // A stray/legacy pointer (e.g. scheduled before this change) is ignored by the worker's own guard.
    await adminDataSource.query(
      `INSERT INTO core.worker_due_work (organisation_id, workspace_id, job_type, subject_type, subject_id, due_at)
       VALUES ($1, $2, 'manager_confirmation_timeout', 'job_offer', $3, now() - interval '1 minute')`,
      [fx.organisation.id, fx.manager.workspaceId, fx.replacementOfferId],
    );
    await runCycle();
    await runCycle();
    const offer = await withContext(fx.mctx, (m) => m.findOneByOrFail(JobOffer, { id: fx.replacementOfferId }));
    expect(offer.status).toBe(OfferStatus.STAFF_ACCEPTED);
    expect(await read(fx, `SELECT 1 FROM audit_log WHERE action = 'offer.confirmed' AND entity_id = $1`, [fx.replacementOfferId])).toHaveLength(0);
    const [shift] = await read(fx, `SELECT filled_count FROM shift WHERE id = $1`, [fx.shift.id]);
    expect(Number(shift.filled_count)).toBe(1);
  });

  it('W2: a REPLACEMENT acceptance follows the existing timeout rule exactly once — retries never duplicate the booking, seat or audit', async () => {
    const fx = await seed('replT', 'confirmed');
    expect(fx.offerKind).toBe('replacement');
    await Promise.all([runCycle(), runCycle()]);
    await runCycle();
    const offer = await withContext(fx.mctx, (m) => m.findOneByOrFail(JobOffer, { id: fx.replacementOfferId }));
    expect(offer.status).toBe(OfferStatus.MANAGER_CONFIRMED);
    expect(offer.confirmedBy).toBeFalsy();
    expect(await read(fx, `SELECT 1 FROM audit_log WHERE action = 'offer.confirmed' AND entity_id = $1`, [fx.replacementOfferId])).toHaveLength(1);
    const seats = await read(fx, `SELECT status, attendance_reviewed_at IS NOT NULL AS reviewed FROM shift_assignment WHERE shift_id = $1 ORDER BY created_at`, [fx.shift.id]);
    expect(seats).toEqual([{ status: 'no_show', reviewed: true }, { status: 'confirmed', reviewed: false }]);
    const [shift] = await read(fx, `SELECT filled_count, required_count FROM shift WHERE id = $1`, [fx.shift.id]);
    expect(Number(shift.filled_count)).toBe(1);
    expect(Number(shift.required_count)).toBe(1);
    expect(await read(fx, `SELECT 1 FROM notification WHERE related_entity_id = $1 AND type = 'offer_confirmed'`, [fx.replacementOfferId])).toHaveLength(1);
  });
});
