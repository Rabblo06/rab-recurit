// Every cache flag ON before Nest's ConfigModule reads process.env (frozen at AppModule import).
process.env.AUTH_CONTEXT_CACHE_ENABLED = 'true';
process.env.USER_SESSION_CACHE_ENABLED = 'true';
process.env.CORE_ENTITY_CACHE_ENABLED = 'true';
process.env.WORKSPACE_METADATA_CACHE_ENABLED = 'true';
process.env.METADATA_L1_CACHE_ENABLED = 'true';
process.env.METADATA_L1_CACHE_TTL_MS = '5000'; // the longest allowed L1 TTL: revocation must still be immediate

import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { MetadataL1CacheService } from '../../engine/core-modules/entity-cache/metadata-l1-cache.service';
import { PERMISSION_CATALOGUE_CACHE_VERSION } from '../../engine/core-modules/entity-cache/permission-catalogue-cache.service';
import { WorkspaceHostResolverService } from '../../engine/core-modules/workspace-host/workspace-host-resolver.service';
import { CoreEntityCacheService } from '../../engine/core-modules/entity-cache/core-entity-cache.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Wave 5 lane OPS — "the L1 never delays a revocation". With EVERY cache on (auth context, user session, core entity,
 * workspace metadata, and the new in-process L1 at its maximum 5 s TTL), a permission revoke and an organisation
 * suspension take effect on the VERY NEXT request — no sleep, no TTL wait — because authorisation data never enters the
 * L1 (only the static catalogue / routing metadata do) and the per-request authorisation path stays PostgreSQL-
 * authoritative (security version vector).
 */
const RUN = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfDb('L1 metadata cache never delays revocation (all caches on)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let l1: MetadataL1CacheService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    l1 = moduleRef.get(MetadataL1CacheService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    const start = Date.now();
    while (!l1.isLive() && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 25));
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('sanity: the L1 is enabled and live in this process', () => {
    expect(l1.isEnabled()).toBe(true);
    expect(l1.isLive()).toBe(true);
  });

  it('the permission catalogue is served from L1 on repeat, and revoking role.view denies the very next request', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: ['role.view', 'staff.view'] });
    const manager = managers[0]!;
    const token = await factory.login(manager);

    const first = await http().get('/rest/v1/roles/permissions').set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.length).toBeGreaterThan(30);
    const hitsBefore = l1.stats().hits;
    const second = await http().get('/rest/v1/roles/permissions').set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(l1.stats().hits).toBeGreaterThan(hitsBefore); // the catalogue came from process memory

    // The exact write RoleService.setPermissions performs: drop the grant, bump role.permission_version.
    const [{ id: roleId }] = await adminDataSource.query(`SELECT id FROM core.role WHERE key = $1 AND organisation_id = $2`, [manager.roleKey, organisation.id]);
    const [{ id: permId }] = await adminDataSource.query(`SELECT id FROM core.permission WHERE key = 'role.view'`);
    await adminDataSource.query(`DELETE FROM core.role_permission WHERE role_id = $1 AND permission_id = $2`, [roleId, permId]);
    await adminDataSource.query(`UPDATE core.role SET permission_version = permission_version + 1 WHERE id = $1`, [roleId]);

    const denied = await http().get('/rest/v1/roles/permissions').set('Authorization', `Bearer ${token}`);
    expect(denied.status).toBe(403); // immediately…
    expect(l1.get('permission_catalogue', PERMISSION_CATALOGUE_CACHE_VERSION)).toBeDefined(); // …while the catalogue is still warm in L1
  });

  it('organisation suspension: a session of the suspended organisation is refused on the very next request', async () => {
    const adminOrg = await factory.createOrganisation();
    const admin = await factory.createInternalManager(adminOrg, { permissions: 'all', label: 'admin' });
    await factory.grantPlatformAdmin(admin.userId);
    const target = await factory.createOrganisationWithManagers(1, { permissions: ['role.view'] });
    const targetToken = await factory.login(target.managers[0]!);
    expect((await http().get('/rest/v1/roles/permissions').set('Authorization', `Bearer ${targetToken}`)).status).toBe(200);

    const adminToken = await factory.login(admin);
    const suspended = await http()
      .post(`/rest/v1/admin/organisations/${target.organisation.id}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'wave5 L1 revocation test', confirmSlug: target.organisation.slug });
    expect(suspended.status).toBe(201);

    const after = await http().get('/rest/v1/roles/permissions').set('Authorization', `Bearer ${targetToken}`);
    expect(after.status).toBe(401);
  });

  it('suspension drops every cached host label from the L1 (routing context converges at once, not after the TTL)', async () => {
    const cache = app.get(CoreEntityCacheService);
    const resolver = app.get(WorkspaceHostResolverService);
    const epoch = await cache.currentEpoch('workspace_host_map', 'all');
    await cache.getOrFetch('workspace_host_label', `${epoch}:wave5-l1-probe`, async () => ({ r: { kind: 'unknown' } }), true, () => 10);
    expect(l1.get('workspace_host_label', `${epoch}:wave5-l1-probe`)).toBeDefined();
    await resolver.invalidateAll(); // what OrganisationSuspensionService.suspend/reactivate call after commit
    expect(l1.get('workspace_host_label', `${epoch}:wave5-l1-probe`)).toBeUndefined();
  });

  it('authorisation kinds are structurally excluded from the L1', () => {
    // A call with a non-allowlisted kind is a type error; at runtime it is refused as well.
    expect(l1.ticket('auth_context' as never, 'x')).toBeNull();
    expect(l1.get('user_session' as never, 'x')).toBeUndefined();
  });
});
