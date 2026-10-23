import './helpers/email-reliability-env'; // FIRST: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { EmailSendResult } from '@rab/server/engine/core-modules/email/drivers/interfaces/email-driver.interface';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { Organisation } from '@rab/server/modules/identity/entities/index';
import { EmailOutboxJobType, EmailOutboxStatus } from '@rab/shared';
import { runEmailDispatchCycle } from '../../queues/rab-email/email-dispatch.job';
import { createEmailSendProcessor } from '../../queues/rab-email/email-send.processor';
import {
  assertOutboxRetentionConfig,
  OUTBOX_RETENTION_LOCK,
  OutboxRetentionConfig,
  runOutboxRetentionCycle,
} from '../../queues/rab-maintenance/outbox-retention.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { cancelLeftoverClaimableEmails } from './helpers/email-leftovers';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Wave 5 lane OPS (G6) — terminal outbox retention (DB5's core.purge_terminal_* functions, contract §5) and the audited
 * FAILED-email replay (core.replay_failed_email). Real PostgreSQL with RLS on: every product call runs as crewflow_app
 * through TenantContextService; fixtures that need old timestamps are written by the superuser admin connection.
 */
jest.setTimeout(120_000);

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describeIfDb('outbox retention + FAILED email replay (G6)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let org: Organisation;
  let owner: TestIdentity;
  let admin: TestIdentity;
  let ctx: AuthContext;

  const config = (over: Partial<OutboxRetentionConfig> = {}): OutboxRetentionConfig => ({
    enabled: true,
    mode: 'purge',
    days: { email_outbox: 90, push_delivery: 30, realtime_event: 7, worker_event: 30 },
    batchSize: 1000,
    maxBatchesPerScope: 20,
    ...over,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    auditService = moduleRef.get(AuditService);
    await cancelLeftoverClaimableEmails(dataSource, tenantContext);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    const factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    org = await factory.createOrganisation('g6');
    owner = await factory.createInternalManager(org);
    admin = await factory.createInternalManager(org, { platformAdmin: true });
    ctx = { organisationId: org.id, workspaceId: owner.workspaceId!, userId: owner.userId, role: '' };
  });

  afterAll(async () => {
    // Self-cleaning: the fake push devices carry a deliberately undecryptable RAB2 envelope (kid "x"). Left behind, they
    // would show up as UNREADABLE to any later suite that scans every encrypted value (secret:rotate verify/retire gate).
    // ON DELETE CASCADE removes their push_delivery rows with them.
    if (adminDataSource?.isInitialized && org?.id) {
      await adminDataSource
        .query(`DELETE FROM core.push_device WHERE organisation_id = $1 AND device_id LIKE 'g6-%'`, [org.id])
        .catch(() => undefined);
    }
    await adminDataSource?.destroy();
    await app?.close();
  });

  // ------------------------------------------------------------------------------------------- fixtures (superuser)

  async function email(status: string, terminalDaysAgo: number | null, extra: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const t = terminalDaysAgo === null ? null : ago(terminalDaysAgo);
    await adminDataSource.query(
      `INSERT INTO core.email_outbox (id, organisation_id, job_type, status, recipient_email, rendered_subject, rendered_html, rendered_text,
                                      sent_at, failed_at, created_at, updated_at, last_error_code)
       VALUES ($1, $2, 'NOTIFICATION', $3, 'g6@example.test', 'Subject', '<p>body</p>', 'body',
               CASE WHEN $3 = 'SENT' THEN $4::timestamptz END, CASE WHEN $3 = 'FAILED' THEN $4::timestamptz END,
               coalesce($4::timestamptz, now() - interval '400 days'), coalesce($4::timestamptz, now() - interval '400 days'), $5)`,
      [id, org.id, status, t, (extra.lastErrorCode as string | undefined) ?? null],
    );
    return id;
  }
  async function event(table: 'realtime_event' | 'worker_event', status: string, daysAgo: number, workspaceId: string | null): Promise<string> {
    const id = randomUUID();
    const cols = table === 'realtime_event' ? ', payload, schema_version' : '';
    const vals = table === 'realtime_event' ? `, '{}'::jsonb, 1` : '';
    await adminDataSource.query(
      `INSERT INTO core.${table} (id, organisation_id, workspace_id, event_key, event_type, entity_type, entity_id, status, processed_at, created_at, updated_at${cols})
       VALUES ($1, $2, $3, $4, 'g6.test', 'test', $5, $6, $7, $7, $7${vals})`,
      [id, org.id, workspaceId, `g6:${id}`, randomUUID(), status, ago(daysAgo)],
    );
    return id;
  }
  async function push(status: string, daysAgo: number): Promise<string> {
    const notificationId = randomUUID();
    const deviceId = randomUUID();
    await adminDataSource.query(
      `INSERT INTO core.notification (id, organisation_id, user_id, type, title, message) VALUES ($1, $2, $3, 'TEST', 't', 'm')`,
      [notificationId, org.id, owner.userId],
    );
    // Any valid RAB2 envelope satisfies DB5's CHECK; the push token is never read in this suite.
    const envelope = Buffer.concat([Buffer.from('RAB2'), Buffer.from([1]), Buffer.from('x'), Buffer.alloc(40, 7)]);
    await adminDataSource.query(
      `INSERT INTO core.push_device (id, organisation_id, user_id, device_id, platform, push_token_encrypted) VALUES ($1, $2, $3, $4, 'ios', $5)`,
      [deviceId, org.id, owner.userId, `g6-${deviceId}`, envelope],
    );
    const id = randomUUID();
    await adminDataSource.query(
      `INSERT INTO core.push_delivery (id, organisation_id, notification_id, push_device_id, status, accepted_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'ACCEPTED' THEN $6::timestamptz END, $6, $6)`,
      [id, org.id, notificationId, deviceId, status, ago(daysAgo)],
    );
    return id;
  }
  const exists = async (table: string, id: string) => (await adminDataSource.query(`SELECT 1 FROM core.${table} WHERE id = $1`, [id])).length === 1;

  // ------------------------------------------------------------------------------------------- retention

  it('disabled (the default): no query, no delete — even an ancient terminal row survives', async () => {
    const old = await email('SENT', 400);
    const result = await runOutboxRetentionCycle(dataSource, dataSource, tenantContext, config({ enabled: false }));
    expect(result).toMatchObject({ ran: false, skipped: 'disabled', scopes: 0 });
    expect(await exists('email_outbox', old)).toBe(true);
  });

  it('report mode only COUNTS (same predicate as the purge) and deletes nothing', async () => {
    const old = await email('SENT', 400);
    const result = await runOutboxRetentionCycle(dataSource, dataSource, tenantContext, config({ mode: 'report' }));
    expect(result.ran).toBe(true);
    expect(result.mode).toBe('report');
    // Oracle: the same predicate over the whole table, as the superuser.
    const [{ n }] = await adminDataSource.query(
      `SELECT count(*)::int AS n FROM core.email_outbox WHERE status IN ('SENT','FAILED','CANCELLED') AND coalesce(sent_at, failed_at, cancelled_at, updated_at) < now() - interval '90 days'`,
    );
    expect(result.rows.email_outbox).toBe(n);
    expect(result.rows.email_outbox).toBeGreaterThanOrEqual(1);
    expect(await exists('email_outbox', old)).toBe(true);
  });

  it('purge deletes ONLY terminal rows older than the period; non-terminal rows of any age and recent terminal rows survive', async () => {
    const ids = {
      sentOld: await email('SENT', 100),
      failedOld: await email('FAILED', 100),
      sentRecent: await email('SENT', 10),
      pendingAncient: await email('PENDING', null),
      retryAncient: await email('RETRY', null),
      processingAncient: await email('PROCESSING', null),
      queuedAncient: await email('QUEUED', null),
      rtDoneOld: await event('realtime_event', 'completed', 30, null),
      rtDoneOldWs: await event('realtime_event', 'completed', 30, owner.workspaceId),
      rtPendingOld: await event('realtime_event', 'pending', 30, owner.workspaceId),
      rtRetryOld: await event('realtime_event', 'retry', 30, null),
      rtDoneRecent: await event('realtime_event', 'completed', 2, null),
      weFailedOld: await event('worker_event', 'failed', 60, owner.workspaceId),
      weProcessingOld: await event('worker_event', 'processing', 60, null),
      pushAcceptedOld: await push('ACCEPTED', 60),
      pushPendingOld: await push('PENDING', 60),
    };
    const result = await runOutboxRetentionCycle(dataSource, dataSource, tenantContext, config());
    expect(result).toMatchObject({ ran: true, mode: 'purge' });

    const gone = ['sentOld', 'failedOld', 'rtDoneOld', 'rtDoneOldWs', 'weFailedOld', 'pushAcceptedOld'] as const;
    const kept = ['sentRecent', 'pendingAncient', 'retryAncient', 'processingAncient', 'queuedAncient', 'rtPendingOld', 'rtRetryOld', 'rtDoneRecent', 'weProcessingOld', 'pushPendingOld'] as const;
    const table = (k: string) => (k.startsWith('rt') ? 'realtime_event' : k.startsWith('we') ? 'worker_event' : k.startsWith('push') ? 'push_delivery' : 'email_outbox');
    for (const k of gone) expect([k, await exists(table(k), ids[k])]).toEqual([k, false]);
    for (const k of kept) expect([k, await exists(table(k), ids[k])]).toEqual([k, true]);
  });

  it('bounded: a backlog larger than batchSize × maxBatchesPerScope drains over successive cycles', async () => {
    for (let i = 0; i < 5; i++) await email('SENT', 200);
    const first = await runOutboxRetentionCycle(dataSource, dataSource, tenantContext, config({ batchSize: 2, maxBatchesPerScope: 1 }));
    expect(first.truncated).toBeGreaterThan(0);
    let guard = 0;
    for (;;) {
      const next = await runOutboxRetentionCycle(dataSource, dataSource, tenantContext, config({ batchSize: 2, maxBatchesPerScope: 1 }));
      if (next.truncated === 0 || ++guard > 20) break;
    }
    const [{ n }] = await adminDataSource.query(
      `SELECT count(*)::int AS n FROM core.email_outbox WHERE organisation_id = $1 AND status = 'SENT' AND sent_at < now() - interval '90 days'`,
      [org.id],
    );
    expect(n).toBe(0);
  });

  it('crewflow_app cannot DELETE outbox/event rows directly (only the definer functions can)', async () => {
    const id = await email('SENT', 400);
    for (const t of ['email_outbox', 'push_delivery', 'realtime_event', 'worker_event']) {
      await expect(tenantContext.runInTenantContext(ctx, (m) => m.query(`DELETE FROM core.${t} WHERE id = $1`, [id]))).rejects.toMatchObject({ code: '42501' });
    }
    expect(await exists('email_outbox', id)).toBe(true);
  });

  it('periods below the DB5 floors are refused by the job AND by the database (22023)', async () => {
    expect(() => assertOutboxRetentionConfig(config({ days: { email_outbox: 29, push_delivery: 30, realtime_event: 7, worker_event: 30 } }))).toThrow(/below the 30 d floor/);
    expect(() => assertOutboxRetentionConfig(config({ days: { email_outbox: 90, push_delivery: 30, realtime_event: 6, worker_event: 30 } }))).toThrow(/below the 7 d floor/);
    await expect(
      tenantContext.runInTenantContext(ctx, (m) => m.query(`SELECT core.purge_terminal_email_outbox(interval '29 days', 10)`)),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      tenantContext.runInTenantContext(ctx, (m) => m.query(`SELECT core.purge_terminal_realtime_event(interval '6 days', 10)`)),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('no tenant context bound: the purge deletes nothing', async () => {
    const id = await email('SENT', 400);
    const [{ n }] = await dataSource.query(`SELECT core.purge_terminal_email_outbox(interval '90 days', 1000) AS n`);
    expect(Number(n)).toBe(0);
    expect(await exists('email_outbox', id)).toBe(true);
  });

  it('multi-replica: while another replica holds the lock, a cycle skips (no scan, no delete)', async () => {
    const id = await email('SENT', 400);
    const holder = adminDataSource.createQueryRunner();
    await holder.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [OUTBOX_RETENTION_LOCK]);
      const result = await runOutboxRetentionCycle(dataSource, dataSource, tenantContext, config());
      expect(result).toMatchObject({ ran: false, skipped: 'locked' });
      expect(await exists('email_outbox', id)).toBe(true);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [OUTBOX_RETENTION_LOCK]);
      await holder.release();
    }
  });

  // ------------------------------------------------------------------------------------------- replay

  const asAdmin = <T>(fn: (m: import('typeorm').EntityManager) => Promise<T>) =>
    tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: null, userId: admin.userId, role: '' }, fn);
  const replay = (id: string, allowUncertain = false) =>
    asAdmin(async (m) => (await m.query(`SELECT core.replay_failed_email($1, $2) AS r`, [id, allowUncertain]))[0].r as string);
  const sent: string[] = [];
  const okDriver = {
    send: async (o: { to: string }) => {
      sent.push(o.to);
      return { provider: 'RESEND', providerMessageId: `msg_${sent.length}` } as EmailSendResult;
    },
    ambiguousDeliverySafeToRetry: true,
  } as unknown as EmailService;
  const fakeJob = (id: string) => ({ id: `email-outbox.${id}.x`, data: { emailOutboxId: id, organisationId: org.id }, attemptsMade: 0, opts: { attempts: 5 } }) as unknown as Job;

  async function failedNotification(): Promise<string> {
    const row = await tenantContext.runInTenantContext(ctx, (m) =>
      new EmailOutboxService().enqueue(m, {
        organisationId: org.id,
        jobType: EmailOutboxJobType.NOTIFICATION,
        recipientEmail: 'replay@example.test',
        targetUserId: owner.userId,
        rendered: { subject: 'Rota', html: '<p>Your rota changed.</p>', text: 'Your rota changed.' },
      }),
    );
    await adminDataSource.query(
      `UPDATE core.email_outbox SET status = 'FAILED', failed_at = now(), last_error_code = 'PROVIDER_REJECTED', infrastructure_attempt_count = 5 WHERE id = $1`,
      [row.id],
    );
    return row.id;
  }

  it('replay is exactly once: two concurrent replays → one REPLAYED + one NOT_FOUND, one audit row, one send', async () => {
    const id = await failedNotification();
    const results = await Promise.all([replay(id), replay(id)]);
    expect(results.sort()).toEqual(['NOT_FOUND', 'REPLAYED']);
    const [row] = await adminDataSource.query(`SELECT status, dispatch_generation, infrastructure_attempt_count, last_error_code FROM core.email_outbox WHERE id = $1`, [id]);
    expect(row).toMatchObject({ status: 'RETRY', infrastructure_attempt_count: 0, last_error_code: null });
    expect(row.dispatch_generation).toBe(1);
    const audit = await adminDataSource.query(`SELECT actor_user_id FROM core.audit_log WHERE action = 'email.replay_requested' AND entity_id = $1`, [id]);
    expect(audit).toEqual([{ actor_user_id: admin.userId }]);

    // Two deliveries of the same row (the service's immediate publish AND a duplicate / stale job): exactly one send.
    sent.length = 0;
    const processor = createEmailSendProcessor({ tenantContext, emailService: okDriver, auditService });
    await Promise.allSettled([processor(fakeJob(id)), processor(fakeJob(id))]);
    await processor(fakeJob(id)).catch(() => undefined);
    expect(sent).toEqual(['replay@example.test']);
    expect((await adminDataSource.query(`SELECT status FROM core.email_outbox WHERE id = $1`, [id]))[0].status).toBe(EmailOutboxStatus.SENT);
    // A SENT row can never be replayed again.
    expect(await replay(id)).toBe('NOT_FOUND');
  });

  it('dispatcher backstop: a replayed row nobody published is recovered under a NEW generation jobId (never attempt.0), then sent once', async () => {
    const id = await failedNotification();
    expect(await replay(id)).toBe('REPLAYED');
    await adminDataSource.query(`UPDATE core.email_outbox SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [id]); // past the RETRY staleness window
    const published: Array<{ id: string; generation: number | null }> = [];
    await runEmailDispatchCycle(
      dataSource,
      tenantContext,
      async (rowId) => void published.push({ id: rowId, generation: null }),
      async (rowId, _org, generation) => void published.push({ id: rowId, generation }),
      true,
    );
    const mine = published.filter((p) => p.id === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.generation).toBe(2); // replay bumped to 1, recovery to 2: a jobId no earlier attempt used
    sent.length = 0;
    await createEmailSendProcessor({ tenantContext, emailService: okDriver, auditService })(fakeJob(id));
    expect(sent).toEqual(['replay@example.test']);
  });

  it('a scrubbed token-bearing FAILED email is refused (NO_BODY); DELIVERY_UNCERTAIN only with explicit allow', async () => {
    const scrubbed = await email('FAILED', 1);
    await adminDataSource.query(`UPDATE core.email_outbox SET rendered_html = NULL, rendered_text = NULL WHERE id = $1`, [scrubbed]);
    expect(await replay(scrubbed)).toBe('NO_BODY');
    const uncertain = await email('FAILED', 1, { lastErrorCode: 'DELIVERY_UNCERTAIN' });
    expect(await replay(uncertain)).toBe('UNCERTAIN');
    expect(await replay(uncertain, true)).toBe('REPLAYED');
  });

  it('replay is tenant-scoped: bound to another organisation the row is NOT_FOUND (no cross-tenant replay)', async () => {
    const id = await failedNotification();
    const other = await new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) }).createOrganisation('g6-other');
    const result = await tenantContext.runInTenantContext({ organisationId: other.id, workspaceId: null, userId: admin.userId, role: '' }, async (m) =>
      (await m.query(`SELECT core.replay_failed_email($1, false) AS r`, [id]))[0].r,
    );
    expect(result).toBe('NOT_FOUND');
    expect((await adminDataSource.query(`SELECT status FROM core.email_outbox WHERE id = $1`, [id]))[0].status).toBe('FAILED');
  });
});
