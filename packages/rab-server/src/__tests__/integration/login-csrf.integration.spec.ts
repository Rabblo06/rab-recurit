import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * CF-05 (login CSRF): a page on another site must not be able to sign the victim's browser into an account of the
 * attacker's choosing (or replace the victim's session cookie). `POST /auth/login` now accepts only JSON, and refuses a
 * present-but-untrusted Origin, before any credential work, so no cookie is ever set for a forged request. The native
 * app (no Origin, JSON) and the real web console (trusted Origin, JSON) are unaffected.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('CF-05 login CSRF (integration)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let owner: DataSource;
  let manager: TestIdentity;
  let staff: TestIdentity;
  let trustedOrigin: string;

  const http = () => request(app.getHttpServer());
  const noCookie = (res: request.Response) => expect(res.headers['set-cookie']).toBeUndefined();

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
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'cf05' });
    manager = seeded.managers[0]!;
    staff = await factory.createStaff(seeded.organisation, { owner: manager, label: 'cf05s' });
    trustedOrigin = moduleRef.get(EnvironmentService).corsOrigins[0]!;
    expect(trustedOrigin).toBeTruthy();
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('an HTML form post (urlencoded) with valid credentials is refused (415) and sets no cookie', async () => {
    const res = await http()
      .post('/rest/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .type('form')
      .send(`email=${encodeURIComponent(manager.email)}&password=${encodeURIComponent(manager.password)}`);
    expect(res.status).toBe(415);
    noCookie(res);
  });

  it('text/plain and multipart bodies are refused the same way', async () => {
    const plain = await http().post('/rest/v1/auth/login').set('Content-Type', 'text/plain').send(JSON.stringify({ email: manager.email, password: manager.password }));
    expect(plain.status).toBe(415);
    noCookie(plain);
    const multipart = await http().post('/rest/v1/auth/login').field('email', manager.email).field('password', manager.password);
    expect(multipart.status).toBe(415);
    noCookie(multipart);
  });

  it('JSON from an untrusted Origin, or from an opaque "null" Origin, is refused (403) and sets no cookie', async () => {
    for (const origin of ['https://evil.example', 'null', `${trustedOrigin}.evil.example`]) {
      const res = await http().post('/rest/v1/auth/login').set('Origin', origin).send({ email: manager.email, password: manager.password });
      expect({ origin, status: res.status }).toEqual({ origin, status: 403 });
      noCookie(res);
    }
  });

  it('the real web console (trusted Origin, JSON) still signs in and receives its cookies', async () => {
    const res = await http().post('/rest/v1/auth/login').set('Origin', trustedOrigin).send({ email: manager.email, password: manager.password });
    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('crewflow_session=');
  });

  it('the native mobile app (no Origin, JSON) still signs in', async () => {
    const res = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: staff.email, password: staff.password });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toEqual(expect.any(String));
  });

  it('a refused forged login does not touch the victim’s existing session cookie', async () => {
    const victim = await http().post('/rest/v1/auth/login').set('Origin', trustedOrigin).send({ email: manager.email, password: manager.password });
    const cookie = String(victim.headers['set-cookie']).match(/crewflow_session=([^;]+)/)![1]!;
    const forged = await http()
      .post('/rest/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .set('Cookie', `crewflow_session=${cookie}`)
      .send({ email: staff.email, password: staff.password });
    expect(forged.status).toBe(403);
    noCookie(forged);
    const me = await http().get('/rest/v1/auth/me').set('Cookie', `crewflow_session=${cookie}`);
    expect(me.status).toBe(200);
    expect(me.body.userId ?? me.body.id).toBe(manager.userId);
  });
});

describeIfDb('CF-14 duplicate session cookies are refused (integration)', () => {
  jest.setTimeout(120_000);
  let app: INestApplication;
  let owner: DataSource;
  let cookie: string;
  let trustedOrigin: string;

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
    const m = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'cf14' })).managers[0]!;
    trustedOrigin = moduleRef.get(EnvironmentService).corsOrigins[0]!;
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').set('Origin', trustedOrigin).send({ email: m.email, password: m.password });
    cookie = String(res.headers['set-cookie']).match(/crewflow_session=([^;]+)/)![1]!;
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('a single genuine session cookie works', async () => {
    expect((await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', `crewflow_session=${cookie}`)).status).toBe(200);
  });

  it('a planted second session cookie (cookie tossing) makes the request fail closed, whichever comes first', async () => {
    const planted = 'x'.repeat(cookie.length);
    for (const header of [`crewflow_session=${planted}; crewflow_session=${cookie}`, `crewflow_session=${cookie}; crewflow_session=${planted}`]) {
      const res = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', header);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('DUPLICATE_SESSION_COOKIE');
    }
  });
});
