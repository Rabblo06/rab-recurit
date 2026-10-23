import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EMAIL_QUEUE_NAME } from '../../engine/core-modules/email/email-queue.constants';
import { OutboxOperationsService } from '../../engine/core-modules/platform-admin/outbox-operations.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Wave 5 lane OPS — platform-admin outbox surface: failed-row listing (no bodies/recipients/tokens), audited
 * exactly-once email replay, BullMQ/heartbeat observability. Abuse cases first: a non-admin gets 403 at the guard AND
 * at the service (layer 2, the path the `outbox:replay` CLI takes); a client-sent organisationId / unknown field is 400.
 */
const RUN = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfDb('admin outbox operations (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let admin: TestIdentity;
  let manager: TestIdentity;
  let adminToken: string;
  let managerToken: string;
  let queue: Queue;
  let queueRedis: Redis;
  const http = () => request(app.getHttpServer());

  async function failedEmail(opts: { body?: boolean; errorCode?: string; jobType?: string } = {}): Promise<string> {
    const id = randomUUID();
    const body = opts.body ?? true;
    await adminDataSource.query(
      `INSERT INTO core.email_outbox (id, organisation_id, job_type, status, recipient_email, rendered_subject, rendered_html, rendered_text, failed_at, last_error_code, last_error_message_sanitized)
       VALUES ($1, $2, $3, 'FAILED', 'secret-recipient@example.test', 'Private subject', $4, $5, now(), $6, 'provider said: secret-recipient@example.test rejected')`,
      [id, org.id, opts.jobType ?? 'NOTIFICATION', body ? '<p>private body</p>' : null, body ? 'private body' : null, opts.errorCode ?? 'PROVIDER_REJECTED'],
    );
    return id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    const adminOrg = await factory.createOrganisation('outbox-admin');
    admin = await factory.createInternalManager(adminOrg, { permissions: 'all', label: 'admin' });
    await factory.grantPlatformAdmin(admin.userId);
    org = await factory.createOrganisation('outbox-target');
    manager = await factory.createInternalManager(org, { permissions: 'all' });
    adminToken = await factory.login(admin);
    managerToken = await factory.login(manager);
    queueRedis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue(EMAIL_QUEUE_NAME, { connection: queueRedis });
  });

  afterAll(async () => {
    await queue.close();
    queueRedis.disconnect();
    await app.close();
    await adminDataSource.destroy();
  });

  it('a non-platform-admin (even with every permission) gets 403 on every route', async () => {
    const id = await failedEmail();
    expect((await http().get('/rest/v1/admin/outbox/failed').set('Authorization', `Bearer ${managerToken}`)).status).toBe(403);
    expect((await http().get('/rest/v1/admin/outbox/queues').set('Authorization', `Bearer ${managerToken}`)).status).toBe(403);
    const replay = await http().post(`/rest/v1/admin/outbox/organisations/${org.id}/emails/${id}/replay`).set('Authorization', `Bearer ${managerToken}`).send({});
    expect(replay.status).toBe(403);
    expect((await adminDataSource.query(`SELECT status FROM core.email_outbox WHERE id = $1`, [id]))[0].status).toBe('FAILED');
  });

  it('layer 2: the service refuses a non-admin actor even when called directly (CLI path, no guard)', async () => {
    const id = await failedEmail();
    const service = app.get(OutboxOperationsService);
    await expect(service.replayFailedEmailRaw({ userId: manager.userId }, org.id, id)).rejects.toMatchObject({ status: 403 });
    await expect(service.listFailed({ userId: manager.userId }, {})).rejects.toMatchObject({ status: 403 });
  });

  it('listing shows ids/codes/timestamps only — never the body, subject, recipient or error text', async () => {
    const id = await failedEmail();
    const res = await http().get(`/rest/v1/admin/outbox/failed?kind=email&organisationId=${org.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const item = res.body.find((i: { id: string }) => i.id === id);
    expect(item).toMatchObject({ kind: 'email', organisationId: org.id, type: 'NOTIFICATION', lastErrorCode: 'PROVIDER_REJECTED', replayable: true, dispatchGeneration: 0 });
    const raw = JSON.stringify(res.body);
    for (const secret of ['private body', 'Private subject', 'secret-recipient@example.test', 'provider said']) expect(raw).not.toContain(secret);
  });

  it('a client-supplied organisationId / unknown body field is a 400 (never a hint); a malformed path id is a 404', async () => {
    const id = await failedEmail();
    const res = await http()
      .post(`/rest/v1/admin/outbox/organisations/${org.id}/emails/${id}/replay`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ organisationId: randomUUID() });
    expect(res.status).toBe(400);
    // A malformed path id is a 404 (the global UuidPathParamsInterceptor: looks exactly like a missing row).
    expect((await http().post(`/rest/v1/admin/outbox/organisations/not-a-uuid/emails/${id}/replay`).set('Authorization', `Bearer ${adminToken}`).send({})).status).toBe(404);
  });

  it('replay: 200 once (published under the bumped generation, audited), then 404 — exactly once', async () => {
    const id = await failedEmail();
    const url = `/rest/v1/admin/outbox/organisations/${org.id}/emails/${id}/replay`;
    const [a, b] = await Promise.all([
      http().post(url).set('Authorization', `Bearer ${adminToken}`).send({}),
      http().post(url).set('Authorization', `Bearer ${adminToken}`).send({}),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect((a.status === 200 ? a : b).body).toEqual({ result: 'REPLAYED' });
    const [row] = await adminDataSource.query(`SELECT status, dispatch_generation FROM core.email_outbox WHERE id = $1`, [id]);
    expect(row).toEqual({ status: 'RETRY', dispatch_generation: 1 });
    const job = await queue.getJob(`email-outbox.${id}.attempt.1`);
    expect(job?.data).toEqual({ emailOutboxId: id, organisationId: org.id });
    expect(await queue.getJob(`email-outbox.${id}.attempt.0`)).toBeUndefined();
    const audit = await adminDataSource.query(`SELECT actor_user_id, organisation_id FROM core.audit_log WHERE action = 'email.replay_requested' AND entity_id = $1`, [id]);
    expect(audit).toEqual([{ actor_user_id: admin.userId, organisation_id: org.id }]);
    expect((await http().post(url).set('Authorization', `Bearer ${adminToken}`).send({})).status).toBe(404);
    await job?.remove();
  });

  it('a scrubbed token-bearing body → 409 NO_BODY; DELIVERY_UNCERTAIN → 409 unless allowUncertain=true', async () => {
    const scrubbed = await failedEmail({ body: false, jobType: 'PASSWORD_RESET' });
    const r1 = await http().post(`/rest/v1/admin/outbox/organisations/${org.id}/emails/${scrubbed}/replay`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('NO_BODY');
    const uncertain = await failedEmail({ errorCode: 'DELIVERY_UNCERTAIN' });
    const r2 = await http().post(`/rest/v1/admin/outbox/organisations/${org.id}/emails/${uncertain}/replay`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('DELIVERY_UNCERTAIN');
    const r3 = await http().post(`/rest/v1/admin/outbox/organisations/${org.id}/emails/${uncertain}/replay`).set('Authorization', `Bearer ${adminToken}`).send({ allowUncertain: true });
    expect(r3.status).toBe(200);
    await (await queue.getJob(`email-outbox.${uncertain}.attempt.1`))?.remove();
  });

  it('wrong target organisation → 404 (the row is invisible there), nothing changes', async () => {
    const id = await failedEmail();
    const other = await factory.createOrganisation('outbox-other');
    const res = await http().post(`/rest/v1/admin/outbox/organisations/${other.id}/emails/${id}/replay`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(res.status).toBe(404);
    expect((await adminDataSource.query(`SELECT status FROM core.email_outbox WHERE id = $1`, [id]))[0].status).toBe('FAILED');
  });

  it('queue observability: BullMQ counts for rab-email / rab-push and the worker heartbeat/stat hash', async () => {
    const res = await http().get('/rest/v1/admin/outbox/queues').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.queues.map((q: { name: string }) => q.name)).toEqual(['rab-email', 'rab-push']);
    for (const q of res.body.queues) expect(q.counts).toEqual(expect.objectContaining({ waiting: expect.any(Number), failed: expect.any(Number), active: expect.any(Number) }));
    expect(res.body.worker).toEqual(expect.objectContaining({ stale: expect.any(Boolean), stats: expect.any(Object) }));
  });
});
