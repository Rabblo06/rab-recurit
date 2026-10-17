import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * CF-35 (October 15 audit): when a second account registers the same physical device (a shared or second-hand phone),
 * the previous account's registration for that device stops, so the new holder never receives the previous account's
 * notifications. Registrations on other devices are untouched.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('CF-35 push device binding (integration)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let owner: DataSource;
  let staffA: TestIdentity;
  let staffB: TestIdentity;
  let tokenA: string;
  let tokenB: string;

  const register = (token: string, deviceId: string) =>
    request(app.getHttpServer()).post('/rest/v1/push/devices').set('Authorization', `Bearer ${token}`).send({ deviceId, platform: 'android', pushToken: `fcm-${randomUUID()}` });
  const active = async (userId: string, deviceId: string) =>
    (await owner.query(`SELECT active FROM core.push_device WHERE user_id = $1 AND device_id = $2`, [userId, deviceId]))[0]?.active as boolean | undefined;

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
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'cf35' });
    staffA = await factory.createStaff(seeded.organisation, { owner: seeded.managers[0]!, label: 'cf35a' });
    staffB = await factory.createStaff(seeded.organisation, { owner: seeded.managers[0]!, label: 'cf35b' });
    tokenA = await factory.login(staffA);
    tokenB = await factory.login(staffB);
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('B registering the phone A used stops A’s registration for that phone only', async () => {
    const sharedPhone = `phone-${randomUUID()}`;
    const aOtherPhone = `phone-${randomUUID()}`;
    expect((await register(tokenA, sharedPhone)).status).toBeLessThan(300);
    expect((await register(tokenA, aOtherPhone)).status).toBeLessThan(300);
    expect(await active(staffA.userId, sharedPhone)).toBe(true);

    expect((await register(tokenB, sharedPhone)).status).toBeLessThan(300);
    expect(await active(staffB.userId, sharedPhone)).toBe(true);
    expect(await active(staffA.userId, sharedPhone)).toBe(false);
    expect(await active(staffA.userId, aOtherPhone)).toBe(true);

    // A signing back in on the shared phone takes it back the same way.
    expect((await register(tokenA, sharedPhone)).status).toBeLessThan(300);
    expect(await active(staffA.userId, sharedPhone)).toBe(true);
    expect(await active(staffB.userId, sharedPhone)).toBe(false);
  });
});
