import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * CF-20 (October 15 audit): an abandoned tab's automatic polling must not keep a session alive. A request marked
 * `X-Crewflow-Background: 1` is authenticated in full (a revoked or idle-expired session is still refused) but never
 * extends the idle window; an ordinary request still does.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('CF-20 background requests do not extend the idle window (integration)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let owner: DataSource;
  let manager: TestIdentity;
  let token: string;
  let sessionId: string;

  const me = (background: boolean) => {
    const req = request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return background ? req.set('X-Crewflow-Background', '1') : req;
  };
  const idleExpiry = async () =>
    new Date((await owner.query(`SELECT idle_expires_at FROM core.user_session WHERE id = $1`, [sessionId]))[0].idle_expires_at).getTime();
  const ageLastSeen = () =>
    owner.query(`UPDATE core.user_session SET last_seen_at = now() - interval '10 minutes', idle_expires_at = now() + interval '5 minutes' WHERE id = $1`, [sessionId]);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    const factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    manager = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'cf20' })).managers[0]!;
    token = await factory.login(manager);
    sessionId = (await me(false)).body.sessionId;
    expect(sessionId).toEqual(expect.any(String));
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('a background request is authenticated but leaves the idle deadline where it was', async () => {
    await ageLastSeen();
    const before = await idleExpiry();
    expect((await me(true)).status).toBe(200);
    expect(await idleExpiry()).toBe(before);
  });

  it('an ordinary request still extends the idle deadline', async () => {
    await ageLastSeen();
    const before = await idleExpiry();
    expect((await me(false)).status).toBe(200);
    expect(await idleExpiry()).toBeGreaterThan(before);
  });

  it('a background request on an idle-expired session is refused (validation is unchanged)', async () => {
    await owner.query(`UPDATE core.user_session SET last_seen_at = now() - interval '2 hours', idle_expires_at = now() - interval '1 minute' WHERE id = $1`, [sessionId]);
    expect((await me(true)).status).toBe(401);
  });
});
