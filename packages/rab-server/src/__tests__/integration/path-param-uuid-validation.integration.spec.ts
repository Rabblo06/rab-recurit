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
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Hyper Workspace Phase 3, Part 4 regression. A malformed record identifier must never reach a uuid column: it is
 * refused as "not found" at the HTTP boundary (UuidPathParamsInterceptor). Previously `GET /rest/v1/staff/undefined`
 * returned 500 with `invalid input syntax for type uuid: "undefined"`.
 */
const RUN = Boolean(process.env.DATABASE_URL);
(RUN ? describe : describe.skip)('path parameter UUID validation (integration)', () => {
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'pvu' });
    token = await factory.login(managers[0]!);
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  it('an unauthenticated request with a malformed id is refused with 401 before any identifier check (no existence oracle)', async () => {
    const res = await request(app.getHttpServer()).get('/rest/v1/staff/undefined');
    expect(res.status).toBe(401);
  });

  it.each(['undefined', 'abc', 'null', '1', "x'%20OR%201=1"])('an authenticated GET /staff/%s is 404, never a database error', async (id) => {
    const res = await request(app.getHttpServer()).get(`/rest/v1/staff/${id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/uuid|syntax|QueryFailed/i);
  });

  it('a well-formed id that names no record is also 404 (same answer as a malformed id)', async () => {
    const res = await request(app.getHttpServer()).get(`/rest/v1/staff/${randomUUID()}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('a malformed nested identifier is refused the same way', async () => {
    const res = await request(app.getHttpServer()).post('/rest/v1/managers/undefined/venues').set('Authorization', `Bearer ${token}`).send({ venueId: randomUUID() });
    expect([403, 404]).toContain(res.status);
    expect(res.status).not.toBe(500);
  });
});
