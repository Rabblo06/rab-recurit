import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job, MetricsTime, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { StepUpReauthService } from '../../engine/core-modules/auth/services/step-up-reauth.service';
import { AdminPanelService } from '../../engine/core-modules/platform-admin/admin-panel.service';
import { OrganisationSuspensionService } from '../../engine/core-modules/platform-admin/organisation-suspension.service';
import { OutboxOperationsService } from '../../engine/core-modules/platform-admin/outbox-operations.service';
import { PLATFORM_ADMIN_MEMBERSHIP_LOCK, PlatformAdminService } from '../../engine/core-modules/platform-admin/platform-admin.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { WORKER_SCHEDULER_STATUS_KEY } from '../../engine/worker-shared/heartbeat.constants';
import { OrganisationOnboardingService } from '../../modules/manager/services/organisation-onboarding.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Admin panel follow-up release (owner-approved 2026-10-25), real PostgreSQL + Redis:
 *  - T1: maintenance mode, organisation reactivation, CEO-invite resend and HTTP email replay REQUIRE a reason
 *    (trimmed, 3–500) — 400 at the DTO and again in the service (layer 2, no DTO on a direct call);
 *  - B3: platform-admin grant/revoke need a reason, a recent step-up of THIS session (an SSO re-authentication grant
 *    works: an admin without a password can act), never yourself (409), never the last active admin (409) — and two
 *    admins revoking each other at the same moment leave one admin (advisory lock, deterministic race below);
 *  - suspension moved to the same step-up pattern (no inline password);
 *  - the Health chart's metrics endpoint: bounds, "no data" honesty, real BullMQ metrics from a real Worker, no job data.
 */
const RUN = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeIfDb = RUN ? describe : describe.skip;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const FORBIDDEN_KEY = /password|hash|secret|token|rendered|stack|failedreason|metadata|^data$|^payload$|^body$|^returnvalue$|^name$|^id$|jobid/i;
function forbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [...(FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []), ...forbiddenKeys(v, `${path}.${k}`)]);
  }
  return [];
}

describeIfDb('admin panel follow-up: required reasons, platform-admin hardening, queue metrics (integration)', () => {
  jest.setTimeout(300_000);
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let authRedis: AuthCacheRedisClientProvider;
  let stepUp: StepUpReauthService;
  let platformAdmin: PlatformAdminService;
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sidOf = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
  const isActiveAdmin = async (userId: string) => (await owner.query(`SELECT count(*)::int AS n FROM core.platform_admin WHERE user_id = $1 AND revoked_at IS NULL`, [userId]))[0].n === 1;
  const auditOf = (action: string, targetUserId: string) =>
    owner.query(`SELECT organisation_id, actor_user_id, metadata FROM core.audit_log WHERE action = $1 AND target_user_id = $2 ORDER BY created_at`, [action, targetUserId]);

  let admin: TestIdentity;
  let nonAdmin: TestIdentity;

  async function freshToken(who: TestIdentity): Promise<string> {
    return factory.login(who, { applicationTarget: 'manager_web' });
  }
  async function staleToken(who: TestIdentity): Promise<string> {
    const token = await freshToken(who);
    await authRedis.client.del(`crewflow:test:step-up:${sha256(sidOf(token))}`);
    return token;
  }
  async function newAdmin(label: string): Promise<TestIdentity> {
    const org = await factory.createOrganisation(label);
    return factory.createInternalManager(org, { permissions: 'all', label, platformAdmin: true });
  }
  async function newUser(label: string): Promise<TestIdentity> {
    const org = await factory.createOrganisation(label);
    return factory.createInternalManager(org, { permissions: 'all', label });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    authRedis = moduleRef.get(AuthCacheRedisClientProvider);
    stepUp = moduleRef.get(StepUpReauthService);
    platformAdmin = moduleRef.get(PlatformAdminService);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    admin = await newAdmin('apfu-admin');
    nonAdmin = await newUser('apfu-nonadmin');
  });

  afterAll(async () => {
    if (owner?.isInitialized && admin) await owner.query(`UPDATE core.platform_config SET maintenance_mode_enabled = false WHERE organisation_id = $1`, [admin.organisationId]).catch(() => undefined);
    await owner?.destroy();
    await app?.close();
  });

  // ------------------------------------------------------------------------------------------------ T1 required reasons
  describe('T1: a reason is REQUIRED (trimmed, 3–500) — 400 when absent, short, blank or too long', () => {
    it('HTTP: maintenance mode, reactivation, CEO-invite resend and email replay refuse a missing / bad reason (DTO, before any step-up)', async () => {
      const token = await freshToken(admin);
      const org = randomUUID();
      const routes: Array<{ method: 'patch' | 'post'; path: string; body: Record<string, unknown> }> = [
        { method: 'patch', path: '/rest/v1/admin/config/maintenance-mode', body: { enabled: true } },
        { method: 'post', path: `/rest/v1/admin/organisations/${org}/reactivate`, body: {} },
        { method: 'post', path: `/rest/v1/admin/organisations/${org}/ceo-invite/resend`, body: {} },
        { method: 'post', path: `/rest/v1/admin/outbox/organisations/${org}/emails/${randomUUID()}/replay`, body: {} },
      ];
      for (const r of routes) {
        for (const reason of [undefined, '', '  ab  ', '   ', 'x'.repeat(501), 42]) {
          const body = reason === undefined ? r.body : { ...r.body, reason };
          const res = await http()[r.method](r.path).set(bearer(token)).send(body);
          expect({ path: r.path, reason, status: res.status }).toEqual({ path: r.path, reason, status: 400 });
        }
      }
      // Reactivation no longer takes an inline password: the old body is a 400 too (forbidNonWhitelisted).
      expect((await http().post(`/rest/v1/admin/organisations/${org}/reactivate`).set(bearer(token)).send({ reason: 'valid reason', currentPassword: admin.password })).status).toBe(400);
    });

    it('layer 2: every service refuses a missing reason when called directly (no DTO, no guard)', async () => {
      const ctx = await factory.signedInContext(admin);
      const reasonRequired = { response: expect.objectContaining({ code: 'ADMIN_REASON_REQUIRED' }) };
      await expect(app.get(AdminPanelService).setMaintenanceMode(ctx, { enabled: true } as never)).rejects.toMatchObject(reasonRequired);
      await expect(app.get(OrganisationSuspensionService).reactivate(ctx, admin.organisationId, {})).rejects.toMatchObject(reasonRequired);
      await expect(app.get(OrganisationSuspensionService).suspend(ctx, admin.organisationId, { confirmSlug: 'x', reason: ' a ' })).rejects.toMatchObject(reasonRequired);
      await expect(app.get(OutboxOperationsService).replayFailedEmailAsAdmin(ctx, admin.organisationId, randomUUID(), {})).rejects.toMatchObject(reasonRequired);
      await expect(app.get(OrganisationOnboardingService).resendCeoInvite(ctx, admin.organisationId, undefined)).rejects.toMatchObject(reasonRequired);
      await expect(platformAdmin.grant(ctx, nonAdmin.userId, {})).rejects.toMatchObject(reasonRequired);
      await expect(platformAdmin.revoke(ctx, nonAdmin.userId, { reason: 'no' })).rejects.toMatchObject(reasonRequired);
      expect(await isActiveAdmin(nonAdmin.userId)).toBe(false);
      const [{ enabled }] = await owner.query(`SELECT coalesce((SELECT maintenance_mode_enabled FROM core.platform_config WHERE organisation_id = $1), false) AS enabled`, [admin.organisationId]);
      expect(enabled).toBe(false);
    });

    it('the reason lands on the audit row (maintenance mode; reactivation)', async () => {
      const token = await freshToken(admin);
      expect((await http().patch('/rest/v1/admin/config/maintenance-mode').set(bearer(token)).send({ enabled: true, reason: '  Planned database upgrade  ' })).status).toBe(200);
      expect((await http().patch('/rest/v1/admin/config/maintenance-mode').set(bearer(token)).send({ enabled: false, reason: 'Upgrade finished' })).status).toBe(200);
      const rows = await owner.query(
        `SELECT metadata->>'reason' AS reason FROM core.audit_log WHERE action = 'platform_config.maintenance_mode_changed' AND actor_user_id = $1 ORDER BY created_at DESC LIMIT 2`,
        [admin.userId],
      );
      expect(rows.map((r: { reason: string }) => r.reason).sort()).toEqual(['Planned database upgrade', 'Upgrade finished']);
    });
  });

  // ------------------------------------------------------------------------------------------------ suspension step-up
  describe('organisation suspend / reactivate: the step-up pattern (no inline password)', () => {
    it('a STALE session is refused (403 STEP_UP_REQUIRED, nothing written); an SSO re-authentication grant of the same session is enough', async () => {
      const target = await factory.createOrganisation('apfu-susp');
      const [{ slug }] = await owner.query(`SELECT slug FROM core.organisation WHERE id = $1`, [target.id]);
      const token = await staleToken(admin);
      const refused = await http().post(`/rest/v1/admin/organisations/${target.id}/suspend`).set(bearer(token)).send({ reason: 'Unpaid invoices', confirmSlug: slug });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('STEP_UP_REQUIRED');
      expect((await owner.query(`SELECT suspended_at FROM core.organisation WHERE id = $1`, [target.id]))[0].suspended_at).toBeNull();
      const refusals = await owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE actor_user_id = $1 AND action = 'auth.step_up_failed' AND metadata->>'action' = 'organisation.suspend'`, [admin.userId]);
      expect(refusals[0].n).toBeGreaterThanOrEqual(1);

      // What OidcReauthService records after a validated provider re-authentication (no password involved).
      await stepUp.recordSsoReauthGrant(sha256(sidOf(token)), admin.userId);
      const suspended = await http().post(`/rest/v1/admin/organisations/${target.id}/suspend`).set(bearer(token)).send({ reason: 'Unpaid invoices', confirmSlug: slug });
      expect(suspended.status).toBe(201);
      expect(suspended.body.suspended).toBe(true);
      const reactivated = await http().post(`/rest/v1/admin/organisations/${target.id}/reactivate`).set(bearer(token)).send({ reason: 'Invoices paid' });
      expect(reactivated.status).toBe(200);
      const [row] = await owner.query(`SELECT metadata->>'reason' AS reason FROM core.audit_log WHERE action = 'organisation.reactivated' AND entity_id = $1`, [target.id]);
      expect(row.reason).toBe('Invoices paid');
    });
  });

  // ------------------------------------------------------------------------------------------------ B3 platform admins
  describe('B3: platform-admin grant / revoke', () => {
    it('grant: reason + recent step-up; the target is signed out everywhere; the reason is audited; a legacy password body is a 400', async () => {
      const target = await newUser('apfu-grant');
      const targetToken = await freshToken(target);
      const token = await freshToken(admin);
      expect((await http().post(`/rest/v1/admin/platform-admins/${target.userId}`).set(bearer(token)).send({ currentPassword: admin.password })).status).toBe(400);
      expect((await http().post(`/rest/v1/admin/platform-admins/${target.userId}`).set(bearer(token)).send({})).status).toBe(400);
      expect((await http().post(`/rest/v1/admin/platform-admins/${randomUUID()}`).set(bearer(token)).send({ reason: 'unknown target' })).status).toBe(404);

      const res = await http().post(`/rest/v1/admin/platform-admins/${target.userId}`).set(bearer(token)).send({ reason: 'New on-call engineer' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ granted: true });
      expect(res.body.revokedSessions).toBeGreaterThanOrEqual(1);
      expect((await http().get('/rest/v1/auth/me').set(bearer(targetToken))).status).toBe(401);
      expect((await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL`, [target.userId]))[0].n).toBe(0);
      const [audit] = await auditOf('platform_admin.granted', target.userId);
      expect(audit).toMatchObject({ organisation_id: admin.organisationId, actor_user_id: admin.userId });
      expect(audit.metadata).toMatchObject({ reason: 'New on-call engineer' });
    });

    it('a STALE session cannot grant or revoke (403 STEP_UP_REQUIRED with the action name); an SSO-only proof (re-authentication grant) can', async () => {
      const target = await newUser('apfu-sso');
      const token = await staleToken(admin);
      const grant = await http().post(`/rest/v1/admin/platform-admins/${target.userId}`).set(bearer(token)).send({ reason: 'stale attempt' });
      expect(grant.status).toBe(403);
      expect(grant.body).toMatchObject({ code: 'STEP_UP_REQUIRED', mfa: false });
      expect(await isActiveAdmin(target.userId)).toBe(false);
      await stepUp.recordSsoReauthGrant(sha256(sidOf(token)), admin.userId);
      expect((await http().post(`/rest/v1/admin/platform-admins/${target.userId}`).set(bearer(token)).send({ reason: 'SSO admin grants' })).status).toBe(201);
      expect(await isActiveAdmin(target.userId)).toBe(true);

      const stale = await staleToken(admin);
      const revoke = await http().delete(`/rest/v1/admin/platform-admins/${target.userId}`).set(bearer(stale)).send({ reason: 'stale attempt' });
      expect(revoke.status).toBe(403);
      expect(revoke.body.code).toBe('STEP_UP_REQUIRED');
      expect(await isActiveAdmin(target.userId)).toBe(true);
      const actions = await owner.query(
        `SELECT DISTINCT metadata->>'action' AS action FROM core.audit_log WHERE actor_user_id = $1 AND action = 'auth.step_up_failed' AND metadata->>'action' LIKE 'platform.admin.%'`,
        [admin.userId],
      );
      expect(actions.map((a: { action: string }) => a.action).sort()).toEqual(['platform.admin.grant', 'platform.admin.revoke']);

      const ok = await http().delete(`/rest/v1/admin/platform-admins/${target.userId}`).set(bearer(await freshToken(admin))).send({ reason: 'Rotation ended' });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ revoked: true });
      const [audit] = await auditOf('platform_admin.revoked', target.userId);
      expect(audit.metadata).toMatchObject({ reason: 'Rotation ended' });
    });

    it('ABUSE: removing yourself is refused (409 PLATFORM_ADMIN_SELF_REMOVAL) over HTTP and in the service; nothing changes', async () => {
      const token = await freshToken(admin);
      const res = await http().delete(`/rest/v1/admin/platform-admins/${admin.userId}`).set(bearer(token)).send({ reason: 'leaving the team' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PLATFORM_ADMIN_SELF_REMOVAL');
      await expect(platformAdmin.revoke(await factory.signedInContext(admin), admin.userId, { reason: 'leaving the team' })).rejects.toMatchObject({ status: 409 });
      expect(await isActiveAdmin(admin.userId)).toBe(true);
    });

    it('ABUSE: a non-admin (layer 2) and an Admin Inspect context are refused in the service', async () => {
      const victim = await newUser('apfu-l2');
      await expect(platformAdmin.grant(await factory.signedInContext(nonAdmin), victim.userId, { reason: 'self promotion' })).rejects.toMatchObject({ status: 403 });
      await expect(platformAdmin.grant({ ...(await factory.signedInContext(admin)), inspectedBy: admin.userId }, victim.userId, { reason: 'under inspect' })).rejects.toMatchObject({ status: 403 });
      expect(await isActiveAdmin(victim.userId)).toBe(false);
    });

    it('ABUSE (race): two admins revoking EACH OTHER at the same moment leave exactly one — the second, re-checked under the lock, is no longer an admin (403)', async () => {
      const a = await newAdmin('apfu-race-a');
      const b = await newAdmin('apfu-race-b');
      // The rule is platform-wide, so for this test A and B must be the ONLY active admins: every other active admin row
      // on this disposable database is set aside and restored in `finally`.
      const others: Array<{ user_id: string }> = await owner.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL AND user_id <> ALL($1::uuid[])`, [[a.userId, b.userId]]);
      const ids = others.map((o) => o.user_id);
      const tokenA = await freshToken(a);
      const tokenB = await freshToken(b);
      const holder = owner.createQueryRunner();
      await holder.connect();
      try {
        await owner.query(`UPDATE core.platform_admin SET revoked_at = now() WHERE user_id = ANY($1::uuid[])`, [ids]);
        // Hold the membership lock so BOTH revokes pass their pre-checks and queue on it — then release them together.
        await holder.startTransaction();
        await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [PLATFORM_ADMIN_MEMBERSHIP_LOCK]);
        const pending = Promise.all([
          http().delete(`/rest/v1/admin/platform-admins/${b.userId}`).set(bearer(tokenA)).send({ reason: 'race A removes B' }),
          http().delete(`/rest/v1/admin/platform-admins/${a.userId}`).set(bearer(tokenB)).send({ reason: 'race B removes A' }),
        ]);
        const deadline = Date.now() + 30_000;
        for (;;) {
          // A bigint advisory key shows as classid = high 32 bits, objid = low 32 bits, objsubid = 1.
          const [{ n }] = await owner.query(
            `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
                AND classid::bigint = ($1::bigint >> 32) AND objid::bigint = ($1::bigint & 4294967295)`,
            [PLATFORM_ADMIN_MEMBERSHIP_LOCK],
          );
          if (n >= 2) break;
          if (Date.now() > deadline) throw new Error('both revokes never queued on the platform-admin membership lock');
          await new Promise((r) => setTimeout(r, 50));
        }
        await holder.commitTransaction();
        const [ra, rb] = await pending;
        // The winner commits first; the loser's actor re-check (under the lock, after that commit) finds it is no longer an
        // admin. Without the lock both would see the other still active and both revokes would commit (zero admins).
        expect([ra, rb].map((r) => `${r.status}:${r.body.revoked === true ? 'revoked' : r.body.message}`).sort()).toEqual([
          '200:revoked',
          '403:Only an active platform administrator can change platform admins.',
        ]);
        const survivors = [await isActiveAdmin(a.userId), await isActiveAdmin(b.userId)].filter(Boolean);
        expect(survivors).toHaveLength(1);
        expect((await owner.query(`SELECT count(*)::int AS n FROM core.platform_admin WHERE revoked_at IS NULL`))[0].n).toBe(1);
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction().catch(() => undefined);
        await holder.release();
        await owner.query(`UPDATE core.platform_admin SET revoked_at = NULL, revoked_by = NULL WHERE user_id = ANY($1::uuid[])`, [ids]);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------ queue metrics
  describe('Health chart: GET /admin/queues/:queue/metrics', () => {
    const redis = () => new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

    it('bounds: platform admins only; range allowlist (400); unknown / malformed queue (404); fixed bucket counts per range; no job data', async () => {
      const token = await freshToken(admin);
      expect((await http().get('/rest/v1/admin/queues/rab-email/metrics?range=1D')).status).toBe(401);
      expect((await http().get('/rest/v1/admin/queues/rab-email/metrics?range=1D').set(bearer(await freshToken(nonAdmin)))).status).toBe(403);
      for (const bad of ['2H', '1d', '30D', 'ALL', "1D'"]) expect((await http().get(`/rest/v1/admin/queues/rab-email/metrics?range=${encodeURIComponent(bad)}`).set(bearer(token))).status).toBe(400);
      expect((await http().get('/rest/v1/admin/queues/rab-email/metrics?range=1D&organisationId=' + randomUUID()).set(bearer(token))).status).toBe(400);
      expect((await http().get('/rest/v1/admin/queues/not-a-queue/metrics?range=1D').set(bearer(token))).status).toBe(404);
      expect((await http().get('/rest/v1/admin/queues/RAB_EMAIL*/metrics?range=1D').set(bearer(token))).status).toBe(404);
      const expected: Record<string, [number, number]> = { '1H': [60, 1], '4H': [4, 60], '12H': [12, 60], '1D': [24, 60], '7D': [168, 60] };
      for (const [range, [count, bucketMinutes]] of Object.entries(expected)) {
        const res = await http().get(`/rest/v1/admin/queues/rab-shift-statements/metrics?range=${range}`).set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.buckets).toHaveLength(count);
        expect(res.body.bucketMinutes).toBe(bucketMinutes);
        expect(Object.keys(res.body).sort()).toEqual(['available', 'bucketMinutes', 'buckets', 'from', 'generatedAt', 'queue', 'range', 'reason', 'to', 'totals']);
        for (const b of res.body.buckets) expect(Object.keys(b).sort()).toEqual(['at', 'completed', 'failed']);
        expect(forbiddenKeys(res.body)).toEqual([]);
      }
      // Default range = 1D.
      expect((await http().get('/rest/v1/admin/queues/rab-push/metrics').set(bearer(token))).body.range).toBe('1D');
    });

    it('real BullMQ metrics from a real Worker: "no data" first (never synthesised), then completed / failed counted into the current bucket; cached 30 s', async () => {
      const token = await freshToken(admin);
      const conn = redis();
      const prefix = `crewflow:test-apfu-${randomUUID().slice(0, 8)}:bull`;
      // A live bullmq scheduler status lists the scan queues under its prefix (isolated: nothing else uses this prefix).
      await conn.multi().hset(WORKER_SCHEDULER_STATUS_KEY, { mode: 'bullmq', prefix, reconciledAt: Date.now(), schedulers: 0 }).expire(WORKER_SCHEDULER_STATUS_KEY, 120).exec();
      const queueName = 'crewflow-scan-reports';
      const queue = new Queue(queueName, { connection: conn, prefix });
      let worker: Worker | undefined;
      const workerConn = redis();
      try {
        const empty = await http().get(`/rest/v1/admin/queues/${queueName}/metrics?range=4H`).set(bearer(token));
        expect(empty.status).toBe(200);
        expect(empty.body).toMatchObject({ available: false, reason: 'NO_DATA', totals: { completed: 0, failed: 0 } });
        expect(empty.body.buckets.every((b: { completed: number; failed: number }) => b.completed === 0 && b.failed === 0)).toBe(true);

        let done = 0;
        worker = new Worker(
          queueName,
          async (job: Job) => {
            if ((job.data as { ok?: boolean }).ok !== true) throw new Error('boom secret-failure-text');
            return { secretReturn: 'do-not-leak' };
          },
          { connection: workerConn, prefix, metrics: { maxDataPoints: MetricsTime.ONE_WEEK } },
        );
        worker.on('completed', () => (done += 1));
        worker.on('failed', () => (done += 1));
        for (let i = 0; i < 3; i += 1) await queue.add('apfu-secret-job-name', { ok: true, email: 'leak@example.test' });
        for (let i = 0; i < 2; i += 1) await queue.add('apfu-secret-job-name', { ok: false }, { attempts: 1 });
        const deadline = Date.now() + 20_000;
        while (done < 5 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        expect(done).toBe(5);

        const hour = await http().get(`/rest/v1/admin/queues/${queueName}/metrics?range=1H`).set(bearer(token));
        expect(hour.status).toBe(200);
        expect(hour.body).toMatchObject({ queue: queueName, range: '1H', available: true, reason: null, totals: { completed: 3, failed: 2 } });
        // All five finished within the last minute or two: in the current (or the previous, at a minute boundary) bucket.
        const recent = hour.body.buckets.slice(-2).reduce((s: { c: number; f: number }, b: { completed: number; failed: number }) => ({ c: s.c + b.completed, f: s.f + b.failed }), { c: 0, f: 0 });
        expect(recent).toEqual({ c: 3, f: 2 });
        const raw = JSON.stringify(hour.body);
        for (const leak of ['apfu-secret-job-name', 'boom', 'secret-failure-text', 'do-not-leak', 'leak@example.test']) expect(raw).not.toContain(leak);
        expect(forbiddenKeys(hour.body)).toEqual([]);

        const week = await http().get(`/rest/v1/admin/queues/${queueName}/metrics?range=7D`).set(bearer(token));
        expect(week.body).toMatchObject({ available: true, totals: { completed: 3, failed: 2 } });
        expect(week.body.buckets).toHaveLength(168);

        // Cached ~30 s: one more finished job does not change an answer served from the cache.
        await queue.add('apfu-secret-job-name', { ok: true });
        const until = Date.now() + 10_000;
        while (done < 6 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
        const cached = await http().get(`/rest/v1/admin/queues/${queueName}/metrics?range=1H`).set(bearer(token));
        expect(cached.body.generatedAt).toBe(hour.body.generatedAt);
        expect(cached.body.totals).toEqual({ completed: 3, failed: 2 });
      } finally {
        await worker?.close();
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
        await conn.del(WORKER_SCHEDULER_STATUS_KEY);
        conn.disconnect();
        workerConn.disconnect();
      }
    });
  });
});
