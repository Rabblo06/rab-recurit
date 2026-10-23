import 'reflect-metadata';

// Wave 3 lane H × lane S2 contract (docs/evidence/wave2-lane-s2/CONTRACT.md) against the REAL database functions:
// core.resolve_workspace_by_host_label, core.resolve_released_host_label, the rename-quarantine trigger and the one-namespace
// core.workspace_subdomain_taken. PENDING INTEGRATION: lane S2's migration (HostLabelNamespace1786719820000) is not on the
// shared test database until the coordinator integrates both lanes. Opt in with HOST_LABEL_CONTRACT_DB=1 on a database that
// has it applied; otherwise the suite is skipped (never reported as passed).
const ORIGINAL = { WORKSPACE_BASE_DOMAIN: process.env.WORKSPACE_BASE_DOMAIN, CORS_ORIGINS: process.env.CORS_ORIGINS };
process.env.WORKSPACE_BASE_DOMAIN = 'rab.test';
process.env.CORS_ORIGINS = 'http://localhost:5173';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { EnvironmentVariables } from '../../engine/core-modules/environment/environment-variables';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceHostLookupService } from '../../engine/core-modules/workspace-host/workspace-host-lookup.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL) && process.env.HOST_LABEL_CONTRACT_DB === '1';
const describeContract = RUN ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';

describeContract('wave 3 lane H × S2 — host-label registry contract (real functions; pending integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let owner: DataSource;
  let lookup: WorkspaceHostLookupService;
  let a: TestIdentity;
  let b: TestIdentity;
  const http = () => request(app.getHttpServer());

  async function cookieFor(identity: TestIdentity): Promise<string> {
    const login = await http().post('/rest/v1/auth/login').set('Origin', ORIGIN).send({ email: identity.email, password: identity.password });
    expect(login.status).toBe(200);
    return ([] as string[]).concat(login.headers['set-cookie'] ?? []).filter((c) => c.startsWith('crewflow_session=')).map((c) => c.split(';')[0]).join('; ');
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    const env = moduleRef.get(EnvironmentService);
    const realGet = env.get.bind(env);
    jest.spyOn(env, 'get').mockImplementation(((key: keyof EnvironmentVariables) =>
      key === 'WORKSPACE_HOST_ROUTING_ENABLED' ? true : realGet(key)) as EnvironmentService['get']);
    app.use(cookieParser());
    await app.init();
    lookup = moduleRef.get(WorkspaceHostLookupService);
    owner = createAdminDataSource();
    await owner.initialize();
    const factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    a = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: false, label: 'w3ca' })).managers[0]!;
    b = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: false, label: 'w3cb' })).managers[0]!;
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const label = `w3c-${randomUUID().slice(0, 8)}`;
  const renamed = `${label}-new`;

  it('a READY workspace created through the API resolves; reserved and unknown labels do not', async () => {
    const cookie = await cookieFor(a);
    const created = await http().post('/rest/v1/manager-workspaces').set('Origin', ORIGIN).set('Cookie', cookie).send({ name: 'Contract A', subdomain: label });
    expect(created.status).toBe(201);
    expect(created.body.schemaStatus).toBe('READY');
    expect(await lookup.lookup(label)).toMatchObject({ kind: 'workspace', canonicalLabel: label, organisationId: a.organisationId, displayName: 'Contract A' });
    // The public resolver returns the workspace name for the login page, and nothing else about the workspace.
    const pub = await http().get('/rest/v1/public/workspace-host').set('Host', `${label}.rab.test`);
    expect(pub.status).toBe(200);
    expect(pub.body.workspace).toEqual({ subdomain: label, displayName: 'Contract A' });
    expect(JSON.stringify(pub.body)).not.toContain(a.organisationId);
    expect(await lookup.lookup('admin')).toEqual({ kind: 'unknown' });
    expect(await lookup.lookup(`ghost-${randomUUID().slice(0, 8)}`)).toEqual({ kind: 'unknown' });
  });

  it('rename quarantines the old label: it resolves as renamed → canonical new label; the new label routes', async () => {
    const cookie = await cookieFor(a);
    const res = await http().patch('/rest/v1/manager-workspaces/me/subdomain').set('Origin', ORIGIN).set('Cookie', cookie).send({ subdomain: renamed });
    expect(res.status).toBe(200);
    expect(await lookup.lookup(label)).toMatchObject({ kind: 'renamed', canonicalLabel: renamed });
    expect(await lookup.lookup(renamed)).toMatchObject({ kind: 'workspace', canonicalLabel: renamed });
    const audit = await owner.query(
      `SELECT metadata FROM core.audit_log WHERE entity_type = 'manager_workspace' AND action = 'manager_workspace.subdomain_changed' AND metadata->>'oldSubdomain' = $1`,
      [label],
    );
    expect(audit[0]?.metadata?.oldLabelQuarantinedUntil).toBeTruthy();
  });

  it('ABUSE: another organisation cannot take the quarantined label (409, no disclosure)', async () => {
    const cookie = await cookieFor(b);
    const check = await http().post('/rest/v1/manager-workspaces/subdomain/check').set('Origin', ORIGIN).set('Cookie', cookie).send({ candidate: label });
    expect(check.body).toMatchObject({ available: false, reserved: false });
    const create = await http().post('/rest/v1/manager-workspaces').set('Origin', ORIGIN).set('Cookie', cookie).send({ name: 'Squatter', subdomain: label });
    expect(create.status).toBe(409);
    expect(JSON.stringify(create.body)).not.toContain(a.organisationId);
  });

  it('the releasing workspace may reclaim its own quarantined label', async () => {
    const cookie = await cookieFor(a);
    const check = await http().post('/rest/v1/manager-workspaces/subdomain/check').set('Origin', ORIGIN).set('Cookie', cookie).send({ candidate: label });
    expect(check.body).toMatchObject({ available: true });
    const res = await http().patch('/rest/v1/manager-workspaces/me/subdomain').set('Origin', ORIGIN).set('Cookie', cookie).send({ subdomain: label });
    expect(res.status).toBe(200);
    expect(await lookup.lookup(label)).toMatchObject({ kind: 'workspace', canonicalLabel: label });
  });

  it("ABUSE (integration): A's session on B's REAL READY host → 404 WORKSPACE_HOST_MISMATCH; A's own host still works", async () => {
    const labelB = `${label}-b`;
    const created = await http().post('/rest/v1/manager-workspaces').set('Origin', ORIGIN).set('Cookie', await cookieFor(b)).send({ name: 'Contract B', subdomain: labelB });
    expect(created.status).toBe(201);
    expect(await lookup.lookup(labelB)).toMatchObject({ kind: 'workspace', canonicalLabel: labelB, organisationId: b.organisationId });
    const cookieA = await cookieFor(a);
    const own = await http().get('/rest/v1/manager-workspaces/me').set('Host', `${label}.rab.test`).set('Cookie', cookieA);
    expect(own.status).toBe(200);
    const wrong = await http().get('/rest/v1/manager-workspaces/me').set('Host', `${labelB}.rab.test`).set('Cookie', cookieA);
    expect(wrong.status).toBe(404);
    expect(wrong.body).toMatchObject({ code: 'WORKSPACE_HOST_MISMATCH' });
    expect(JSON.stringify(wrong.body)).not.toContain(labelB);
    expect(JSON.stringify(wrong.body)).not.toContain('Contract B');
  });
});
