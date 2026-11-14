import 'reflect-metadata';
import { OfferStatus, ShiftStatus } from '@rab/shared';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { JobOffer } from '@rab/server/modules/offer/entities/job-offer.entity';
import { claimExpiredOffer } from '@rab/server/modules/offer/services/claim-expired-offer';
import { OfferService } from '@rab/server/modules/offer/services/offer.service';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { runOfferExpiryCycle } from '../../queues/rab-offers/offer-expiry.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

/**
 * D-Q4b test preparation (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §D-Q4b). CHARACTERISATION of the database contract a
 * PROPOSED offer-expiry delayed trigger relies on. The trigger handler is PROPOSED to do exactly what the scan's
 * per-candidate body does today — `runScopedForOrg(org, workspace)` then the atomic `claimExpiredOffer` CAS
 * (`WHERE id AND status = 'pending' AND expires_at <= now()`, DB clock) — with the organisation and workspace taken
 * from an ids-only job payload. These tests pin that the CAS alone makes every trigger mistake harmless:
 *
 *   - fires early, or the offer's expires_at was moved later       → no-op, offer stays pending
 *   - offer accepted / declined / withdrawn before the trigger      → no-op
 *   - forged or wrong payload scope (other org, other workspace)    → no-op under RLS (the row is invisible)
 *   - two replicas fire the same trigger                            → exactly one expiry
 *   - the trigger is lost (Redis wipe)                              → the unchanged backstop scan expires it
 *
 * Existing coverage this builds on (not duplicated here): offer-lifecycle-correctness.integration.spec.ts F29/F30/F34
 * (accept/decline/5-way worker expiry races) and L57/L58 (wrong workspace / no tenant context cannot mutate).
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

describeIfDb('D-Q4b characterisation: the offer-expiry CAS contract a delayed trigger relies on', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let notificationService: NotificationService;
  let auditService: AuditService;
  let offerService: OfferService;
  let factory: TestIdentityFactory;

  interface Fx {
    manager: TestIdentity;
    venueId: string;
    jobRoleId: string;
  }

  const ctxOf = (i: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>): AuthContext => ({ organisationId: i.organisationId, workspaceId: i.workspaceId, userId: i.userId, role: 'manager' });
  const withManager = <T>(fx: Fx, fn: (m: EntityManager) => Promise<T>) => tenantContext.runInTenantContext({ ...ctxOf(fx.manager), role: '' }, fn);

  async function seedFx(label: string): Promise<Fx> {
    const organisation = await factory.createOrganisation(label);
    const manager = await factory.createInternalManager(organisation, { permissions: 'production', label });
    const ids = await tenantContext.runInTenantContext({ ...ctxOf(manager), role: '' }, async (m) => {
      const venue = await m.save(Venue, { organisationId: organisation.id, name: `${label} Venue`, createdBy: manager.userId, workspaceId: manager.workspaceId! });
      const jobRole = await m.save(JobRole, { organisationId: organisation.id, name: `Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: manager.userId, workspaceId: manager.workspaceId! });
      return { venueId: venue.id, jobRoleId: jobRole.id };
    });
    return { manager, ...ids };
  }

  async function sendOffer(fx: Fx, expiresAt: Date): Promise<{ offerId: string; staff: TestIdentity }> {
    const staff = await factory.createStaff({ id: fx.manager.organisationId }, { owner: fx.manager, label: 'dq4b' });
    const startsAt = new Date(Date.now() + 3 * 3600_000);
    const shift = await withManager(fx, (m) =>
      m.save(Shift, {
        organisationId: fx.manager.organisationId, venueId: fx.venueId, jobRoleId: fx.jobRoleId, startsAt, endsAt: new Date(startsAt.getTime() + 8 * 3600_000),
        breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: ShiftStatus.OPEN, createdBy: fx.manager.userId, workspaceId: fx.manager.workspaceId!,
      }),
    );
    const offer = await offerService.send(ctxOf(fx.manager), shift.id, { staffProfileId: staff.profileId! });
    await withManager(fx, (m) => m.update(JobOffer, offer.id, { expiresAt }));
    return { offerId: offer.id, staff };
  }

  const statusOf = (fx: Fx, offerId: string) => withManager(fx, async (m) => (await m.findOneByOrFail(JobOffer, { id: offerId })).status);

  /** What the PROPOSED trigger handler does with its payload {organisationId, workspaceId, offerId}. */
  const fireTrigger = (payload: { organisationId: string; workspaceId: string | null; offerId: string }) =>
    runScopedForOrg(tenantContext, payload.organisationId, payload.workspaceId, async (m) => (await claimExpiredOffer(m, payload.offerId))?.id ?? null);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    notificationService = app.get(NotificationService);
    auditService = app.get(AuditService);
    offerService = app.get(OfferService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = createTestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('a trigger that fires before expires_at (early, or the deadline was moved later) is a no-op', async () => {
    const fx = await seedFx('dq4bEarly');
    const { offerId } = await sendOffer(fx, new Date(Date.now() + 10 * 60_000));
    expect(await fireTrigger({ organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId, offerId })).toBeNull();
    expect(await statusOf(fx, offerId)).toBe(OfferStatus.PENDING);
  });

  it('a trigger after the deadline expires the offer exactly once; a second firing is a no-op', async () => {
    const fx = await seedFx('dq4bDue');
    const { offerId } = await sendOffer(fx, new Date(Date.now() - 1_000));
    const payload = { organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId, offerId };
    expect(await fireTrigger(payload)).toBe(offerId);
    expect(await fireTrigger(payload)).toBeNull();
    expect(await statusOf(fx, offerId)).toBe(OfferStatus.EXPIRED);
  });

  it('two replicas fire the same trigger concurrently: exactly one claims the expiry', async () => {
    const fx = await seedFx('dq4bRace');
    const { offerId } = await sendOffer(fx, new Date(Date.now() - 1_000));
    const payload = { organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId, offerId };
    const results = await Promise.all([fireTrigger(payload), fireTrigger(payload), fireTrigger(payload)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('an offer accepted before its deadline is never expired by a late trigger', async () => {
    const fx = await seedFx('dq4bAccepted');
    const { offerId, staff } = await sendOffer(fx, new Date(Date.now() + 60_000));
    await offerService.staffAccept({ organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId, userId: staff.userId, role: 'staff' }, offerId);
    await withManager(fx, (m) => m.query(`UPDATE job_offer SET expires_at = now() - interval '1 minute' WHERE id = $1`, [offerId]));
    expect(await fireTrigger({ organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId, offerId })).toBeNull();
    expect(await statusOf(fx, offerId)).toBe(OfferStatus.STAFF_ACCEPTED);
  });

  it('ABUSE: a payload naming another organisation (or another workspace) cannot expire the offer — RLS hides it', async () => {
    const a = await seedFx('dq4bA');
    const b = await seedFx('dq4bB');
    const { offerId } = await sendOffer(a, new Date(Date.now() - 1_000));
    // Organisation B's scope with organisation A's offer id.
    expect(await fireTrigger({ organisationId: b.manager.organisationId, workspaceId: b.manager.workspaceId, offerId })).toBeNull();
    // Organisation A with organisation B's workspace: rejected by routing or invisible under RLS — either way no expiry.
    const wrongWorkspace = await fireTrigger({ organisationId: a.manager.organisationId, workspaceId: b.manager.workspaceId, offerId }).catch(() => null);
    expect(wrongWorkspace).toBeNull();
    expect(await statusOf(a, offerId)).toBe(OfferStatus.PENDING);
    // The correct scope still works afterwards (the abuse attempts changed nothing).
    expect(await fireTrigger({ organisationId: a.manager.organisationId, workspaceId: a.manager.workspaceId, offerId })).toBe(offerId);
  });

  it('a lost trigger (no trigger at all, as after a Redis wipe) is recovered by the unchanged backstop scan', async () => {
    const fx = await seedFx('dq4bLost');
    const { offerId } = await sendOffer(fx, new Date(Date.now() - 1_000));
    await runOfferExpiryCycle(dataSource, tenantContext, notificationService, auditService);
    expect(await statusOf(fx, offerId)).toBe(OfferStatus.EXPIRED);
    const audits = await withManager(fx, (m) => m.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE entity_id::text = $1 AND action = 'offer.expired_by_worker'`, [offerId]));
    expect(audits[0].n).toBe(1);
  });

  // D-Q4b implemented: every former PROPOSED item is now a real test in dq4b-timer-triggers.integration.spec.ts —
  // after-commit producer + rollback ⇒ no job ("PRODUCER" cases), ids-only payload (PRODUCER + the registry ABUSE cases in
  // queue-registry.spec.ts), stale epoch ("EARLY and STALE"), shadow writes nothing ("SHADOW"), Redis down at producer time
  // ("REDIS DOWN") and the lost trigger ("LOST TRIGGER"), rolling deploy ("ROLLING DEPLOY"), the manager-confirmation
  // WAKE ("MANAGER-CONFIRMATION wake"), and Worker arming of no-show / late clock-in ("ARMING from shift-monitor discovery").
});
