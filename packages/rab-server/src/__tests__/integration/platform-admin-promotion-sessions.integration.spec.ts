import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { PlatformAdminService } from '../../engine/core-modules/platform-admin/platform-admin.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * CF-07 (October 15 audit): a promotion to platform admin must not let a dormant, long-lived, lower-privilege session
 * carry platform-admin authority. Before: the stored 180-day deadline survived the grant. Now every grant path revokes
 * the target's sessions in the grant transaction, in the target's own organisation, and the next sign-in is of the
 * platform-admin class (24 h absolute).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60 * 1000;

describeIfDb('CF-07 promotion to platform admin ends existing sessions (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let platformAdmin: PlatformAdminService;
  let actor: TestIdentity;

  const me = (token: string) => request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${token}`);
  const lifetimeOfLatestSession = async (userId: string): Promise<number> => {
    const [row] = await owner.query(
      `SELECT extract(epoch FROM absolute_expires_at - created_at) * 1000 AS ms FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return Number(row.ms);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    platformAdmin = moduleRef.get(PlatformAdminService);
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    actor = (await factory.createOrganisationWithManagers(1, { permissions: 'production', firstIsPlatformAdmin: true, workspace: true, label: 'cf07a' })).managers[0]!;
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('same organisation: the promoted user’s pre-existing session is refused on its next request; a new sign-in is platform-admin class', async () => {
    const target = await factory.createInternalManager({ id: actor.organisationId } as never, { permissions: 'production', label: 'cf07b' });
    const dormant = await factory.login(target);
    expect((await me(dormant)).status).toBe(200);
    expect(await lifetimeOfLatestSession(target.userId)).toBeGreaterThan(DAY_MS); // the long manager session class

    const { granted } = await platformAdmin.grant({ userId: actor.userId, organisationId: actor.organisationId }, target.userId, actor.password);
    expect(granted).toBe(true);

    expect((await me(dormant)).status).toBe(401);
    const fresh = await factory.login(target);
    expect((await me(fresh)).status).toBe(200);
    expect(await lifetimeOfLatestSession(target.userId)).toBeLessThanOrEqual(DAY_MS + 1_000); // 24 h class (ms of clock skew between created_at and the deadline)
    const [audit] = await owner.query(
      `SELECT metadata FROM core.audit_log WHERE action = 'platform_admin.granted' AND target_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [target.userId],
    );
    expect(audit?.metadata?.revokedSessions).toBeGreaterThanOrEqual(1);
  });

  it('another organisation: revocation reaches the target’s own organisation (RLS-scoped identity rows)', async () => {
    const other = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'cf07c' })).managers[0]!;
    const dormant = await factory.login(other);
    expect((await me(dormant)).status).toBe(200);
    await platformAdmin.grant({ userId: actor.userId, organisationId: actor.organisationId }, other.userId, actor.password);
    expect((await me(dormant)).status).toBe(401);
    const open = await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL`, [other.userId]);
    expect(open[0].n).toBe(0);
  });

  it('a re-grant that changes nothing (already active) does not revoke the admin’s current session', async () => {
    const token = await factory.login(actor);
    const { granted } = await platformAdmin.grant({ userId: actor.userId, organisationId: actor.organisationId }, actor.userId, actor.password);
    expect(granted).toBe(false);
    expect((await me(token)).status).toBe(200);
  });
});
