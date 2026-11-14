import './helpers/audit-events-env'; // FIRST: env is frozen when AppModule is imported (own Redis DB index, sink = stdout)
import 'reflect-metadata';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditEventQueueService } from '@rab/server/engine/core-modules/audit-events/audit-event-queue.service';
import { SHIPPED_AUDIT_ACTIONS } from '@rab/server/engine/core-modules/audit-events/security-audit-event-catalogue';
import { createSecurityAuditSink, SecurityAuditSink } from '@rab/server/engine/core-modules/audit-sink/security-audit-sink';
import { AuditAction, AuditActionType, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AUDIT_EVENT_QUEUE_NAME, AUDIT_PREAUTH_BACKLOG_LIMIT, AUDIT_PREAUTH_JOB_NAME, auditPreAuthDropsKey } from '@rab/server/engine/worker-shared/audit-event.contract';
import { bullmqWorkerOptionsOf } from '@rab/server/engine/worker-shared/queue-registry';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { createConsumerJobProcessor } from '../../core/scheduler/bullmq-scheduler';
import { CONSUMER_QUEUES } from '../../core/scheduler/queue-registry';
import { AuditEventShipOutcome, readAuditRowForShipping, shipAuditEventJob, shipPreAuthEventJob } from '../../queues/rab-audit-events/audit-event.handler';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

/**
 * Phase X Part 2, X1.1 — security audit events, Twenty's event-log style (best effort, after commit, BullMQ → sink).
 * Real PostgreSQL (FORCE RLS), real Redis + BullMQ (DB 13), the real AppModule producer (AuditService.record →
 * AuditEventQueueService, CREWFLOW_AUDIT_SINK=stdout), and a real BullMQ Worker running the real consumer handler
 * (re-read under the organisation's tenant context, real sink formatting + redaction). Only the sink's WRITE is an
 * in-memory stand-in (so the suite can read the lines, and make the sink fail on demand).
 *
 *  E1 logins: a real successful login and a real failed login (wrong password, unknown address) reach the sink, redacted.
 *  E2 every owner category (MFA, password reset, grants/revokes, roles and permissions, platform admin, payroll approval,
 *     account deletion, suspension, security configuration) reaches the sink, redacted.
 *  E3 a rolled-back transaction ships no event — a TypeORM rollback and a raw ROLLBACK TO SAVEPOINT alike.
 *  E4 a sink failure neither blocks nor rolls back the action, and the Worker's BullMQ retry delivers once the sink is back.
 *  E5 a queue (Redis) failure neither blocks nor rolls back the action.
 *  E7 owner guard: a hung or failing queue add never delays or fails a failed login; above the 10,000 backlog failed-login
 *     events are dropped and counted (process + Redis total); other event types are unaffected.
 *  E6 ABUSE (real RLS): a forged organisationId / auditLogId pair ships nothing (both cross-tenant directions, unknown id).
 */
jest.setTimeout(120_000);
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PREFIX = 'CREWFLOW_SECURITY_AUDIT ';
const SECRET = { password: `pw-${randomUUID()}`, token: `tk-${randomUUID()}`, totpSecret: `ts-${randomUUID()}`, mfaSecret: `ms-${randomUUID()}` };

interface SinkLine {
  type: string;
  severity: string;
  process: string;
  organisationId: string | null;
  actorUserId: string | null;
  detail: Record<string, unknown> & { metadata?: Record<string, unknown> };
}

describeIfDb('X1.1 security audit events: after commit, BullMQ, sink (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: DataSource;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let producerService: AuditEventQueueService;
  let factory: TestIdentityFactory;
  let owner: TestIdentity;
  let ctx: AuthContext;
  let connection: Redis;
  let queue: Queue;
  let worker: Worker;
  /** The Worker's sink lines, parsed, and the API's pre-auth sink lines. */
  const workerLines: Array<{ raw: string; event: SinkLine }> = [];
  const outcomes: Array<{ jobId: string; attemptsMade: number; outcome?: AuditEventShipOutcome; error?: string }> = [];
  let sinkDown = false;

  const capture = (into: typeof workerLines, failWhenDown: boolean): SecurityAuditSink =>
    createSecurityAuditSink(
      { mode: 'stdout', file: null, failure: 'refuse', production: false },
      {
        stdout: async (line) => {
          if (failWhenDown && sinkDown) throw Object.assign(new Error('the log shipper is gone'), { code: 'EPIPE' });
          into.push({ raw: line, event: JSON.parse(line.slice(PREFIX.length)) as SinkLine });
        },
      },
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    auditService = moduleRef.get(AuditService);
    producerService = moduleRef.get(AuditEventQueueService);
    expect(producerService.enabled).toBe(true);

    connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue(AUDIT_EVENT_QUEUE_NAME, { connection });
    await queue.obliterate({ force: true });
    const sink = capture(workerLines, true);
    const handler = async (job: Job) => {
      const run: (typeof outcomes)[number] = { jobId: String(job.id), attemptsMade: job.attemptsMade };
      outcomes.push(run);
      try {
        const { outcome } = job.name === AUDIT_PREAUTH_JOB_NAME ? await shipPreAuthEventJob(job, { sink }) : await shipAuditEventJob(job, {
          readRow: (org, id) => readAuditRowForShipping((o, fn) => runScopedForOrg(tenantContext, o, null, (m) => fn(m)), org, id),
          sink,
          processLabel: 'worker',
        });
        run.outcome = outcome;
        return { outcome };
      } catch (error) {
        run.error = (error as Error).name;
        throw error;
      }
    };
    worker = new Worker(AUDIT_EVENT_QUEUE_NAME, createConsumerJobProcessor(CONSUMER_QUEUES.auditEvents, handler, new Logger('audit-events-test')), {
      connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
      ...bullmqWorkerOptionsOf(AUDIT_EVENT_QUEUE_NAME),
    });
    worker.on('error', () => undefined);
    await worker.waitUntilReady();

    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    const org = await factory.createOrganisation('x11');
    owner = await factory.createInternalManager(org, { permissions: 'production' });
    ctx = { ...(await factory.signedInContext(owner)), workspaceId: owner.workspaceId!, role: '' };
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    await connection?.quit();
    await app?.close();
    await admin?.destroy();
  });

  // Fail closed around every case: audit_log RLS intact; with no tenant context bound the runtime login sees no row.
  async function assertNoContextZeroRows(): Promise<void> {
    const [flags] = await dataSource.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'core.audit_log'::regclass");
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await dataSource.query('SELECT id FROM core.audit_log')).toEqual([]);
  }
  beforeEach(assertNoContextZeroRows);
  afterEach(assertNoContextZeroRows);

  async function eventually<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
    const until = Date.now() + ms;
    let v = await read();
    while (!ok(v) && Date.now() < until) {
      await sleep(100);
      v = await read();
    }
    return v;
  }
  const linesWithMarker = (marker: string) => workerLines.filter((l) => l.event.detail.metadata?.marker === marker);
  const committedRows = (marker: string) =>
    admin.query<Array<{ id: string; action: string }>>(`SELECT id, action FROM core.audit_log WHERE organisation_id = $1 AND metadata->>'marker' = $2`, [ctx.organisationId, marker]);
  const record = (action: AuditActionType, marker: string) =>
    tenantContext.runInTenantContext(ctx, (m) => auditService.record(m, ctx, action, { entityType: 'user', entityId: ctx.userId, metadata: { marker, ...SECRET, email: 'alice.smith@example.com', note: 'cc bob@corp.example' } }));
  const assertRedacted = (raw: string) => {
    for (const value of Object.values(SECRET)) expect(raw).not.toContain(value);
    expect(raw).not.toContain('alice.smith@');
    expect(raw).not.toContain('bob@corp');
    expect(raw).not.toContain(owner.password);
    expect(raw).not.toContain(owner.email);
  };

  it('E1 logins: a real sign-in and real failed sign-ins (wrong password, unknown address) reach the sink, redacted', async () => {
    // The sign-in in beforeAll recorded auth.login: shipped by the Worker after its commit.
    const login = await eventually(
      () => workerLines.find((l) => l.event.type === 'auth.login' && l.event.actorUserId === owner.userId),
      (v) => v !== undefined,
    );
    expect(login!.event).toMatchObject({ severity: 'info', process: 'worker', organisationId: owner.organisationId, detail: { category: 'login', source: 'audit_log' } });
    assertRedacted(login!.raw);

    const wrong = `Wrong-${randomUUID()}`;
    expect((await factory.loginRaw(owner, { password: wrong })).status).toBe(401);
    expect((await factory.loginRaw(owner, { email: `nobody-${randomUUID()}@example.test`, password: wrong })).status).toBe(401);
    const failed = await eventually(
      () => workerLines.filter((l) => l.event.type === 'auth.login_failed'),
      (v) => v.length >= 2,
    );
    expect(failed).toHaveLength(2);
    for (const f of failed) {
      expect(f.event).toMatchObject({ severity: 'warning', process: 'api', organisationId: null, actorUserId: null, detail: { category: 'login', source: 'login_history', reason: 'invalid_credentials', provider: 'password' } });
      expect(f.event.detail.email).toMatch(/^[a-z0-9]\*\*\*@example\.test$/);
      expect(f.raw).not.toContain(wrong);
      assertRedacted(f.raw);
    }
    // Uniform: a wrong password and an unknown address produce the same event shape (only the masked address differs).
    expect(Object.keys(failed[0]!.event.detail).sort()).toEqual(Object.keys(failed[1]!.event.detail).sort());
  });

  it('E2 every owner category reaches the sink once, after commit, redacted', async () => {
    const actions: AuditActionType[] = [
      AuditAction.MFA_CHALLENGE_FAILED,
      AuditAction.MFA_DISABLED,
      AuditAction.PASSWORD_RESET_REQUESTED,
      AuditAction.PASSWORD_RESET_COMPLETED,
      AuditAction.PLATFORM_ADMIN_GRANTED,
      AuditAction.PLATFORM_ADMIN_REVOKED,
      AuditAction.ROLE_PERMISSIONS_UPDATED,
      AuditAction.MEMBER_ROLE_CHANGED,
      AuditAction.ADMIN_INSPECT_STARTED,
      AuditAction.PAYROLL_RECORD_APPROVED,
      AuditAction.USER_DELETED,
      AuditAction.ACCOUNT_SUSPENDED,
      AuditAction.ORGANISATION_SUSPENDED,
      AuditAction.ORGANISATION_AUTH_PROVIDERS_UPDATED,
    ];
    const markers = new Map<string, string>();
    for (const action of actions) {
      const marker = `e2-${randomUUID()}`;
      markers.set(action, marker);
      await record(action, marker);
    }
    // A non-security action in the same run: never shipped.
    const offerMarker = `e2-offer-${randomUUID()}`;
    await record(AuditAction.OFFER_SENT, offerMarker);

    const categories = new Set<string>();
    for (const [action, marker] of markers) {
      const [line] = await eventually(
        () => linesWithMarker(marker),
        (v) => v.length > 0,
      );
      const [row] = await committedRows(marker);
      expect(line).toBeDefined();
      expect(line!.event).toMatchObject({ type: action, severity: SHIPPED_AUDIT_ACTIONS[action]!.severity, process: 'worker', organisationId: ctx.organisationId, actorUserId: ctx.userId });
      expect(line!.event.detail).toMatchObject({ category: SHIPPED_AUDIT_ACTIONS[action]!.category, auditLogId: row!.id, entityType: 'user' });
      expect(line!.event.detail.metadata).toMatchObject({ password: '[REDACTED]', token: '[REDACTED]', totpSecret: '[REDACTED]', mfaSecret: '[REDACTED]', email: 'a***@example.com' });
      assertRedacted(line!.raw);
      categories.add(String(line!.event.detail.category));
    }
    expect([...categories].sort()).toEqual(
      ['mfa', 'password', 'access_grant', 'role_permission', 'platform_admin', 'payroll_approval', 'account_deletion', 'suspension', 'security_configuration'].sort(),
    );
    // Exactly once each (deterministic jobId), and nothing for the offer.
    await sleep(1_000);
    for (const marker of markers.values()) expect(linesWithMarker(marker)).toHaveLength(1);
    expect(linesWithMarker(offerMarker)).toEqual([]);
    expect(await committedRows(offerMarker)).toHaveLength(1);
  });

  it('E3 a rolled-back transaction ships no event (TypeORM rollback, and a raw ROLLBACK TO SAVEPOINT the publisher cannot see)', async () => {
    const counts = async () => Object.values(await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'prioritized')).reduce((a, b) => a + b, 0);
    const before = await counts();
    const marker = `e3-${randomUUID()}`;
    await expect(
      tenantContext.runInTenantContext(ctx, async (m) => {
        await auditService.record(m, ctx, AuditAction.USER_DELETED, { metadata: { marker } });
        throw new Error('the business step failed after the audit row');
      }),
    ).rejects.toThrow('the business step failed');
    await sleep(1_500);
    expect(await committedRows(marker)).toEqual([]);
    expect(await counts()).toBe(before); // nothing was even queued
    expect(linesWithMarker(marker)).toEqual([]);

    // Raw savepoint rollback (the Worker's per-candidate pattern): TypeORM does not see it, so the publish IS queued after the
    // outer commit — and the Worker's re-read finds no row and ships nothing.
    const savepointMarker = `e3-sp-${randomUUID()}`;
    const outcomesBefore = outcomes.length;
    await tenantContext.runInTenantContext(ctx, async (m) => {
      await m.query('SAVEPOINT x11_sp');
      await auditService.record(m, ctx, AuditAction.PLATFORM_ADMIN_GRANTED, { metadata: { marker: savepointMarker } });
      await m.query('ROLLBACK TO SAVEPOINT x11_sp');
    });
    const notFound = await eventually(
      () => outcomes.slice(outcomesBefore).filter((o) => o.outcome === 'not-found'),
      (v) => v.length > 0,
    );
    expect(notFound).toHaveLength(1);
    expect(await committedRows(savepointMarker)).toEqual([]);
    expect(linesWithMarker(savepointMarker)).toEqual([]);
  });

  it('E4 a sink failure neither blocks nor rolls back the action; the BullMQ retry delivers once the sink is back', async () => {
    sinkDown = true;
    const marker = `e4-${randomUUID()}`;
    const started = Date.now();
    await record(AuditAction.ACCOUNT_SUSPENDED, marker); // resolves: the action never waits for the sink
    expect(Date.now() - started).toBeLessThan(2_000);
    const [row] = await committedRows(marker);
    expect(row).toBeDefined(); // committed, not rolled back
    const jobId = `audit-event.${row!.id}`;
    // The first attempt fails on the sink (AuditSinkError, policy refuse) and is retried by BullMQ.
    const failedAttempt = await eventually(
      () => outcomes.find((o) => o.jobId === jobId && o.error === 'AuditSinkError'),
      (v) => v !== undefined,
    );
    expect(failedAttempt).toBeDefined();
    expect(linesWithMarker(marker)).toEqual([]);
    sinkDown = false;
    const [line] = await eventually(
      () => linesWithMarker(marker),
      (v) => v.length > 0,
      40_000,
    );
    expect(line!.event).toMatchObject({ type: 'user.suspended', detail: { auditLogId: row!.id, category: 'suspension' } });
    const delivered = outcomes.find((o) => o.jobId === jobId && o.outcome === 'shipped');
    expect(delivered!.attemptsMade).toBeGreaterThanOrEqual(1); // delivered on a retry, not the first attempt
    expect(await committedRows(marker)).toHaveLength(1); // the action is untouched
  });

  it('E6 ABUSE (real RLS): a forged organisationId / auditLogId pair ships nothing — cross-tenant both ways, and an unknown id', async () => {
    // A second organisation with its own committed security row (its manager's sign-in records auth.login there).
    const otherOrg = await factory.createOrganisation('x11-other');
    const otherOwner = await factory.createInternalManager(otherOrg, { permissions: 'production' });
    await factory.signedInContext(otherOwner);
    const [otherRow] = await admin.query<Array<{ id: string }>>(`SELECT id FROM core.audit_log WHERE organisation_id = $1 AND action = 'auth.login' ORDER BY created_at DESC LIMIT 1`, [otherOrg.id]);
    const ownMarker = `e6-${randomUUID()}`;
    await record(AuditAction.USER_DELETED, ownMarker);
    const [ownRow] = await committedRows(ownMarker);
    expect(otherRow).toBeDefined();
    expect(ownRow).toBeDefined();
    const linesBefore = workerLines.length;
    const forged = [
      { organisationId: otherOrg.id, auditLogId: ownRow!.id }, // the other organisation's scope, my row
      { organisationId: ctx.organisationId, auditLogId: otherRow!.id }, // my scope, the other organisation's row
      { organisationId: ctx.organisationId, auditLogId: randomUUID() }, // an id that does not exist
    ];
    for (const f of forged) await queue.add('audit-event-ship', f, { jobId: `forged.${randomUUID()}`, attempts: 1 });
    const seen = await eventually(
      () => outcomes.filter((o) => o.jobId.startsWith('forged.')),
      (v) => v.length >= forged.length && v.every((o) => o.outcome !== undefined || o.error !== undefined),
    );
    expect(seen.map((o) => o.outcome)).toEqual(['not-found', 'not-found', 'not-found']);
    // The legitimate jobs for those rows ship them under their OWN organisation only; nothing crossed tenants.
    const crossed = workerLines
      .slice(linesBefore)
      .filter((l) => (l.event.detail.auditLogId === ownRow!.id && l.event.organisationId !== ctx.organisationId) || (l.event.detail.auditLogId === otherRow!.id && l.event.organisationId !== otherOrg.id));
    expect(crossed).toEqual([]);
  });

  it('E5 a queue (Redis) failure neither blocks nor rolls back the action', async () => {
    const deps = (producerService.producer as unknown as { deps: { publish: (job: unknown) => Promise<unknown> } }).deps;
    const realPublish = deps.publish;
    deps.publish = async () => {
      throw Object.assign(new Error('Redis is unavailable'), { name: 'QueuePublishUnavailableError' });
    };
    try {
      const marker = `e5-${randomUUID()}`;
      const started = Date.now();
      await record(AuditAction.ROLE_PERMISSIONS_UPDATED, marker);
      expect(Date.now() - started).toBeLessThan(2_000);
      await sleep(1_500);
      expect(await committedRows(marker)).toHaveLength(1);
      expect(linesWithMarker(marker)).toEqual([]); // best effort: this event is lost, the row stays the record
    } finally {
      deps.publish = realPublish;
    }
  });
  it('E7 owner guard: a hung or failing queue add never delays or fails a failed login; over the 10,000 backlog failed-login events are dropped and counted', async () => {
    const producer = producerService.producer as unknown as {
      deps: { publish: (job: unknown) => Promise<unknown> };
      backlog: number | null;
      lastBacklogReadAt: number;
      preAuthInFlightCount: number;
      preAuthDropStats: { sinceProcessStart: number };
      drain(ms?: number): Promise<void>;
    };
    const realPublish = producer.deps.publish;
    const wrong = `Wrong-${randomUUID()}`;
    try {
      // (1) The add hangs: the 401 comes back while the add is still pending.
      let releaseHung!: () => void;
      producer.deps.publish = () => new Promise((resolve) => (releaseHung = () => resolve(undefined)));
      const before = producer.preAuthInFlightCount;
      const started = Date.now();
      expect((await factory.loginRaw(owner, { password: wrong })).status).toBe(401);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(producer.preAuthInFlightCount).toBe(before + 1); // the add is still pending: the response did not wait for it
      releaseHung();
      // (2) The add rejects: the same 401, nothing thrown into the login.
      producer.deps.publish = async () => {
        throw Object.assign(new Error('Redis is unavailable'), { name: 'QueuePublishUnavailableError' });
      };
      expect((await factory.loginRaw(owner, { password: wrong })).status).toBe(401);
      // (3) Backlog over the limit: the event is dropped and counted (process counter + the durable Redis total).
      producer.deps.publish = realPublish;
      const dropsKey = auditPreAuthDropsKey(process.env.NODE_ENV?.trim() || 'development');
      const totalBefore = Number((await connection.get(dropsKey)) ?? 0);
      const localBefore = producer.preAuthDropStats.sinceProcessStart;
      producer.backlog = AUDIT_PREAUTH_BACKLOG_LIMIT + 1;
      producer.lastBacklogReadAt = Date.now() + 60_000; // keep this reading for the test
      const linesBefore = workerLines.filter((l) => l.event.type === 'auth.login_failed').length;
      expect((await factory.loginRaw(owner, { password: wrong })).status).toBe(401);
      expect(producer.preAuthDropStats.sinceProcessStart).toBe(localBefore + 1);
      await producer.drain(3_000); // flushes the pending drop count (INCRBY on the dedicated key)
      expect(Number(await connection.get(dropsKey))).toBe(totalBefore + 1);
      const report = await producerService.preAuthDropReport();
      expect(report).toMatchObject({ enabled: true, total: totalBefore + 1, sinceProcessStart: localBefore + 1 });
      await sleep(1_500);
      expect(workerLines.filter((l) => l.event.type === 'auth.login_failed').length).toBe(linesBefore); // nothing shipped
      // Other event types are not dropped under the same backlog.
      const marker = `e7-${randomUUID()}`;
      await record(AuditAction.PLATFORM_ADMIN_GRANTED, marker);
      const [line] = await eventually(
        () => linesWithMarker(marker),
        (v) => v.length > 0,
      );
      expect(line!.event.type).toBe('platform_admin.granted');
    } finally {
      producer.deps.publish = realPublish;
      producer.backlog = null;
      producer.lastBacklogReadAt = -Infinity;
    }
  });
});
