import './helpers/email-reliability-env'; // FIRST: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { LOGIN_HANDOFF_CLEANUP_LOCK, runLoginHandoffCleanupCycle } from '../../queues/rab-maintenance/login-handoff-cleanup.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Wave 4/5 (MFA-lane request) — scheduled purge of cross-host login handoffs through DB5's `core.login_handoff_cleanup`
 * (contract §2): only rows expired OR consumed more than 1 h ago; live and recently-used rows survive; crewflow_app has no
 * direct privilege on the table; disabled flag = nothing; one replica per cycle (session advisory lock).
 */
jest.setTimeout(120_000);
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('login handoff cleanup job (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let manager: TestIdentity;
  let sessionId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    const factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    const org = await factory.createOrganisation('handoff-cleanup');
    manager = await factory.createInternalManager(org);
    sessionId = randomUUID();
    await adminDataSource.query(
      `INSERT INTO core.user_session (id, organisation_id, user_id, application_target, absolute_expires_at) VALUES ($1, $2, $3, 'manager_web', now() + interval '1 day')`,
      [sessionId, manager.organisationId, manager.userId],
    );
  });

  afterAll(async () => {
    await adminDataSource?.destroy();
    await app?.close();
  });

  /** A handoff created `createdAgoMinutes` ago with a 30 s TTL, optionally consumed `consumedAgoMinutes` ago. */
  async function handoff(createdAgoMinutes: number, consumedAgoMinutes: number | null = null): Promise<string> {
    const id = randomUUID();
    await adminDataSource.query(
      `INSERT INTO core.login_handoff (id, organisation_id, user_id, source_session_id, workspace_id, audience_label, application_target,
                                       security_version, token_hash, created_at, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, 'handoff-test', 'manager_web', 0, $6,
               now() - make_interval(mins => $7), now() - make_interval(mins => $7) + interval '30 seconds',
               CASE WHEN $8::int IS NULL THEN NULL ELSE now() - make_interval(mins => $8::int) END)`,
      [id, manager.organisationId, manager.userId, sessionId, manager.workspaceId, createHash('sha256').update(randomBytes(32)).digest('hex'), createdAgoMinutes, consumedAgoMinutes],
    );
    return id;
  }
  const exists = async (id: string) => (await adminDataSource.query(`SELECT 1 FROM core.login_handoff WHERE id = $1`, [id])).length === 1;

  it('purges only rows expired or consumed more than 1 h ago; live and recently expired/consumed rows survive', async () => {
    const ids = {
      expiredLongAgo: await handoff(180),
      consumedLongAgo: await handoff(120, 119),
      expiredRecently: await handoff(30),
      consumedRecently: await handoff(10, 9),
      live: await handoff(0),
    };
    const result = await runLoginHandoffCleanupCycle(dataSource, dataSource, { enabled: true });
    expect(result).toMatchObject({ ran: true });
    expect(result.ran && result.rowsDeleted).toBeGreaterThanOrEqual(2);
    expect(await exists(ids.expiredLongAgo)).toBe(false);
    expect(await exists(ids.consumedLongAgo)).toBe(false);
    expect(await exists(ids.expiredRecently)).toBe(true);
    expect(await exists(ids.consumedRecently)).toBe(true);
    expect(await exists(ids.live)).toBe(true);
  });

  it('bounded batches drain a backlog across calls (batch 1, max 1 per cycle)', async () => {
    const a = await handoff(300);
    const b = await handoff(300);
    const first = await runLoginHandoffCleanupCycle(dataSource, dataSource, { enabled: true, batchSize: 1, maxBatches: 1 });
    expect(first).toEqual({ ran: true, rowsDeleted: 1, batches: 1 });
    await runLoginHandoffCleanupCycle(dataSource, dataSource, { enabled: true, batchSize: 1, maxBatches: 1 });
    expect([await exists(a), await exists(b)]).toEqual([false, false]);
  });

  it('disabled: no call, nothing deleted', async () => {
    const old = await handoff(500);
    expect(await runLoginHandoffCleanupCycle(dataSource, dataSource, { enabled: false })).toEqual({ ran: false, skipped: 'disabled' });
    expect(await exists(old)).toBe(true);
  });

  it('multi-replica: while another replica holds the lock the cycle skips', async () => {
    const old = await handoff(500);
    const holder = adminDataSource.createQueryRunner();
    await holder.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [LOGIN_HANDOFF_CLEANUP_LOCK]);
      expect(await runLoginHandoffCleanupCycle(dataSource, dataSource, { enabled: true })).toEqual({ ran: false, skipped: 'locked' });
      expect(await exists(old)).toBe(true);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [LOGIN_HANDOFF_CLEANUP_LOCK]);
      await holder.release();
    }
    await runLoginHandoffCleanupCycle(dataSource, dataSource, { enabled: true });
    expect(await exists(old)).toBe(false);
  });

  it('crewflow_app has no direct privilege on core.login_handoff (only the definer function can purge)', async () => {
    const id = await handoff(500);
    await expect(
      tenantContext.runInTenantContext({ organisationId: manager.organisationId, workspaceId: null, userId: manager.userId, role: '' }, (m) =>
        m.query(`DELETE FROM core.login_handoff WHERE id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(dataSource.query(`SELECT count(*) FROM core.login_handoff`)).rejects.toMatchObject({ code: '42501' });
    expect(await exists(id)).toBe(true);
  });
});
