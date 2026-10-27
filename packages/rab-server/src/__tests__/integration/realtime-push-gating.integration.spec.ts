/**
 * Phase A — Worker feature gating, the PRODUCER half (API/request path). Real Postgres, FORCE RLS, the restricted
 * `crewflow_app` runtime role, no mocks of the database.
 *
 * Both flags are pinned OFF here BEFORE ANY import (the config snapshot is taken at import time — see
 * realtime-gateway.integration.spec.ts), which is also their shipped default:
 *  - REALTIME_ENABLED=false ⇒ the real producers (OfferService send/accept/confirm) write ZERO `core.realtime_event`
 *    rows, and `RealtimeEventService.record()` issues no SQL at all;
 *  - PUSH_ENABLED=false ⇒ `NotificationService.notify()` writes ZERO `core.push_delivery` rows even for a user with an
 *    active registered device (the existing push-delivery suite could only cover this by code inspection);
 *  - and in BOTH cases the in-app `core.notification` rows and the offer state machine are exactly as before.
 *
 * The flag-ON behaviour is proven on the same database by constructing the two producers with an env whose flag is
 * true (everything else from the app's validated env): rows are written exactly as before. The full AppModule-wired ON
 * path stays covered by realtime-event-outbox / navigation-layout (REALTIME_ENABLED=true) and push-delivery
 * (PUSH_ENABLED=true).
 */
process.env.REALTIME_ENABLED = 'false';
process.env.PUSH_ENABLED = 'false';

import 'reflect-metadata';
import { EmploymentStatus, NotificationType, OfferStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { PushDeliveryService } from '../../engine/core-modules/push/push-delivery.service';
import { PushDeviceService } from '../../engine/core-modules/push/push-device.service';
import { RealtimeEventService, RealtimeEventType } from '../../engine/core-modules/realtime/realtime-event.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Notification } from '../../modules/notification/entities/notification.entity';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { JobOffer } from '../../modules/offer/entities/job-offer.entity';
import { OfferService } from '../../modules/offer/services/offer.service';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfDb('Phase A gating — realtime/push producers write nothing when their feature is off (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let env: EnvironmentService;
  let realtimeEventService: RealtimeEventService;
  let pushDeviceService: PushDeviceService;
  let notificationService: NotificationService;
  let offerService: OfferService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    env = moduleRef.get(EnvironmentService);
    realtimeEventService = moduleRef.get(RealtimeEventService);
    pushDeviceService = moduleRef.get(PushDeviceService);
    notificationService = moduleRef.get(NotificationService);
    offerService = moduleRef.get(OfferService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  const ctxOf = (i: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>): AuthContext => ({ organisationId: i.organisationId, workspaceId: i.workspaceId, userId: i.userId, role: '' });

  /** The app's real validated env, with exactly one flag overridden — so "ON" differs from the booted app by that flag only. */
  function envWith(overrides: Record<string, unknown>): EnvironmentService {
    return { get: (key: string) => (key in overrides ? overrides[key] : env.get(key as never)) } as unknown as EnvironmentService;
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const [row] = await adminDataSource.query<Array<{ n: number }>>(sql, params);
    return row!.n;
  }

  async function seedSendableShift(owner: TestIdentity): Promise<string> {
    const workspaceId = owner.workspaceId ?? undefined;
    return tenantContext.runInTenantContext(ctxOf(owner), async (manager) => {
      const venue = await manager.save(Venue, { organisationId: owner.organisationId, name: `Gating Venue ${randomUUID().slice(0, 8)}`, createdBy: owner.userId, workspaceId });
      const jobRole = await manager.save(JobRole, { organisationId: owner.organisationId, name: `Gating Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: owner.userId, workspaceId });
      const startsAt = new Date(Date.now() + 24 * 3600 * 1000);
      const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
      const shift = await manager.save(Shift, {
        organisationId: owner.organisationId, venueId: venue.id, jobRoleId: jobRole.id, startsAt, endsAt, defaultStartsAt: startsAt, defaultEndsAt: endsAt,
        breakMinutes: 0, requiredCount: 2, payRatePence: 1500, status: 'open', createdBy: owner.userId, workspaceId,
      });
      return shift.id;
    });
  }

  it('the booted app really has both flags off, and both outbox tables are FORCE RLS under the restricted runtime role', async () => {
    expect(env.get('REALTIME_ENABLED')).toBe(false);
    expect(env.get('PUSH_ENABLED')).toBe(false);
    const [{ current_user: role }] = await dataSource.query('SELECT current_user');
    expect(role).toBe('crewflow_app');
    const rls = await adminDataSource.query<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid IN ('core.realtime_event'::regclass, 'core.push_delivery'::regclass) ORDER BY relname`,
    );
    expect(rls).toEqual([
      { relname: 'push_delivery', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'realtime_event', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('flags OFF: the real offer send → accept → confirm flow writes no realtime_event and no push_delivery row, while offers and in-app notifications are unchanged', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'gate-offer-mgr' });
    const staff = await factory.createStaff(org, { owner: manager, label: 'gate-offer-staff' });
    await tenantContext.runInTenantContext(ctxOf(manager), (m) => m.update(StaffProfile, { id: staff.profileId! }, { employmentStatus: EmploymentStatus.ACTIVE }));
    // Both recipients have an ACTIVE registered device — with push on, every in-app notification below would fan out.
    await pushDeviceService.register(ctxOf(staff), { deviceId: `gate-staff-${randomUUID()}`, platform: 'android', pushToken: 'gate-staff-token' });
    await pushDeviceService.register(ctxOf(manager), { deviceId: `gate-mgr-${randomUUID()}`, platform: 'ios', pushToken: 'gate-mgr-token' });
    const shiftId = await seedSendableShift(manager);

    const offer = await offerService.send(ctxOf(manager), shiftId, { staffProfileId: staff.profileId! });
    await offerService.staffAccept(ctxOf(staff), offer.id);
    await offerService.managerConfirm(ctxOf(manager), offer.id);

    // The business flow itself is untouched: the offer reached its confirmed state...
    const offerRow = await tenantContext.runInTenantContext(ctxOf(manager), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
    expect(offerRow.status).toBe(OfferStatus.MANAGER_CONFIRMED);
    // ...and the in-app notifications were written for both sides, exactly as with the flags on.
    const notifications = await adminDataSource.query<Array<{ user_id: string; type: string }>>(
      `SELECT user_id, type FROM core.notification WHERE related_entity_id = $1 ORDER BY created_at`,
      [offer.id],
    );
    expect(notifications.map((n) => n.type)).toEqual(expect.arrayContaining([NotificationType.OFFER_SENT, NotificationType.OFFER_ACCEPTED, NotificationType.OFFER_CONFIRMED]));
    expect(notifications.find((n) => n.type === NotificationType.OFFER_SENT)!.user_id).toBe(staff.userId);
    expect(notifications.find((n) => n.type === NotificationType.OFFER_ACCEPTED)!.user_id).toBe(manager.userId);

    // No realtime fan-out row for any of the three producer call sites (offer.sent / offer.accepted / offer.confirmed)...
    expect(await count(`SELECT count(*)::int n FROM core.realtime_event WHERE entity_id = $1`, [offer.id])).toBe(0);
    expect(await count(`SELECT count(*)::int n FROM core.realtime_event WHERE organisation_id = $1`, [org.id])).toBe(0);
    // ...and no push delivery for any notification in this organisation, despite the active devices.
    expect(await count(`SELECT count(*)::int n FROM core.push_delivery WHERE organisation_id = $1`, [org.id])).toBe(0);
    expect(await count(`SELECT count(*)::int n FROM core.push_device WHERE organisation_id = $1 AND active`, [org.id])).toBe(2);
  });

  it('REALTIME_ENABLED=false: record() returns null and issues no SQL at all; an unknown event type is still rejected', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'gate-rt-off' });
    const key = `offer.sent:${randomUUID()}`;
    const result = await tenantContext.runInTenantContext(ctxOf(manager), async (m: EntityManager) => {
      const spy = jest.spyOn(m, 'query');
      const id = await realtimeEventService.record(m, { organisationId: org.id, workspaceId: manager.workspaceId, targetUserId: manager.userId, eventKey: key, eventType: RealtimeEventType.OFFER_SENT, entityType: 'offer', entityId: randomUUID() });
      const calls = spy.mock.calls.length;
      spy.mockRestore();
      return { id, calls };
    });
    expect(result).toEqual({ id: null, calls: 0 });
    expect(await count(`SELECT count(*)::int n FROM core.realtime_event WHERE event_key = $1`, [key])).toBe(0);
    await expect(
      tenantContext.runInTenantContext(ctxOf(manager), (m) =>
        realtimeEventService.record(m, { organisationId: org.id, eventKey: `x:${randomUUID()}`, eventType: 'bogus.type', entityType: 'offer', entityId: randomUUID() }),
      ),
    ).rejects.toThrow(/Unknown realtime event type/);
  });

  it('PUSH_ENABLED=false: notify() still writes the in-app notification but no push_delivery row, even with an active device', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'gate-push-off' });
    await pushDeviceService.register(ctxOf(manager), { deviceId: `gate-${randomUUID()}`, platform: 'ios', pushToken: 'gate-push-off-token' });
    await tenantContext.runInTenantContext(ctxOf(manager), (m) =>
      notificationService.notify(m, { organisationId: org.id, userId: manager.userId, type: NotificationType.OFFER_SENT, title: 'T', message: 'M' }),
    );
    expect(await count(`SELECT count(*)::int n FROM core.notification WHERE user_id = $1`, [manager.userId])).toBe(1);
    expect(await count(`SELECT count(*)::int n FROM core.push_delivery WHERE organisation_id = $1`, [org.id])).toBe(0);
  });

  it('flags ON (same database, FORCE RLS): the same producers write their rows exactly as before', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'gate-on' });
    const realtimeOn = new RealtimeEventService(envWith({ REALTIME_ENABLED: true }));
    const pushOn = new PushDeliveryService(envWith({ PUSH_ENABLED: true }));
    await pushDeviceService.register(ctxOf(manager), { deviceId: `gate-on-${randomUUID()}`, platform: 'android', pushToken: 'gate-on-token' });
    const key = `offer.sent:${randomUUID()}`;
    const entityId = randomUUID();

    const { eventId, deliveries, notificationId } = await tenantContext.runInTenantContext(ctxOf(manager), async (m) => {
      const id = await realtimeOn.record(m, { organisationId: org.id, workspaceId: manager.workspaceId, targetUserId: manager.userId, eventKey: key, eventType: RealtimeEventType.OFFER_SENT, entityType: 'offer', entityId });
      // Dedup is unchanged too: the same key a second time is a quiet null, never a second row.
      expect(await realtimeOn.record(m, { organisationId: org.id, workspaceId: manager.workspaceId, targetUserId: manager.userId, eventKey: key, eventType: RealtimeEventType.OFFER_SENT, entityType: 'offer', entityId })).toBeNull();
      // The same in-app row notify() writes (its own push call is the app's, i.e. off) — then the ON producer fans it out.
      const n = await m.save(m.create(Notification, { organisationId: org.id, userId: manager.userId, type: NotificationType.OFFER_SENT, title: 'T', message: 'M' }));
      const created = await pushOn.createForNotification(m, { organisationId: org.id, userId: manager.userId, notificationId: n.id });
      return { eventId: id, deliveries: created, notificationId: n.id };
    });

    expect(eventId).toEqual(expect.any(String));
    const [row] = await adminDataSource.query<Array<Record<string, unknown>>>(`SELECT * FROM core.realtime_event WHERE event_key = $1`, [key]);
    expect(row).toMatchObject({ id: eventId, organisation_id: org.id, workspace_id: manager.workspaceId, target_user_id: manager.userId, event_type: 'offer.sent', entity_id: entityId, status: 'pending' });
    expect(deliveries).toBe(1);
    const pd = await adminDataSource.query<Array<{ status: string; notification_id: string }>>(`SELECT status, notification_id FROM core.push_delivery WHERE organisation_id = $1`, [org.id]);
    expect(pd).toEqual([{ status: 'PENDING', notification_id: notificationId }]);
  });
});
