import 'reflect-metadata';

// Account security step 1 — owner assertion #18 (host half): completing the second factor must not bypass the workspace
// host rule. The challenge is issued on the default host; presenting the code on ANOTHER workspace's host re-runs
// `AuthService.completeLogin` → `assertSignInHost` and is refused with no session. Same harness as
// workspace-host-routing.integration.spec.ts: a base domain at boot, the host-routing flags switched on by wrapping
// EnvironmentService.get, and an in-memory host-label registry (the pre-auth lookup); everything else is real.
const ORIGINAL = { WORKSPACE_BASE_DOMAIN: process.env.WORKSPACE_BASE_DOMAIN, CORS_ORIGINS: process.env.CORS_ORIGINS };
process.env.WORKSPACE_BASE_DOMAIN = 'rab.test';
process.env.CORS_ORIGINS = 'http://localhost:5173';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { EnvironmentVariables } from '../../engine/core-modules/environment/environment-variables';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceHostLookupService } from '../../engine/core-modules/workspace-host/workspace-host-lookup.service';
import { WorkspaceHostResolverService } from '../../engine/core-modules/workspace-host/workspace-host-resolver.service';
import { HostLabelResolution } from '../../engine/core-modules/workspace-host/workspace-host.types';
import { buildCorsOptionsDelegate, WorkspaceOriginTrustService } from '../../engine/core-modules/workspace-host/workspace-origin-trust.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { codeAt, earlyInStep, secretFromOtpauth } from './helpers/mfa-test-kit';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const DEFAULT_ORIGIN = 'http://localhost:5173';

describeIfDb('account security step 1 — #18: the code never bypasses the workspace host rule (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let owner: DataSource;
  let a: TestIdentity;
  let b: TestIdentity;
  let labelA: string;
  let labelB: string;
  const flags: Partial<Record<keyof EnvironmentVariables, boolean>> = { WORKSPACE_HOST_ROUTING_ENABLED: true, WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true };
  const registry = new Map<string, HostLabelResolution>();
  const lookup = { lookup: jest.fn(async (label: string) => registry.get(label) ?? ({ kind: 'unknown' } as const)) };
  const http = () => request(app.getHttpServer());
  const liveSessions = async (userId: string) => (await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL`, [userId]))[0].n as number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(WorkspaceHostLookupService).useValue(lookup).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    const env = moduleRef.get(EnvironmentService);
    const resolver = moduleRef.get(WorkspaceHostResolverService);
    const realGet = env.get.bind(env);
    jest.spyOn(env, 'get').mockImplementation(((key: keyof EnvironmentVariables) => (key in flags ? flags[key] : realGet(key))) as EnvironmentService['get']);
    app.use(cookieParser());
    app.enableCors(buildCorsOptionsDelegate(moduleRef.get(WorkspaceOriginTrustService), resolver, { credentials: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    const factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    a = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ashra' })).managers[0]!;
    b = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ashrb' })).managers[0]!;
    const rows = await owner.query(`SELECT id, subdomain FROM core.manager_workspace WHERE id = ANY($1::uuid[])`, [[a.workspaceId, b.workspaceId]]);
    labelA = rows.find((r: { id: string }) => r.id === a.workspaceId).subdomain;
    labelB = rows.find((r: { id: string }) => r.id === b.workspaceId).subdomain;
    registry.set(labelA, { kind: 'workspace', workspaceId: a.workspaceId!, organisationId: a.organisationId, canonicalLabel: labelA, displayName: null });
    registry.set(labelB, { kind: 'workspace', workspaceId: b.workspaceId!, organisationId: b.organisationId, canonicalLabel: labelB, displayName: null });
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
    process.env.WORKSPACE_BASE_DOMAIN = ORIGINAL.WORKSPACE_BASE_DOMAIN;
    process.env.CORS_ORIGINS = ORIGINAL.CORS_ORIGINS;
    if (ORIGINAL.WORKSPACE_BASE_DOMAIN === undefined) delete process.env.WORKSPACE_BASE_DOMAIN;
    if (ORIGINAL.CORS_ORIGINS === undefined) delete process.env.CORS_ORIGINS;
  });

  it('#18 (abuse): a challenge issued on the default host and completed on ANOTHER workspace\'s host is refused (404, no session); on the account\'s own host it signs in', async () => {
    const login = await http().post('/rest/v1/auth/login').set('Origin', DEFAULT_ORIGIN).send({ email: a.email, password: a.password });
    expect(login.status).toBe(200);
    const token = login.body.accessToken as string;
    const started = await http().post('/rest/v1/auth/mfa/enrolment').set('Authorization', `Bearer ${token}`).send({ currentPassword: a.password });
    expect(started.status).toBe(200);
    const secret = secretFromOtpauth(started.body.otpauthUri);
    await earlyInStep(8);
    expect((await http().post('/rest/v1/auth/mfa/enrolment/confirm').set('Authorization', `Bearer ${token}`).send({ code: codeAt(secret, -1) })).status).toBe(200);

    const before = await liveSessions(a.userId);
    const c1 = await http().post('/rest/v1/auth/login').set('Origin', DEFAULT_ORIGIN).send({ email: a.email, password: a.password });
    expect(c1.body.code).toBe('SECOND_FACTOR_REQUIRED');
    const foreign = await http()
      .post('/rest/v1/auth/mfa/challenge/verify')
      .set('Host', `${labelB}.rab.test`)
      .set('Origin', `http://${labelB}.rab.test`)
      .send({ challengeToken: c1.body.challengeToken, code: codeAt(secret, 0) });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('WORKSPACE_HOST_SIGN_IN_REFUSED');
    expect(([] as string[]).concat(foreign.headers['set-cookie'] ?? []).filter((c) => /crewflow_session=|rab_rt=/.test(c) && !/Max-Age=0|Expires=Thu, 01 Jan 1970/.test(c))).toEqual([]);
    expect(await liveSessions(a.userId)).toBe(before);
    // The refused challenge is spent; a fresh one completes on the account's OWN workspace host.
    const c2 = await http().post('/rest/v1/auth/login').set('Origin', DEFAULT_ORIGIN).send({ email: a.email, password: a.password });
    const own = await http()
      .post('/rest/v1/auth/mfa/challenge/verify')
      .set('Host', `${labelA}.rab.test`)
      .set('Origin', `http://${labelA}.rab.test`)
      .send({ challengeToken: c2.body.challengeToken, code: codeAt(secret, 1) });
    expect(own.status).toBe(200);
    expect(await liveSessions(a.userId)).toBe(before + 1);
    void b;
  });
});
