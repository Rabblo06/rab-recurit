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
    const slug = `pool-${label}-${randomUUID()}`;
    const email = `${label}-${randomUUID()}@example.test`;
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });

    let userId!: string;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (manager) => {
      const roleResult = await manager.insert(Role, { organisationId: organisation.id, key: `manager-${randomUUID()}`, name: 'Manager', isSystem: true });
      const roleId = roleResult.identifiers[0]!.id as string;
      for (const key of MANAGER_PERMS) {
        const permission = await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);
        await manager.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
      }
      const passwordHash = await passwordHashing.hash(password);
      const userResult = await manager.insert(User, {
        organisationId: organisation.id,
        email,
        passwordHash,
        firstName: label,
        lastName: 'Manager',
        status: UserStatus.ACTIVE,
      });
      userId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId, roleId, organisationId: organisation.id });

      // A real ManagerWorkspace — RequireWorkspaceGuard blocks Staff
      // creation for a Manager who hasn't onboarded one yet.
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
      await manager.insert(ManagerWorkspace, {
        organisationId: organisation.id,
        ownerUserId: userId,
        name: `Test Workspace ${userId}`,
        subdomain: `test-${userId.slice(0, 8)}`,
        status: 'active',
      });
    });
    return { organisation, email, userId };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
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
      const names = res.body.map((s: { firstName: string }) => s.firstName);
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
