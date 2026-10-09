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
 * Hyper Workspace Phase 3, Part 9. One email identity regardless of letter case: an account stored with upper-case
 * letters must sign in with any casing, and forgot-password must find it. Regression for the pre-auth lookup, which
 * compared case-sensitively under a pinned search_path (PreAuthEmailCitextLookup1786675300000).
 */
const RUN = Boolean(process.env.DATABASE_URL);
(RUN ? describe : describe.skip)('email identity is case-insensitive (integration)', () => {
  let app: INestApplication;
  let owner: DataSource;
  let identity: TestIdentity;
  let factory: TestIdentityFactory;

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
    const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'Mixed' });
    identity = managers[0]!;
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  const variants = (email: string) => {
    const [local, domain] = email.split('@');
    return [email.toLowerCase(), email.toUpperCase().replace(local!.toUpperCase(), local!), `${local}@${domain!.toUpperCase()}`];
  };

  it('the stored address really is mixed-case (the premise of this test)', async () => {
    const [row] = await owner.query(`SELECT email::text AS email FROM core."user" WHERE id = $1`, [identity.userId]);
    expect(row.email).not.toBe(row.email.toLowerCase());
  });

  it.each([0, 1, 2])('login succeeds for casing variant #%i of the same account', async (i) => {
    const email = variants(identity.email)[i]!;
    const res = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .send({ email, password: identity.password, applicationTarget: 'manager_web' });
    expect(res.status).toBe(200);
  });

  it('a wrong password for a casing variant is still refused generically (no enumeration, no bypass)', async () => {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .send({ email: identity.email.toLowerCase(), password: 'wrong password 123!', applicationTarget: 'manager_web' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password.');
  });

  it('a Staff created with a mixed-case address signs in with any casing (creation path normalises, login matches)', async () => {
    const email = `Mixed.Staff-${randomUUID().slice(0, 8)}@Example.Test`;
    const token = await factory.login(identity);
    const created = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email, firstName: 'Mixed', lastName: 'Staff' });
    expect(created.status).toBe(201);
    const [row] = await owner.query(`SELECT email::text AS email FROM core."user" WHERE lower(email::text) = lower($1)`, [email]);
    expect(row.email).toBe(email.trim().toLowerCase());
  });

  it('a case-variant of an existing address is refused as a duplicate (one identity, whatever the casing)', async () => {
    const token = await factory.login(identity);
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: identity.email.toUpperCase(), firstName: 'Dup', lastName: 'Staff' });
    expect(res.status).toBe(409);
  });

  it('forgot-password responds identically for every casing variant (anti-enumeration unchanged)', async () => {
    const statuses = await Promise.all(
      variants(identity.email).map((email) => request(app.getHttpServer()).post('/rest/v1/auth/forgot-password').send({ email })),
    );
    expect(new Set(statuses.map((s) => s.status))).toEqual(new Set([statuses[0]!.status]));
    expect(statuses[0]!.status).toBeLessThan(300);
  });

  it('forgot-password for a casing variant actually issues the reset token to the one account', async () => {
    const before = await owner.query(`SELECT count(*)::int AS n FROM core.password_reset_token WHERE user_id = $1`, [identity.userId]);
    await request(app.getHttpServer()).post('/rest/v1/auth/forgot-password').send({ email: identity.email.toUpperCase() });
    const after = await owner.query(`SELECT count(*)::int AS n FROM core.password_reset_token WHERE user_id = $1`, [identity.userId]);
    expect(after[0].n).toBe(before[0].n + 1);
  });
});
