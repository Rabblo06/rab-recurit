/**
 * Phase D-Q4b — delayed timer triggers (WORKER_TIMER_TRIGGERS=on for this suite; `off` is dq4b-timer-triggers-off).
 * Real PostgreSQL (RLS on, FORCE), real Redis/BullMQ on this suite's own Redis DB index, the real OfferService producers,
 * the real consumer handler and the scans' own per-candidate bodies. What it pins (plan §2.4 / §2.5, owner rule §14.3):
 *   - producers: after commit only (never on rollback), ids-only payload, deterministic jobId, delay to the due time;
 *   - shadow: the decision runs, nothing is written (no status, audit, notification, worker_event, realtime row);
 *   - on: the SAME outcome as the backstop scan (status, one audit row, notifications) and the scan then finds nothing;
 *   - early, stale, duplicate (two replicas) and forged-scope triggers are no-ops; a cross-tenant payload never acts;
 *   - a lost trigger (Redis wipe / publish failure) is recovered by the unchanged scan;
 *   - rolling deploy: a Worker without the trigger consumer never takes a trigger job;
 *   - no-show, late clock-in and the manager-confirmation wake act exactly once, like their scans.
 */
import './helpers/timer-triggers-on-env'; // first: the env is frozen when AppModule is imported
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OfferStatus, ShiftAssignmentStatus, ShiftStatus } from '@rab/shared';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { RealtimeEventService } from '@rab/server/engine/core-modules/realtime/realtime-event.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { TimerTriggerQueueService } from '@rab/server/engine/core-modules/timer-trigger/timer-trigger-queue.service';
import { TIMER_TRIGGER_QUEUE_NAME, TimerTriggerJobData, TimerTriggerKind, TimerTriggerOutcome } from '@rab/server/engine/worker-shared/timer-trigger.contract';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { JobOffer } from '@rab/server/modules/offer/entities/job-offer.entity';
import { OfferService } from '@rab/server/modules/offer/services/offer.service';
import { SchedulingService } from '@rab/server/modules/scheduling/services/scheduling.service';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '@rab/server/modules/scheduling/utils/tstzrange';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { createConsumerWorkers } from '../../core/scheduler/bullmq-scheduler';
import { buildHandlerRegistry } from '../../core/scheduler/processor-explorer';
import { CONSUMER_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerJobDependencies } from '../../core/scheduler/worker-dependencies';
import { runManagerConfirmationTimeoutCycle, runOfferExpiryCycle } from '../../queues/rab-offers/offer-expiry.job';
import { runLateClockInCycle } from '../../queues/rab-shifts/late-clock-in.job';
import { discoverShiftMonitorInWorkspace, runShiftMonitorCycle } from '../../queues/rab-shifts/shift-monitor.job';
import { armShiftTimerTriggers, redisTimerTriggerOutcomeRecorder } from '../../queues/rab-timer-triggers/timer-trigger-arming';
import { handleTimerTrigger, TimerTriggerHandlerDeps } from '../../queues/rab-timer-triggers/timer-trigger.handler';
import { buildTimerTriggerActions } from '../../queues/rab-timer-triggers/timer-trigger.processors';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const quietLogger = { log: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
const until = async <T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T | undefined> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
};

describeIfDb('D-Q4b delayed timer triggers (WORKER_TIMER_TRIGGERS=on, integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let admin: DataSource;
  let tenantContext: TenantContextService;
  let notificationService: NotificationService;
  let auditService: AuditService;
  let realtimeEventService: RealtimeEventService;
  let offerService: OfferService;
  let producer: TimerTriggerQueueService;
  let env: EnvironmentService;
  let factory: TestIdentityFactory;
  let redis: Redis;
  let triggers: Queue<TimerTriggerJobData>;
  const outcomes: Array<[TimerTriggerKind, TimerTriggerOutcome]> = [];

  interface Fx {
    manager: TestIdentity;
    venueId: string;
    jobRoleId: string;
  }
  const ctxOf = (i: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>, role = 'manager'): AuthContext => ({ organisationId: i.organisationId, workspaceId: i.workspaceId, userId: i.userId, role });
  const withManager = <T>(fx: Fx, fn: (m: EntityManager) => Promise<T>) => tenantContext.runInTenantContext({ ...ctxOf(fx.manager), role: '' }, fn);

  function handlerDeps(mode: 'shadow' | 'on'): TimerTriggerHandlerDeps {
    const deps = { tenantContext, notificationService, auditService, realtimeEventService, environmentService: env, runtimeDataSource: dataSource } as unknown as WorkerJobDependencies;
    return {
      mode,
      enabled: () => true,
      runScoped: (org, ws, fn) => runScopedForOrg(tenantContext, org, ws, fn),
      actions: buildTimerTriggerActions(deps),
      managerConfirmationTimeoutMinutes: env.get('MANAGER_CONFIRMATION_TIMEOUT_MINUTES'),
      lateClockInGraceMinutes: env.get('LATE_CLOCK_IN_GRACE_MINUTES'),
      recordOutcome: (k, o) => outcomes.push([k, o]),
      logger: { log: () => undefined, warn: () => undefined },
    };
  }
  /** A trigger job as the consumer receives it (the handler never trusts it: it re-reads the subject under RLS). */
  const fakeJob = (kind: TimerTriggerKind, data: TimerTriggerJobData, attemptsStarted = 1) => ({
    id: `test.${randomUUID()}`,
    name: `${kind}-trigger`,
    data,
    attemptsStarted,
    moveToDelayed: jest.fn(async () => undefined),
  });
  const fire = (kind: TimerTriggerKind, data: TimerTriggerJobData, mode: 'shadow' | 'on' = 'on') => handleTimerTrigger(fakeJob(kind, data), undefined, handlerDeps(mode));

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

  async function sendOffer(fx: Fx): Promise<{ offer: JobOffer; staff: TestIdentity }> {
    const staff = await factory.createStaff({ id: fx.manager.organisationId }, { owner: fx.manager, label: 'dq4b' });
    const startsAt = new Date(Date.now() + 3 * 3600_000);
    const shift = await withManager(fx, (m) =>
      m.save(Shift, {
        organisationId: fx.manager.organisationId, venueId: fx.venueId, jobRoleId: fx.jobRoleId, startsAt, endsAt: new Date(startsAt.getTime() + 8 * 3600_000),
        breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: ShiftStatus.OPEN, createdBy: fx.manager.userId, workspaceId: fx.manager.workspaceId!,
      }),
    );
    const offer = await offerService.send(ctxOf(fx.manager), shift.id, { staffProfileId: staff.profileId! });
    return { offer, staff };
  }

  /** Moves the offer's deadline into the past (and returns the payload a trigger armed for that deadline carries). */
  async function makeDue(fx: Fx, offerId: string): Promise<TimerTriggerJobData> {
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 2_000);
    await withManager(fx, (m) => m.update(JobOffer, offerId, { expiresAt }));
    return { organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId!, subjectId: offerId, dueAtEpochMs: expiresAt.getTime() };
  }

  const offerOf = (fx: Fx, id: string) => withManager(fx, (m) => m.findOneByOrFail(JobOffer, { id }));
  const sideEffects = async (fx: Fx, entityId: string) =>
    withManager(fx, async (m) => {
      const [a] = await m.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE entity_id::text = $1 AND action = 'offer.expired_by_worker'`, [entityId]);
      const [n] = await m.query(`SELECT count(*)::int AS n FROM core.notification WHERE related_entity_id::text = $1 AND type = 'offer_expired'`, [entityId]);
      const [r] = await m.query(`SELECT count(*)::int AS n FROM core.realtime_event WHERE event_key = $1`, [`offer.expired:${entityId}`]);
      return { audits: a.n as number, notifications: n.n as number, realtime: r.n as number };
    });
  const jobsFor = async (subjectId: string) => (await triggers.getJobs(['delayed', 'waiting', 'active', 'completed', 'failed'])).filter((j) => j?.data?.subjectId === subjectId);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    notificationService = app.get(NotificationService);
    auditService = app.get(AuditService);
    realtimeEventService = app.get(RealtimeEventService);
    offerService = app.get(OfferService);
    producer = app.get(TimerTriggerQueueService);
    env = app.get(EnvironmentService);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = createTestIdentityFactory({ app, dataSource, adminDataSource: admin, tenantContext, passwordHashing: app.get(PasswordHashingService) });
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    await redis.flushdb();
    triggers = new Queue<TimerTriggerJobData>(TIMER_TRIGGER_QUEUE_NAME, { connection: redis });
  }, 90_000);

  afterAll(async () => {
    await triggers?.obliterate({ force: true }).catch(() => undefined);
    await triggers?.close();
    await redis?.quit();
    await app?.close();
    await admin?.destroy();
  });

  it('the producer reads WORKER_TIMER_TRIGGERS=on with every kind enabled', () => {
    expect(producer.settings.mode).toBe('on');
    for (const k of ['offer-expiry', 'manager-confirmation', 'no-show', 'late-clock-in'] as const) expect(producer.enabled(k)).toBe(true);
  });

  it('PRODUCER: sending an offer adds offer-expiry.<offerId>.<expiresAtMs> AFTER commit — ids only, delayed to expires_at', async () => {
    const fx = await seedFx('dq4bProd');
    const { offer } = await sendOffer(fx);
    const job = await until(async () => (await jobsFor(offer.id))[0]);
    expect(job).toBeDefined();
    expect(job!.name).toBe('offer-expiry-trigger');
    expect(job!.id).toBe(`offer-expiry.${offer.id}.${offer.expiresAt.getTime()}`);
    expect(job!.data).toEqual({ organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId, subjectId: offer.id, dueAtEpochMs: offer.expiresAt.getTime() });
    expect(await job!.getState()).toBe('delayed');
    expect(job!.opts.delay).toBeGreaterThan(47 * 3600_000);
  });

  it('PRODUCER: a rolled-back business transaction arms nothing', async () => {
    const fx = await seedFx('dq4bRollback');
    const subjectId = randomUUID();
    await expect(
      withManager(fx, async (m) => {
        expect(producer.afterCommit(m, { kind: 'offer-expiry', organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId!, subjectId, dueAt: new Date(Date.now() + 60_000) })).toBe(true);
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    await new Promise((r) => setTimeout(r, 500));
    expect(await jobsFor(subjectId)).toEqual([]);
  });

  it('PRODUCER: staff acceptance arms manager-confirmation at staff_accepted_at + MANAGER_CONFIRMATION_TIMEOUT_MINUTES', async () => {
    const fx = await seedFx('dq4bAccept');
    const { offer, staff } = await sendOffer(fx);
    await offerService.staffAccept(ctxOf(staff, 'staff'), offer.id);
    const accepted = await offerOf(fx, offer.id);
    const due = accepted.staffAcceptedAt!.getTime() + env.get('MANAGER_CONFIRMATION_TIMEOUT_MINUTES') * 60_000;
    const job = await until(async () => (await jobsFor(offer.id)).find((j) => j.name === 'manager-confirmation-trigger'));
    expect(job?.id).toBe(`manager-confirmation.${offer.id}.${due}`);
  });

  it('SHADOW: a due trigger is counted would-act and writes NOTHING (no status, audit, notification, realtime, worker_event)', async () => {
    const fx = await seedFx('dq4bShadow');
    const { offer } = await sendOffer(fx);
    const payload = await makeDue(fx, offer.id);
    await expect(fire('offer-expiry', payload, 'shadow')).resolves.toEqual({ outcome: 'would-act' });
    expect((await offerOf(fx, offer.id)).status).toBe(OfferStatus.PENDING);
    expect(await sideEffects(fx, offer.id)).toEqual({ audits: 0, notifications: 0, realtime: 0 });
  });

  it('ON: the trigger has the SAME outcome as the backstop scan, and the scan then finds nothing more', async () => {
    const fx = await seedFx('dq4bOn');
    const viaTrigger = await sendOffer(fx);
    const viaScan = await sendOffer(fx);
    const payload = await makeDue(fx, viaTrigger.offer.id);
    await makeDue(fx, viaScan.offer.id);
    await expect(fire('offer-expiry', payload)).resolves.toEqual({ outcome: 'acted' });
    // The scan expires the other one (and must not touch the first again).
    await runOfferExpiryCycle(dataSource, tenantContext, notificationService, auditService, realtimeEventService);
    for (const id of [viaTrigger.offer.id, viaScan.offer.id]) expect((await offerOf(fx, id)).status).toBe(OfferStatus.EXPIRED);
    expect(await sideEffects(fx, viaTrigger.offer.id)).toEqual(await sideEffects(fx, viaScan.offer.id));
    expect((await sideEffects(fx, viaTrigger.offer.id)).audits).toBe(1);
    // A second firing (BullMQ retry / re-add) is a no-op.
    await expect(fire('offer-expiry', payload)).resolves.toEqual({ outcome: 'noop' });
    expect((await sideEffects(fx, viaTrigger.offer.id)).audits).toBe(1);
  });

  it('EARLY and STALE triggers are no-ops; the offer stays pending', async () => {
    const fx = await seedFx('dq4bEarlyStale');
    const { offer } = await sendOffer(fx);
    const real = { organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId!, subjectId: offer.id, dueAtEpochMs: offer.expiresAt.getTime() };
    await expect(fire('offer-expiry', real)).resolves.toEqual({ outcome: 'early' }); // 48 h early: not re-delayed
    await expect(fire('offer-expiry', { ...real, dueAtEpochMs: real.dueAtEpochMs - 3600_000 })).resolves.toEqual({ outcome: 'stale' });
    const due = await makeDue(fx, offer.id);
    await expect(fire('offer-expiry', { ...due, dueAtEpochMs: due.dueAtEpochMs + 1 })).resolves.toEqual({ outcome: 'stale' });
    expect((await offerOf(fx, offer.id)).status).toBe(OfferStatus.PENDING);
    expect(await sideEffects(fx, offer.id)).toEqual({ audits: 0, notifications: 0, realtime: 0 });
  });

  it('DUPLICATE: three replicas fire the same due trigger concurrently — exactly one expiry, one audit row', async () => {
    const fx = await seedFx('dq4bDup');
    const { offer } = await sendOffer(fx);
    const payload = await makeDue(fx, offer.id);
    const results = await Promise.all([fire('offer-expiry', payload), fire('offer-expiry', payload), fire('offer-expiry', payload)]);
    expect(results.filter((r) => r.outcome === 'acted')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'noop')).toHaveLength(2);
    expect((await sideEffects(fx, offer.id)).audits).toBe(1);
  });

  it('ABUSE (cross-tenant): a payload naming another organisation or another organisation\'s workspace never acts', async () => {
    const a = await seedFx('dq4bA');
    const b = await seedFx('dq4bB');
    const { offer } = await sendOffer(a);
    const payload = await makeDue(a, offer.id);
    await expect(fire('offer-expiry', { ...payload, organisationId: b.manager.organisationId, workspaceId: b.manager.workspaceId! })).resolves.toEqual({ outcome: 'noop' });
    const wrongWorkspace = await fire('offer-expiry', { ...payload, workspaceId: b.manager.workspaceId! }).catch(() => ({ outcome: 'refused' as const }));
    expect(['noop', 'refused']).toContain(wrongWorkspace.outcome);
    expect((await offerOf(a, offer.id)).status).toBe(OfferStatus.PENDING);
    expect(await sideEffects(a, offer.id)).toEqual({ audits: 0, notifications: 0, realtime: 0 });
    // The correct scope still works: the abuse attempts changed nothing.
    await expect(fire('offer-expiry', payload)).resolves.toEqual({ outcome: 'acted' });
  });

  it('LOST TRIGGER (Redis wipe after arming): no job is left; the unchanged backstop scan expires the offer exactly once', async () => {
    const fx = await seedFx('dq4bLost');
    const { offer } = await sendOffer(fx);
    await until(async () => (await jobsFor(offer.id))[0]);
    await redis.flushdb();
    expect(await jobsFor(offer.id)).toEqual([]);
    await makeDue(fx, offer.id);
    await runOfferExpiryCycle(dataSource, tenantContext, notificationService, auditService, realtimeEventService);
    expect((await offerOf(fx, offer.id)).status).toBe(OfferStatus.EXPIRED);
    expect((await sideEffects(fx, offer.id)).audits).toBe(1);
  });

  it('REDIS DOWN at producer time: the business transaction commits; nothing is armed; the scan is the backstop', async () => {
    const fx = await seedFx('dq4bRedisDown');
    const down = new TimerTriggerQueueService({ get: (k: string) => (k === 'REDIS_URL' ? 'redis://127.0.0.1:1' : k === 'WORKER_TIMER_TRIGGERS' ? 'on' : undefined) } as never);
    const subjectId = randomUUID();
    const started = Date.now();
    await withManager(fx, async (m) => {
      down.afterCommit(m, { kind: 'offer-expiry', organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId!, subjectId, dueAt: new Date(Date.now() + 60_000) });
      return m.query('SELECT 1');
    });
    expect(Date.now() - started).toBeLessThan(3_000); // the commit never waited for Redis
    expect(await down.publishNow({ kind: 'no-show', organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId!, subjectId, dueAt: new Date() })).toBe(false);
    await new Promise((r) => setTimeout(r, 3_500));
    await down.onModuleDestroy();
  });

  it('CANCELLED (withdrawn offer / manager rejection): the old trigger fires and does nothing — no expiry, no auto-confirm', async () => {
    const fx = await seedFx('dq4bCancelOffer');
    // offer-expiry: withdrawn after arming, then its deadline passes.
    const { offer } = await sendOffer(fx);
    await offerService.withdraw(ctxOf(fx.manager), offer.id);
    const expiry = await makeDue(fx, offer.id);
    await expect(fire('offer-expiry', expiry)).resolves.toEqual({ outcome: 'noop' });
    expect((await offerOf(fx, offer.id)).status).toBe(OfferStatus.WITHDRAWN);
    expect(await sideEffects(fx, offer.id)).toEqual({ audits: 0, notifications: 0, realtime: 0 });
    // manager-confirmation: staff accepted (trigger armed), the manager rejected it, then the deadline passes.
    const second = await sendOffer(fx);
    await offerService.staffAccept(ctxOf(second.staff, 'staff'), second.offer.id);
    await offerService.managerReject(ctxOf(fx.manager), second.offer.id, {});
    const timeout = env.get('MANAGER_CONFIRMATION_TIMEOUT_MINUTES');
    const acceptedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - (timeout + 1) * 60_000);
    await withManager(fx, (m) => m.update(JobOffer, second.offer.id, { staffAcceptedAt: acceptedAt }));
    const wake = { organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId!, subjectId: second.offer.id, dueAtEpochMs: acceptedAt.getTime() + timeout * 60_000 };
    await expect(fire('manager-confirmation', wake)).resolves.toEqual({ outcome: 'noop' });
    expect((await offerOf(fx, second.offer.id)).status).toBe(OfferStatus.MANAGER_REJECTED);
  });

  it('BULK SEND: a recipient whose SAVEPOINT rolls back does not drop the triggers of the recipients around it', async () => {
    const fx = await seedFx('dq4bBulk');
    const a = await factory.createStaff({ id: fx.manager.organisationId }, { owner: fx.manager, label: 'dq4bBulkA' });
    const b = await factory.createStaff({ id: fx.manager.organisationId }, { owner: fx.manager, label: 'dq4bBulkB' });
    const c = await factory.createStaff({ id: fx.manager.organisationId }, { owner: fx.manager, label: 'dq4bBulkC' });
    const startsAt = new Date(Date.now() + 3 * 3600_000);
    const shift = await withManager(fx, (m) =>
      m.save(Shift, {
        organisationId: fx.manager.organisationId, venueId: fx.venueId, jobRoleId: fx.jobRoleId, startsAt, endsAt: new Date(startsAt.getTime() + 8 * 3600_000),
        breakMinutes: 0, requiredCount: 3, payRatePence: 1500, status: ShiftStatus.OPEN, createdBy: fx.manager.userId, workspaceId: fx.manager.workspaceId!,
      }),
    );
    // B already holds an offer on this shift, so B fails inside its own SAVEPOINT (duplicate offer): AFTER A's trigger was
    // registered on the same transaction and BEFORE C's.
    const existing = await offerService.send(ctxOf(fx.manager), shift.id, { staffProfileId: b.profileId! });
    const result = await offerService.sendBulk(ctxOf(fx.manager), shift.id, { staffProfileIds: [a.profileId!, b.profileId!, c.profileId!] } as never);
    expect(result.results.map((r) => r.ok)).toEqual([true, false, true]);
    for (const r of result.results.filter((x) => x.ok)) {
      const offer = await offerOf(fx, r.offerId!);
      const job = await until(async () => (await jobsFor(offer.id)).find((j) => j.name === 'offer-expiry-trigger'));
      expect(job?.id).toBe(`offer-expiry.${offer.id}.${offer.expiresAt.getTime()}`);
    }
    // The failed recipient armed nothing new: its only trigger is the one from the earlier single send.
    expect((await jobsFor(existing.id)).map((j) => j.id)).toEqual([`offer-expiry.${existing.id}.${existing.expiresAt.getTime()}`]);
  });

  it('REDIS DOWN at fire time: the trigger is not delivered, the backstop scan acts; delivered after Redis returns it is a no-op', async () => {
    const fx = await seedFx('dq4bRedisFire');
    const { offer } = await sendOffer(fx);
    const payload = await makeDue(fx, offer.id);
    // The scan needs no Redis to find or act (interval mode): it expires the offer while the trigger is stuck in Redis.
    await runOfferExpiryCycle(dataSource, tenantContext, notificationService, auditService, realtimeEventService);
    expect((await offerOf(fx, offer.id)).status).toBe(OfferStatus.EXPIRED);
    // Delivered late, with the outcome counter itself failing (Redis still flapping): no-op, nothing thrown, nothing twice.
    const down = new Redis('redis://127.0.0.1:1', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
    try {
      const deps = { ...handlerDeps('on'), recordOutcome: redisTimerTriggerOutcomeRecorder(down) };
      await expect(handleTimerTrigger(fakeJob('offer-expiry', payload), undefined, deps)).resolves.toEqual({ outcome: 'noop' });
    } finally {
      down.disconnect();
    }
    expect((await sideEffects(fx, offer.id)).audits).toBe(1);
  });

  describe('real BullMQ consumers', () => {
    const workers: Worker[] = [];
    const consumerFor = (mode: 'shadow' | 'on', include = true) =>
      createConsumerWorkers(
        buildHandlerRegistry([
          {
            queue: CONSUMER_QUEUES.timerTriggers.name,
            jobName: CONSUMER_QUEUES.timerTriggers.jobName,
            source: 'test.timerTriggers',
            handler: (job: Job, token?: string) => handleTimerTrigger(job, token, handlerDeps(mode)),
          },
        ]),
        redis,
        quietLogger,
        (def) => include && def.key === 'timerTriggers',
      );
    afterEach(async () => {
      for (const w of workers.splice(0)) await w.close();
    });

    it('ROLLING DEPLOY: a Worker without the trigger consumer (pre-D-Q4b, or WORKER_TIMER_TRIGGERS=off) never takes a trigger job', async () => {
      const fx = await seedFx('dq4bRolling');
      const { offer } = await sendOffer(fx);
      const payload = await makeDue(fx, offer.id);
      const old = consumerFor('on', false);
      expect(old.size).toBe(0);
      const job = await triggers.add('offer-expiry-trigger', payload, { jobId: `offer-expiry.${offer.id}.${payload.dueAtEpochMs}` });
      await new Promise((r) => setTimeout(r, 1_500));
      expect(await job.getState()).toBe('waiting');
      expect((await offerOf(fx, offer.id)).status).toBe(OfferStatus.PENDING);
      // The new Worker takes it.
      workers.push(...consumerFor('on').values());
      await until(async () => ((await job.getState()) === 'completed' ? true : undefined));
      expect((await offerOf(fx, offer.id)).status).toBe(OfferStatus.EXPIRED);
    });

    it('MULTI-REPLICA: two consumer Workers, the same trigger delivered twice (re-add under another id) — one expiry', async () => {
      const fx = await seedFx('dq4bReplicas');
      const { offer } = await sendOffer(fx);
      const payload = await makeDue(fx, offer.id);
      workers.push(...consumerFor('on').values(), ...consumerFor('on').values());
      const jobs = await Promise.all([
        triggers.add('offer-expiry-trigger', payload, { jobId: `offer-expiry.${offer.id}.${payload.dueAtEpochMs}` }),
        triggers.add('offer-expiry-trigger', payload, { jobId: `offer-expiry.${offer.id}.${payload.dueAtEpochMs}` }), // deduplicated by BullMQ
        triggers.add('offer-expiry-trigger', payload, { jobId: `dup.${offer.id}` }),
      ]);
      expect(new Set(jobs.map((j) => j.id)).size).toBe(2);
      for (const j of jobs) await until(async () => ((await j.getState()) === 'completed' ? true : undefined));
      const values = await Promise.all(jobs.slice(1).map(async (j) => (await Job.fromId(triggers, j.id!))!.returnvalue as { outcome: string }));
      expect(values.map((v) => v.outcome).sort()).toEqual(['acted', 'noop']);
      expect((await sideEffects(fx, offer.id)).audits).toBe(1);
    });

    it('FORGED job added straight to Redis (other organisation, extra key): no-op or failed closed; nothing acts', async () => {
      const a = await seedFx('dq4bForgeA');
      const b = await seedFx('dq4bForgeB');
      const { offer } = await sendOffer(a);
      const payload = await makeDue(a, offer.id);
      workers.push(...consumerFor('on').values());
      const forgedScope = await triggers.add('offer-expiry-trigger', { ...payload, organisationId: b.manager.organisationId, workspaceId: b.manager.workspaceId! }, { jobId: `forged.${offer.id}` });
      const extraKey = await triggers.add('offer-expiry-trigger', { ...payload, role: 'admin' } as never, { jobId: `extra.${offer.id}`, attempts: 3 });
      await until(async () => ((await forgedScope.getState()) === 'completed' ? true : undefined));
      await until(async () => ((await extraKey.getState()) === 'failed' ? true : undefined));
      expect((await Job.fromId(triggers, forgedScope.id!))!.returnvalue).toEqual({ outcome: 'noop' });
      expect((await Job.fromId(triggers, extraKey.id!))!.attemptsMade).toBe(1); // UnrecoverableError: no retry
      expect((await offerOf(a, offer.id)).status).toBe(OfferStatus.PENDING);
    });

    it('POOL (D-Q4d): a burst of 20 due triggers through one concurrency-2 consumer holds at most 2 extra runtime connections', async () => {
      const fx = await seedFx('dq4bPool');
      const pool = (dataSource.driver as unknown as { master: { totalCount: number; idleCount: number; waitingCount: number } }).master;
      const busy = () => pool.totalCount - pool.idleCount;
      const baseline = busy();
      const payloads: TimerTriggerJobData[] = [];
      for (let i = 0; i < 20; i++) payloads.push(await makeDue(fx, (await sendOffer(fx)).offer.id));
      workers.push(...consumerFor('on').values());
      let peak = 0;
      let peakWaiting = 0;
      const sampler = setInterval(() => {
        peak = Math.max(peak, busy());
        peakWaiting = Math.max(peakWaiting, pool.waitingCount);
      }, 5);
      const jobs = await Promise.all(payloads.map((p) => triggers.add('offer-expiry-trigger', p, { jobId: `pool.${p.subjectId}` })));
      for (const j of jobs) await until(async () => ((await j.getState()) === 'completed' ? true : undefined));
      clearInterval(sampler);
      // Measured, reported in the PR: the consumer adds at most its concurrency (2) checked-out connections; nothing waits.
      // eslint-disable-next-line no-console
      console.log(`[dq4b-pool] baseline busy=${baseline} peak busy=${peak} peak waiting=${peakWaiting} pool max=${(dataSource.driver as unknown as { master: { options: { max: number } } }).master.options.max}`);
      expect(peak - baseline).toBeLessThanOrEqual(2);
      for (const p of payloads) expect((await offerOf(fx, p.subjectId)).status).toBe(OfferStatus.EXPIRED);
    });

    it('CRASH / RESTART: a delayed trigger outlives its consumer Worker; the restarted Worker acts once; a redelivery is a no-op', async () => {
      const fx = await seedFx('dq4bRestart');
      const { offer } = await sendOffer(fx);
      const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_000);
      await withManager(fx, (m) => m.update(JobOffer, offer.id, { expiresAt }));
      const payload = { organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId!, subjectId: offer.id, dueAtEpochMs: expiresAt.getTime() };
      const first = consumerFor('on');
      const job = await triggers.add('offer-expiry-trigger', payload, { jobId: `restart.${offer.id}`, delay: Math.max(0, expiresAt.getTime() - Date.now()) });
      // The Worker process goes away before the due time (crash / deploy): force-closed, nothing in flight.
      for (const w of first.values()) await w.close(true);
      await new Promise((r) => setTimeout(r, Math.max(0, expiresAt.getTime() - Date.now()) + 1_000));
      expect((await offerOf(fx, offer.id)).status).toBe(OfferStatus.PENDING); // nobody consumed it while down
      // Restarted Worker: the job was kept in Redis and runs once.
      workers.push(...consumerFor('on').values());
      await until(async () => ((await job.getState()) === 'completed' ? true : undefined), 30_000);
      expect((await Job.fromId(triggers, job.id!))!.returnvalue).toEqual({ outcome: 'acted' });
      expect((await offerOf(fx, offer.id)).status).toBe(OfferStatus.EXPIRED);
      // A crash AFTER the action committed but before the ack makes BullMQ deliver the job again: the redelivery is a no-op.
      const again = await triggers.add('offer-expiry-trigger', payload, { jobId: `restart-redelivered.${offer.id}` });
      await until(async () => ((await again.getState()) === 'completed' ? true : undefined));
      expect((await Job.fromId(triggers, again.id!))!.returnvalue).toEqual({ outcome: 'noop' });
      expect((await sideEffects(fx, offer.id)).audits).toBe(1);
    });

    it('EARLY by ≤ 5 min: re-delayed once to due + 1 s, then acts', async () => {
      const fx = await seedFx('dq4bRedelay');
      const { offer } = await sendOffer(fx);
      const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_000);
      await withManager(fx, (m) => m.update(JobOffer, offer.id, { expiresAt }));
      workers.push(...consumerFor('on').values());
      const job = await triggers.add('offer-expiry-trigger', { organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId!, subjectId: offer.id, dueAtEpochMs: expiresAt.getTime() }, { jobId: `early.${offer.id}` });
      await until(async () => ((await job.getState()) === 'completed' ? true : undefined), 30_000);
      expect((await Job.fromId(triggers, job.id!))!.returnvalue).toEqual({ outcome: 'acted' });
      expect((await offerOf(fx, offer.id)).status).toBe(OfferStatus.EXPIRED);
    });
  });

  describe('shift triggers (no-show, late clock-in) and the manager-confirmation wake', () => {
    async function confirmedSeat(fx: Fx, startsAt: Date): Promise<{ assignmentId: string; shiftId: string; payload: (kind: 'no-show' | 'late-clock-in', graceMin: number) => TimerTriggerJobData }> {
      const staff = await factory.createStaff({ id: fx.manager.organisationId }, { owner: fx.manager, label: 'dq4bSeat' });
      const endsAt = new Date(startsAt.getTime() + 8 * 3600_000);
      const { assignmentId, shiftId } = await withManager(fx, async (m) => {
        const shift = await m.save(Shift, {
          organisationId: fx.manager.organisationId, venueId: fx.venueId, jobRoleId: fx.jobRoleId, startsAt, endsAt, breakMinutes: 0, requiredCount: 1,
          payRatePence: 1500, status: 'confirmed', createdBy: fx.manager.userId, workspaceId: fx.manager.workspaceId!,
        });
        const a = await m.save(ShiftAssignment, {
          organisationId: fx.manager.organisationId, shiftId: shift.id, staffProfileId: staff.profileId!, status: ShiftAssignmentStatus.CONFIRMED,
          payRateSnapshotPence: 1500, assignedBy: fx.manager.userId, confirmedAt: new Date(), period: toTstzRange(startsAt, endsAt), workspaceId: fx.manager.workspaceId!,
        });
        return { assignmentId: a.id, shiftId: shift.id };
      });
      return {
        assignmentId,
        shiftId,
        payload: (_kind, graceMin) => ({ organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId!, subjectId: assignmentId, dueAtEpochMs: startsAt.getTime() + graceMin * 60_000 }),
      };
    }
    const statusOf = (fx: Fx, id: string) => withManager(fx, async (m) => (await m.findOneByOrFail(ShiftAssignment, { id })).status);
    const eventCount = (fx: Fx, key: string) => withManager(fx, async (m) => (await m.query(`SELECT count(*)::int AS n FROM core.worker_event WHERE event_key = $1 AND status = 'completed'`, [key]))[0].n as number);

    it('NO-SHOW on: flagged once (provisional), like the scan; a second firing and the scan then do nothing more', async () => {
      const fx = await seedFx('dq4bNoShow');
      const startsAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 45 * 60_000);
      const seat = await confirmedSeat(fx, startsAt);
      await expect(fire('no-show', seat.payload('no-show', 30), 'shadow')).resolves.toEqual({ outcome: 'would-act' });
      expect(await statusOf(fx, seat.assignmentId)).toBe(ShiftAssignmentStatus.CONFIRMED);
      await expect(fire('no-show', seat.payload('no-show', 30))).resolves.toEqual({ outcome: 'acted' });
      expect(await statusOf(fx, seat.assignmentId)).toBe(ShiftAssignmentStatus.NO_SHOW);
      await expect(fire('no-show', seat.payload('no-show', 30))).resolves.toEqual({ outcome: 'noop' });
      const before = await eventCount(fx, `no-show:${seat.assignmentId}`);
      await runShiftMonitorCycle(dataSource, tenantContext, notificationService, auditService, env.get('CLOCK_IN_EARLY_MINUTES'));
      expect(await eventCount(fx, `no-show:${seat.assignmentId}`)).toBe(before);
      expect(before).toBe(1);
    });

    it('NO-SHOW: a rescheduled start makes the old trigger stale; an early one is a no-op', async () => {
      const fx = await seedFx('dq4bNoShowStale');
      const startsAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 45 * 60_000);
      const seat = await confirmedSeat(fx, startsAt);
      await expect(fire('no-show', { ...seat.payload('no-show', 30), dueAtEpochMs: startsAt.getTime() - 3600_000 })).resolves.toEqual({ outcome: 'stale' });
      const future = await confirmedSeat(fx, new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000));
      await expect(fire('no-show', future.payload('no-show', 30))).resolves.toEqual({ outcome: 'early' });
      expect(await statusOf(fx, seat.assignmentId)).toBe(ShiftAssignmentStatus.CONFIRMED);
    });

    it('CANCELLED shift: its no-show and late clock-in triggers fire and do nothing (no flag, no worker_event); the scans agree', async () => {
      const fx = await seedFx('dq4bShiftCancel');
      const grace = env.get('LATE_CLOCK_IN_GRACE_MINUTES');
      const startsAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 45 * 60_000);
      const seat = await confirmedSeat(fx, startsAt);
      await app.get(SchedulingService).cancel(ctxOf(fx.manager), seat.shiftId, 'dq4b cancellation');
      await expect(fire('no-show', seat.payload('no-show', 30))).resolves.toEqual({ outcome: 'noop' });
      await expect(fire('late-clock-in', seat.payload('late-clock-in', grace))).resolves.toEqual({ outcome: 'noop' });
      expect(await statusOf(fx, seat.assignmentId)).toBe(ShiftAssignmentStatus.CONFIRMED);
      await runShiftMonitorCycle(dataSource, tenantContext, notificationService, auditService, env.get('CLOCK_IN_EARLY_MINUTES'));
      await runLateClockInCycle(dataSource, tenantContext, notificationService, auditService, grace);
      expect(await eventCount(fx, `no-show:${seat.assignmentId}`)).toBe(0);
      expect(await eventCount(fx, `late-clock-in:${seat.assignmentId}`)).toBe(0);
    });

    it('RESCHEDULED start: the next arming adds the NEW due time as a new job; the old job is stale, the new one waits for its time', async () => {
      const fx = await seedFx('dq4bResched');
      const grace = env.get('LATE_CLOCK_IN_GRACE_MINUTES');
      const oldStart = new Date(Math.floor(Date.now() / 1000) * 1000 + 4 * 60_000);
      const seat = await confirmedSeat(fx, oldStart);
      const arm = async () => {
        const discoveries = await runScopedForOrg(tenantContext, fx.manager.organisationId, fx.manager.workspaceId, async (m) => {
          await m.query('SET TRANSACTION READ ONLY');
          return discoverShiftMonitorInWorkspace(m);
        });
        await armShiftTimerTriggers(producer, discoveries.flatMap((d) => d.assignments), { nowMs: Date.now(), horizonMs: 10 * 60_000, lateClockInGraceMinutes: grace });
      };
      await arm();
      // The seat moves 3 minutes later (assignment.period is the effective start).
      const newStart = new Date(oldStart.getTime() + 3 * 60_000);
      await withManager(fx, (m) => m.update(ShiftAssignment, seat.assignmentId, { period: toTstzRange(newStart, new Date(newStart.getTime() + 8 * 3600_000)) }));
      await arm();
      const ids = (await jobsFor(seat.assignmentId)).map((j) => j.id).sort();
      expect(ids).toEqual(
        [
          `no-show.${seat.assignmentId}.${oldStart.getTime() + 30 * 60_000}`,
          `late-clock-in.${seat.assignmentId}.${oldStart.getTime() + grace * 60_000}`,
          `no-show.${seat.assignmentId}.${newStart.getTime() + 30 * 60_000}`,
          `late-clock-in.${seat.assignmentId}.${newStart.getTime() + grace * 60_000}`,
        ].sort(),
      );
      const at = (start: Date, minutes: number) => ({ ...seat.payload('no-show', 0), dueAtEpochMs: start.getTime() + minutes * 60_000 });
      await expect(fire('no-show', at(oldStart, 30))).resolves.toEqual({ outcome: 'stale' });
      await expect(fire('late-clock-in', at(oldStart, grace))).resolves.toEqual({ outcome: 'stale' });
      await expect(fire('no-show', at(newStart, 30))).resolves.toEqual({ outcome: 'early' });
      await expect(fire('late-clock-in', at(newStart, grace))).resolves.toEqual({ outcome: 'early' });
      expect(await statusOf(fx, seat.assignmentId)).toBe(ShiftAssignmentStatus.CONFIRMED);
    });

    it('LATE CLOCK-IN on: flagged once, like the scan; the scan then flags nothing more', async () => {
      const fx = await seedFx('dq4bLate');
      const grace = env.get('LATE_CLOCK_IN_GRACE_MINUTES');
      const startsAt = new Date(Math.floor(Date.now() / 1000) * 1000 - (grace + 5) * 60_000);
      const seat = await confirmedSeat(fx, startsAt);
      await expect(fire('late-clock-in', seat.payload('late-clock-in', grace))).resolves.toEqual({ outcome: 'acted' });
      expect(await eventCount(fx, `late-clock-in:${seat.assignmentId}`)).toBe(1);
      await expect(fire('late-clock-in', seat.payload('late-clock-in', grace))).resolves.toEqual({ outcome: 'noop' });
      await runLateClockInCycle(dataSource, tenantContext, notificationService, auditService, grace);
      expect(await eventCount(fx, `late-clock-in:${seat.assignmentId}`)).toBe(1);
    });

    it('ARMING from shift-monitor discovery: an assignment starting within the horizon gets no-show + late triggers (deduplicated)', async () => {
      const fx = await seedFx('dq4bArm');
      const startsAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 5 * 60_000);
      const seat = await confirmedSeat(fx, startsAt);
      const discoveries = await runScopedForOrg(tenantContext, fx.manager.organisationId, fx.manager.workspaceId, async (m) => {
        await m.query('SET TRANSACTION READ ONLY');
        return discoverShiftMonitorInWorkspace(m);
      });
      const candidates = discoveries.flatMap((d) => d.assignments);
      for (let i = 0; i < 2; i++) {
        await armShiftTimerTriggers(producer, candidates, { nowMs: Date.now(), horizonMs: 10 * 60_000, lateClockInGraceMinutes: env.get('LATE_CLOCK_IN_GRACE_MINUTES') });
      }
      const jobs = await jobsFor(seat.assignmentId);
      expect(jobs.map((j) => j.id).sort()).toEqual(
        [`late-clock-in.${seat.assignmentId}.${startsAt.getTime() + env.get('LATE_CLOCK_IN_GRACE_MINUTES') * 60_000}`, `no-show.${seat.assignmentId}.${startsAt.getTime() + 30 * 60_000}`].sort(),
      );
    });

    it('MANAGER-CONFIRMATION wake on: runs the existing due-work claim; auto-confirms once like the scan', async () => {
      const fx = await seedFx('dq4bWake');
      const { offer, staff } = await sendOffer(fx);
      await offerService.staffAccept(ctxOf(staff, 'staff'), offer.id);
      const timeout = env.get('MANAGER_CONFIRMATION_TIMEOUT_MINUTES');
      const acceptedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - (timeout + 1) * 60_000);
      await withManager(fx, (m) => m.update(JobOffer, offer.id, { staffAcceptedAt: acceptedAt }));
      const payload = { organisationId: fx.manager.organisationId, workspaceId: fx.manager.workspaceId!, subjectId: offer.id, dueAtEpochMs: acceptedAt.getTime() + timeout * 60_000 };
      await expect(fire('manager-confirmation', payload, 'shadow')).resolves.toEqual({ outcome: 'would-act' });
      expect((await offerOf(fx, offer.id)).status).toBe(OfferStatus.STAFF_ACCEPTED);
      await expect(fire('manager-confirmation', payload)).resolves.toEqual({ outcome: 'acted' });
      expect((await offerOf(fx, offer.id)).status).toBe(OfferStatus.MANAGER_CONFIRMED);
      await expect(fire('manager-confirmation', payload)).resolves.toEqual({ outcome: 'noop' });
      const again = await runManagerConfirmationTimeoutCycle(dataSource, tenantContext, notificationService, auditService, realtimeEventService, timeout);
      expect(again.confirmed).toBe(0);
    });
  });
});
