/**
 * Phase A gating: `RealtimeEventService.record()` writes a `core.realtime_event` row only when REALTIME_ENABLED is true
 * (the SSE gateway serves nobody otherwise). This suite asserts the rows real producers write, i.e. the realtime-ON
 * behaviour, so it turns the flag on BEFORE ANY import (the config snapshot is taken at import time — see
 * realtime-gateway.integration.spec.ts). The flag-OFF behaviour is proven in realtime-push-gating.integration.spec.ts.
 */
process.env.REALTIME_ENABLED = 'true';

import 'reflect-metadata';
import { EmploymentStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { RealtimeEventService, RealtimeEventType } from '../../engine/core-modules/realtime/realtime-event.service';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { OfferService } from '../../modules/offer/services/offer.service';
import { applyOfferConfirmation } from '../../modules/offer/services/apply-offer-confirmation';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { AuditService } from '../../engine/core-modules/audit/audit.service';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory, TestIdentity } from './helpers/test-identities';

/**
 * Real-time outbox (Stage 1) — `core.realtime_event`
 * (`RealtimeEventOutbox1786698000000`). Real Postgres, RLS on, no mocks.
 *
 * Two kinds of proof, deliberately kept separate:
 *  - Tests under "atomicity (generic transaction-boundary proof)" prove the
 *    MECHANISM — any business mutation sharing a transaction with
 *    `RealtimeEventService.record()` gets the atomicity guarantee, by
 *    construction, because `record()` never opens its own transaction. This
 *    is proven directly against `TenantContextService.runInWorkspaceContext`
 *    (the same transaction boundary every real service already uses), not
 *    tied to any one caller's business-logic ordering.
 *  - Tests under "OfferService.sendOne() — the real Stage 1 integration
 *    point" prove the ACTUAL wiring: `OfferService`'s real, production
 *    `send`/`sendBulk` methods really do call `record()`, with the right
 *    scope and a safe payload, as part of the same transaction a real
 *    caller already gets today.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('realtime event outbox — core.realtime_event (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let realtimeEventService: RealtimeEventService;
  let offerService: OfferService;
  let auditService: AuditService;
  let notificationService: NotificationService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    realtimeEventService = moduleRef.get(RealtimeEventService);
    offerService = moduleRef.get(OfferService);
    auditService = moduleRef.get(AuditService);
    notificationService = moduleRef.get(NotificationService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  async function rowFor(eventKey: string): Promise<Record<string, unknown> | null> {
    const rows = await adminDataSource.manager.query(`SELECT * FROM core.realtime_event WHERE event_key = $1`, [eventKey]);
    return rows[0] ?? null;
  }

  async function countFor(eventKey: string): Promise<number> {
    const rows = await adminDataSource.manager.query<Array<{ count: string }>>(`SELECT count(*) FROM core.realtime_event WHERE event_key = $1`, [eventKey]);
    return Number(rows[0]!.count);
  }

  async function seedSendableShift(owner: TestIdentity): Promise<{ shiftId: string; venueId: string; jobRoleId: string }> {
    const workspaceId = owner.workspaceId ?? undefined;
    return tenantContext.runInTenantContext({ organisationId: owner.organisationId, workspaceId: owner.workspaceId, userId: owner.userId, role: '' }, async (manager) => {
      const venue = await manager.save(Venue, { organisationId: owner.organisationId, name: `Realtime Test Venue ${randomUUID().slice(0, 8)}`, createdBy: owner.userId, workspaceId });
      const jobRole = await manager.save(JobRole, { organisationId: owner.organisationId, name: `Realtime Test Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: owner.userId, workspaceId });
      const startsAt = new Date(Date.now() + 24 * 3600 * 1000);
      const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
      const shift = await manager.save(Shift, {
        organisationId: owner.organisationId,
        venueId: venue.id,
        jobRoleId: jobRole.id,
        startsAt,
        endsAt,
        defaultStartsAt: startsAt,
        defaultEndsAt: endsAt,
        breakMinutes: 0,
        requiredCount: 2,
        payRatePence: 1500,
        status: 'open',
        createdBy: owner.userId,
        workspaceId,
      });
      return { shiftId: shift.id, venueId: venue.id, jobRoleId: jobRole.id };
    });
  }

  function offerCtx(owner: TestIdentity): AuthContext {
    return { organisationId: owner.organisationId, workspaceId: owner.workspaceId, userId: owner.userId, role: '' };
  }

  /** `createStaff()`'s raw INSERT leaves `employmentStatus` at its DB default (`pending_compliance`) — `assertStaffEligibleForOffer` requires `active`, same gap `scheduling-offer-abuse-cases.integration.spec.ts` already documents and works around. */
  async function activateStaff(owner: TestIdentity, staff: TestIdentity): Promise<void> {
    await tenantContext.runInTenantContext({ organisationId: owner.organisationId, workspaceId: owner.workspaceId, userId: owner.userId, role: '' }, (m) =>
      m.update(StaffProfile, { id: staff.profileId! }, { employmentStatus: EmploymentStatus.ACTIVE }),
    );
  }

  describe('RealtimeEventService.record() — basic shape and dedup', () => {
    it('inserts a durable row with the expected fields and a safe (ids-only) payload', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rt-basic' });
      const staff = await factory.createStaff(org, { owner: manager, label: 'rt-basic-staff' });
      const key = `offer.sent:${randomUUID()}`;

      await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, (m) =>
        realtimeEventService.record(m, {
          organisationId: org.id,
          workspaceId: manager.workspaceId,
          targetUserId: staff.userId,
          eventKey: key,
          eventType: RealtimeEventType.OFFER_SENT,
          entityType: 'offer',
          entityId: randomUUID(),
          payload: { shiftId: randomUUID() },
        }),
      );

      const row = await rowFor(key);
      expect(row).not.toBeNull();
      expect(row!.status).toBe('pending');
      expect(row!.attempt_count).toBe(0);
      expect(row!.target_user_id).toBe(staff.userId);
      expect(row!.payload).toEqual(expect.objectContaining({ shiftId: expect.any(String) }));
      // Never anything resembling a secret, even accidentally.
      expect(JSON.stringify(row!.payload)).not.toMatch(/password|token|secret/i);
    });

    it('duplicate creation: a second record() with the same eventKey is a no-op — exactly one row ever exists', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rt-dup' });
      const key = `offer.sent:${randomUUID()}`;
      const params = {
        organisationId: org.id,
        workspaceId: manager.workspaceId,
        eventKey: key,
        eventType: RealtimeEventType.OFFER_SENT,
        entityType: 'offer',
        entityId: randomUUID(),
      };
      const ctx = { organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' };
      const first = await tenantContext.runInTenantContext(ctx, (m) => realtimeEventService.record(m, params));
      const second = await tenantContext.runInTenantContext(ctx, (m) => realtimeEventService.record(m, params));
      expect(first).toEqual(expect.any(String));
      expect(second).toBeNull();
      expect(await countFor(key)).toBe(1);
    });

    it('an unrecognized event type is rejected and nothing is inserted', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rt-badtype' });
      const key = `bogus.type:${randomUUID()}`;
      const ctx = { organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' };

      await expect(
        tenantContext.runInTenantContext(ctx, (m) =>
          realtimeEventService.record(m, { organisationId: org.id, workspaceId: manager.workspaceId, eventKey: key, eventType: 'bogus.type', entityType: 'offer', entityId: randomUUID() }),
        ),
      ).rejects.toThrow(/Unknown realtime event type/);
      expect(await countFor(key)).toBe(0);
    });

    it('a mismatched tenant scope (organisationId param ≠ the bound session context) is rejected by RLS, nothing committed', async () => {
      const orgA = await factory.createOrganisation();
      const orgB = await factory.createOrganisation();
      const managerA = await factory.createInternalManager(orgA, { label: 'rt-xtenA' });
      const key = `offer.sent:${randomUUID()}`;

      // Bound session context is org A, but the params claim org B — RLS's
      // WITH CHECK (organisation_id = core.current_org()) must reject this,
      // exactly like every other tenant table in this codebase.
      await expect(
        tenantContext.runInTenantContext({ organisationId: orgA.id, workspaceId: managerA.workspaceId, userId: managerA.userId, role: '' }, (m) =>
          realtimeEventService.record(m, { organisationId: orgB.id, eventKey: key, eventType: RealtimeEventType.OFFER_SENT, entityType: 'offer', entityId: randomUUID() }),
        ),
      ).rejects.toThrow();
      expect(await countFor(key)).toBe(0);
    });
  });

  describe('atomicity (generic transaction-boundary proof, independent of any one caller)', () => {
    it('record() commits once the surrounding transaction commits — not before, not separately', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rt-commit' });
      const key = `offer.sent:${randomUUID()}`;

      await tenantContext.runInWorkspaceContext({ organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, async (m) => {
        await m.save(Venue, { organisationId: org.id, name: `Atomic Venue ${randomUUID().slice(0, 6)}`, createdBy: manager.userId, workspaceId: manager.workspaceId ?? undefined });
        await realtimeEventService.record(m, { organisationId: org.id, workspaceId: manager.workspaceId, eventKey: key, eventType: RealtimeEventType.OFFER_SENT, entityType: 'offer', entityId: randomUUID() });
      });

      expect(await countFor(key)).toBe(1);
    });

    it('a later exception in the SAME transaction rolls the event back WITH the business mutation — neither exists afterward', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rt-rollback' });
      const key = `offer.sent:${randomUUID()}`;
      const venueName = `Rollback Venue ${randomUUID()}`;

      await expect(
        tenantContext.runInWorkspaceContext({ organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, async (m) => {
          await m.save(Venue, { organisationId: org.id, name: venueName, createdBy: manager.userId, workspaceId: manager.workspaceId ?? undefined });
          await realtimeEventService.record(m, { organisationId: org.id, workspaceId: manager.workspaceId, eventKey: key, eventType: RealtimeEventType.OFFER_SENT, entityType: 'offer', entityId: randomUUID() });
          throw new Error('deliberate failure after both writes');
        }),
      ).rejects.toThrow('deliberate failure after both writes');

      expect(await countFor(key)).toBe(0); // the event never existed, from any other connection's point of view
      const venueRows = await adminDataSource.manager.query(`SELECT 1 FROM venue WHERE name = $1`, [venueName]);
      expect(venueRows).toHaveLength(0); // the business mutation rolled back too — true atomicity, not independent commits
    });

    it('record() itself failing (unrecognized event type) rolls back the business mutation it was paired with', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rt-insertfail' });
      const venueName = `InsertFail Venue ${randomUUID()}`;

      await expect(
        tenantContext.runInWorkspaceContext({ organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, async (m) => {
          await m.save(Venue, { organisationId: org.id, name: venueName, createdBy: manager.userId, workspaceId: manager.workspaceId ?? undefined });
          await realtimeEventService.record(m, { organisationId: org.id, workspaceId: manager.workspaceId, eventKey: `x:${randomUUID()}`, eventType: 'not-a-real-type', entityType: 'offer', entityId: randomUUID() });
        }),
      ).rejects.toThrow(/Unknown realtime event type/);

      const venueRows = await adminDataSource.manager.query(`SELECT 1 FROM venue WHERE name = $1`, [venueName]);
      expect(venueRows).toHaveLength(0); // the mutation that was required to pair with a valid event never survives an invalid one
    });
  });

  describe('RLS tenant isolation (same policy shape as every other tenant table)', () => {
    it('org B cannot see org A\'s realtime_event row', async () => {
      const orgA = await factory.createOrganisation();
      const orgB = await factory.createOrganisation();
      const managerA = await factory.createInternalManager(orgA, { label: 'rt-isoA' });
      const managerB = await factory.createInternalManager(orgB, { label: 'rt-isoB' });
      const key = `offer.sent:${randomUUID()}`;

      await tenantContext.runInTenantContext({ organisationId: orgA.id, workspaceId: managerA.workspaceId, userId: managerA.userId, role: '' }, (m) =>
        realtimeEventService.record(m, { organisationId: orgA.id, workspaceId: managerA.workspaceId, eventKey: key, eventType: RealtimeEventType.OFFER_SENT, entityType: 'offer', entityId: randomUUID() }),
      );

      const seenFromB = await tenantContext.runInTenantContext({ organisationId: orgB.id, workspaceId: managerB.workspaceId, userId: managerB.userId, role: '' }, (m) =>
        m.query(`SELECT id FROM core.realtime_event WHERE event_key = $1`, [key]),
      );
      expect(seenFromB).toHaveLength(0);

      const seenFromA = await tenantContext.runInTenantContext({ organisationId: orgA.id, workspaceId: managerA.workspaceId, userId: managerA.userId, role: '' }, (m) =>
        m.query(`SELECT id FROM core.realtime_event WHERE event_key = $1`, [key]),
      );
      expect(seenFromA).toHaveLength(1);
    });

    it('a wrong-workspace context in the same organisation cannot see the row', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rt-wrongws' });
      const key = `offer.sent:${randomUUID()}`;
      await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, (m) =>
        realtimeEventService.record(m, { organisationId: org.id, workspaceId: manager.workspaceId, eventKey: key, eventType: RealtimeEventType.OFFER_SENT, entityType: 'offer', entityId: randomUUID() }),
      );
      const seen = await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: randomUUID(), userId: manager.userId, role: '' }, (m) =>
        m.query(`SELECT id FROM core.realtime_event WHERE event_key = $1`, [key]),
      );
      expect(seen).toHaveLength(0);
    });

    it('the restricted runtime credential (crewflow_app, the one every real request uses) cannot alter the outbox schema or disable its RLS', async () => {
      // Same assertion shape `tools/check-rls-coverage.ts` runs for every other tenant table —
      // spot-checked here directly against the new table rather than re-deriving the whole tool.
      const rlsRows = await adminDataSource.manager.query<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'core.realtime_event'::regclass`,
      );
      expect(rlsRows[0]!.relrowsecurity).toBe(true);
      expect(rlsRows[0]!.relforcerowsecurity).toBe(true);

      const grantRows = await adminDataSource.manager.query<Array<{ grantee: string; privilege_type: string }>>(
        `SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'core' AND table_name = 'realtime_event' AND grantee = 'crewflow_app'`,
      );
      const privileges = grantRows.map((r) => r.privilege_type);
      expect(privileges).not.toContain('TRUNCATE');
      expect(privileges).not.toContain('TRIGGER');
      expect(privileges).not.toContain('REFERENCES');
    });
  });

  describe('OfferService.sendOne() — the real Stage 1 integration point', () => {
    it('OfferService.send() creates exactly one realtime_event row, in the same call as the offer, addressed to the right staff user', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rt-send' });
      const staff = await factory.createStaff(org, { owner: manager, label: 'rt-send-staff' });
      await activateStaff(manager, staff);
      const { shiftId } = await seedSendableShift(manager);

      const offer = await offerService.send(offerCtx(manager), shiftId, { staffProfileId: staff.profileId! });

      const row = await rowFor(`offer.sent:${offer.id}`);
      expect(row).not.toBeNull();
      expect(row!.event_type).toBe(RealtimeEventType.OFFER_SENT);
      expect(row!.entity_type).toBe('offer');
      expect(row!.entity_id).toBe(offer.id);
      expect(row!.target_user_id).toBe(staff.userId);
      expect(row!.organisation_id).toBe(org.id);
      expect(row!.workspace_id).toBe(manager.workspaceId);
    });

    it('OfferService.sendBulk(): an ineligible recipient\'s per-item SAVEPOINT rollback creates no realtime_event for them, while the eligible recipient\'s is unaffected', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rt-bulk' });
      const eligibleStaff = await factory.createStaff(org, { owner: manager, label: 'rt-bulk-ok' });
      const ineligibleStaff = await factory.createStaff(org, { owner: manager, label: 'rt-bulk-bad' });
      await activateStaff(manager, eligibleStaff);
      const { shiftId } = await seedSendableShift(manager);

      // `ineligibleStaff` is deliberately left at its DB default
      // (`pending_compliance`) — assertStaffEligibleForOffer rejects any
      // non-ACTIVE employment status, which sendBulk's per-item SAVEPOINT
      // rolls back without aborting the batch's other recipients.

      const result = await offerService.sendBulk(offerCtx(manager), shiftId, { staffProfileIds: [ineligibleStaff.profileId!, eligibleStaff.profileId!] });

      const ok = result.results.find((r) => r.staffProfileId === eligibleStaff.profileId);
      const bad = result.results.find((r) => r.staffProfileId === ineligibleStaff.profileId);
      expect(ok?.ok).toBe(true);
      expect(bad?.ok).toBe(false);

      const okRow = await rowFor(`offer.sent:${ok!.offerId}`);
      expect(okRow).not.toBeNull();
      expect(okRow!.target_user_id).toBe(eligibleStaff.userId);

      // No offer id exists for the ineligible recipient, and no realtime_event addressed to them for this shift either.
      const badRows = await adminDataSource.manager.query(`SELECT 1 FROM core.realtime_event WHERE target_user_id = $1 AND entity_type = 'offer'`, [ineligibleStaff.userId]);
      expect(badRows).toHaveLength(0);
    });

    it('existing abuse-case behaviour is unaffected: sending for a shift the manager does not own still 404s, and inserts nothing', async () => {
      const org = await factory.createOrganisation();
      const ownerManager = await factory.createInternalManager(org, { label: 'rt-owner' });
      const otherManager = await factory.createInternalManager(org, { label: 'rt-other' });
      const staff = await factory.createStaff(org, { owner: ownerManager, label: 'rt-owner-staff' });
      const { shiftId } = await seedSendableShift(ownerManager);

      await expect(offerService.send(offerCtx(otherManager), shiftId, { staffProfileId: staff.profileId! })).rejects.toThrow();

      const rows = await adminDataSource.manager.query(`SELECT 1 FROM core.realtime_event WHERE target_user_id = $1`, [staff.userId]);
      expect(rows).toHaveLength(0);
    });

    it('Stage 4 — OfferService.staffAccept() creates exactly one offer.accepted realtime_event row, addressed to the manager who sent it', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rt-accept-mgr' });
      const staff = await factory.createStaff(org, { owner: manager, label: 'rt-accept-staff' });
      await activateStaff(manager, staff);
      const { shiftId } = await seedSendableShift(manager);
      const offer = await offerService.send(offerCtx(manager), shiftId, { staffProfileId: staff.profileId! });

      const staffCtx: AuthContext = { organisationId: org.id, workspaceId: manager.workspaceId, userId: staff.userId, role: '' };
      await offerService.staffAccept(staffCtx, offer.id);

      const row = await rowFor(`offer.accepted:${offer.id}`);
      expect(row).not.toBeNull();
      expect(row!.event_type).toBe(RealtimeEventType.OFFER_ACCEPTED);
      expect(row!.target_user_id).toBe(manager.userId); // the manager who sent it, not the staff member who accepted
      expect(row!.organisation_id).toBe(org.id);
    });

    it('Stage 5 — OfferService.managerConfirm() creates exactly one offer.confirmed realtime_event row, addressed to the staff member', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rt-confirm-mgr' });
      const staff = await factory.createStaff(org, { owner: manager, label: 'rt-confirm-staff' });
      await activateStaff(manager, staff);
      const { shiftId } = await seedSendableShift(manager);
      const offer = await offerService.send(offerCtx(manager), shiftId, { staffProfileId: staff.profileId! });

      const staffCtx: AuthContext = { organisationId: org.id, workspaceId: manager.workspaceId, userId: staff.userId, role: '' };
      await offerService.staffAccept(staffCtx, offer.id);
      await offerService.managerConfirm(offerCtx(manager), offer.id);

      const row = await rowFor(`offer.confirmed:${offer.id}`);
      expect(row).not.toBeNull();
      expect(row!.event_type).toBe(RealtimeEventType.OFFER_CONFIRMED);
      expect(row!.target_user_id).toBe(staff.userId); // staff-facing — the Flutter Confirmed/Upcoming screens' real recipient
      expect(row!.organisation_id).toBe(org.id);
    });

    it('Stage 5 — applyOfferConfirmation() via the manager-confirmation-timeout worker path produces the SAME offer.confirmed event, addressed the same way', async () => {
      // Proves the shared-function insertion point covers the worker caller too, not just the
      // real Manager's own confirm click — the whole point of extracting applyOfferConfirmation
      // once (see that file's own doc comment: three callers, one canonical core).
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rt-confirm-timeout-mgr' });
      const staff = await factory.createStaff(org, { owner: manager, label: 'rt-confirm-timeout-staff' });
      await activateStaff(manager, staff);
      const { shiftId } = await seedSendableShift(manager);
      const offer = await offerService.send(offerCtx(manager), shiftId, { staffProfileId: staff.profileId! });

      const staffCtx: AuthContext = { organisationId: org.id, workspaceId: manager.workspaceId, userId: staff.userId, role: '' };
      const accepted = await offerService.staffAccept(staffCtx, offer.id);

      await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, async (m) => {
        const assignment = await m.findOneByOrFail(ShiftAssignment, { id: accepted.shiftAssignmentId });
        return applyOfferConfirmation(m, auditService, notificationService, realtimeEventService, { organisationId: org.id, userId: '' }, accepted, assignment, null, 'manager_confirmation_timeout', null);
      });

      const row = await rowFor(`offer.confirmed:${offer.id}`);
      expect(row).not.toBeNull();
      expect(row!.event_type).toBe(RealtimeEventType.OFFER_CONFIRMED);
      expect(row!.target_user_id).toBe(staff.userId);
    });
  });
});
