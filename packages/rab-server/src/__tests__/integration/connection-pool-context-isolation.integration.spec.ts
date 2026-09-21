import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { rowsOf } from './helpers/response-shapes';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Stage 2A Phase 5/6 — the mandatory "connection pool" proof.
 * `TenantContextService.runInTenantContext` binds `rab.organisation_id`/
 * `rab.workspace_id`/`rab.user_id` via `set_config(..., true)` — the third
 * argument makes it transaction-LOCAL (`SET LOCAL` semantics), which is
 * supposed to make it structurally impossible for one request's tenant
 * context to leak into the next request that happens to reuse the same
 * pooled physical connection. That's a design argument, not a proof — this
 * test empirically exercises it: two Managers in two DIFFERENT
 * organisations (a stronger test than two Workspaces sharing one org — both
 * `organisation_id` AND `workspace_id` must never cross), firing many
 * INTERLEAVED concurrent requests through the real HTTP app (forcing real
 * connection-pool reuse, not just sequential round-trips) and asserting
 * every single response is scoped to its own caller, never the other's,
 * across the whole burst.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('connection pool context isolation (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';
  const MANAGER_PERMS = [PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_VIEW];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  async function seedOrgWithManager(label: string): Promise<{ organisation: Organisation; email: string; userId: string }> {
    // Canonical Internal Manager (role `manager`, ManagerProfile, own workspace — RequireWorkspaceGuard needs one).
    const organisation = await factory.createOrganisation(`pool-${label}`);
    const manager = await factory.createInternalManager(organisation, { permissions: MANAGER_PERMS, label });
    return { organisation, email: manager.email, userId: manager.userId };
  }

  async function login(email: string): Promise<string> {
    return factory.loginByEmail(email);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: passwordHashing });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('a burst of interleaved concurrent requests from two different organisations never cross-contaminates a pooled connection\'s tenant context', async () => {
    const orgA = await seedOrgWithManager('poola');
    const orgB = await seedOrgWithManager('poolb');
    const [tokenA, tokenB] = await Promise.all([login(orgA.email), login(orgB.email)]);

    const staffAName = `PoolStaffA-${randomUUID().slice(0, 8)}`;
    const staffBName = `PoolStaffB-${randomUUID().slice(0, 8)}`;
    const createA = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: `staff-a-${randomUUID()}@example.test`, firstName: staffAName, lastName: 'Test', staffRef: `STF-A-${randomUUID().slice(0, 8)}` });
    expect(createA.status).toBe(201);
    const createB = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ email: `staff-b-${randomUUID()}@example.test`, firstName: staffBName, lastName: 'Test', staffRef: `STF-B-${randomUUID().slice(0, 8)}` });
    expect(createB.status).toBe(201);

    // 40 requests, strictly alternating A/B, all fired concurrently — well
    // past this connection pool's default size, forcing real physical
    // connection reuse across different callers' requests.
    const requests: Array<Promise<{ token: string; org: 'A' | 'B'; res: request.Response }>> = [];
    for (let i = 0; i < 20; i++) {
      requests.push(
        request(app.getHttpServer())
          .get('/rest/v1/staff')
          .set('Authorization', `Bearer ${tokenA}`)
          .then((res) => ({ token: tokenA, org: 'A' as const, res })),
      );
      requests.push(
        request(app.getHttpServer())
          .get('/rest/v1/staff')
          .set('Authorization', `Bearer ${tokenB}`)
          .then((res) => ({ token: tokenB, org: 'B' as const, res })),
      );
    }
    const results = await Promise.all(requests);

    for (const { org, res } of results) {
      expect(res.status).toBe(200);
      const names = rowsOf<{ firstName: string }>(res.body).map((s) => s.firstName);
      if (org === 'A') {
        expect(names).toContain(staffAName);
        expect(names).not.toContain(staffBName);
      } else {
        expect(names).toContain(staffBName);
        expect(names).not.toContain(staffAName);
      }
    }
  }, 30_000);
});
