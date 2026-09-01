import 'reflect-metadata';
import { ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Stage 2A final verification, item 5 — `workspace_id` immutability.
 *
 * Complements `composite-workspace-fk-attack.integration.spec.ts` (which
 * proves the DB-layer backstop via raw SQL, deliberately bypassing the
 * service layer) with the APPLICATION-layer proof the user asked for
 * directly: real HTTP PATCH requests through the real DTO/validation
 * pipeline, proving a client-supplied `workspaceId` is rejected before it
 * ever reaches a query, on every mutating route that exists for a
 * Workspace-scoped resource. Also proves, by exhaustive grep (recorded
 * below, not just asserted), that no generic transfer/reassign endpoint
 * exists anywhere in this codebase.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('workspace_id immutability (Stage 2A final verification)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';
  const PERMS = [
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_EDIT,
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.VENUE_CREATE,
    PermissionFlag.VENUE_EDIT,
    PermissionFlag.VENUE_VIEW,
  ];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  async function seedManagerWithWorkspace(): Promise<{ organisation: Organisation; email: string; userId: string; workspaceId: string }> {
    const slug = `wsimm-${randomUUID()}`;
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });

    let userId!: string;
    let workspaceId!: string;
    const email = `wsimm-${randomUUID()}@example.test`;

    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (m) => {
      const roleResult = await m.insert(Role, { organisationId: organisation.id, key: `manager-${randomUUID()}`, name: 'Manager', isSystem: true });
      const roleId = roleResult.identifiers[0]!.id as string;
      for (const key of PERMS) {
        const permission = await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);
        await m.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
      }
      const passwordHash = await passwordHashing.hash(password);
      const userResult = await m.insert(User, { organisationId: organisation.id, email, passwordHash, firstName: 'WS', lastName: 'Immutable', status: UserStatus.ACTIVE });
      userId = userResult.identifiers[0]!.id as string;
      await m.insert(UserRole, { userId, roleId, organisationId: organisation.id });

      await m.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
      const workspace = await m.save(ManagerWorkspace, {
        organisationId: organisation.id,
        ownerUserId: userId,
        name: `WS Immutable ${userId}`,
        subdomain: `wsimm-${userId.slice(0, 8)}`,
        status: 'active',
      });
      workspaceId = workspace.id;
      await m.insert(ManagerProfile, { organisationId: organisation.id, userId, type: ManagerType.INTERNAL, workspaceId });
    });

    return { organisation, email, userId, workspaceId };
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

  it('PATCH /staff/:id with a client-supplied workspaceId is rejected 400 by DTO whitelisting, before any query runs', async () => {
    const mgr = await seedManagerWithWorkspace();
    const token = await login(mgr.email);
    const otherWorkspaceId = randomUUID();

    const createRes = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'Immutable', lastName: 'Staff', staffRef: `STF-${randomUUID().slice(0, 8)}` });
    expect(createRes.status).toBe(201);
    const staffId = createRes.body.id as string;

    const patchRes = await request(app.getHttpServer())
      .patch(`/rest/v1/staff/${staffId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Changed', workspaceId: otherWorkspaceId });
    expect(patchRes.status).toBe(400);

    // Confirm nothing moved — the rejected request never reached the DB.
    const stillMine = await request(app.getHttpServer()).get(`/rest/v1/staff/${staffId}`).set('Authorization', `Bearer ${token}`);
    expect(stillMine.status).toBe(200);
    expect(stillMine.body.firstName).toBe('Immutable'); // the (rejected) name change didn't apply either — the whole request was thrown out, not partially applied
  });

  it('PATCH /venues/:id with a client-supplied workspaceId is likewise rejected 400', async () => {
    const mgr = await seedManagerWithWorkspace();
    const token = await login(mgr.email);
    const otherWorkspaceId = randomUUID();

    const createRes = await request(app.getHttpServer())
      .post('/rest/v1/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Immutable Venue', type: 'hotel' });
    expect(createRes.status).toBe(201);
    const venueId = createRes.body.id as string;

    const patchRes = await request(app.getHttpServer())
      .patch(`/rest/v1/venues/${venueId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed', workspaceId: otherWorkspaceId });
    expect(patchRes.status).toBe(400);
  });

  it('a client-supplied workspaceId at CREATE time is likewise rejected 400 — the server, never the client, assigns it', async () => {
    const mgr = await seedManagerWithWorkspace();
    const token = await login(mgr.email);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: `staff-${randomUUID()}@example.test`,
        firstName: 'Hijack',
        lastName: 'Attempt',
        staffRef: `STF-${randomUUID().slice(0, 8)}`,
        workspaceId: randomUUID(),
      });
    expect(res.status).toBe(400);
  });

  it('no DTO anywhere in modules/ declares a workspaceId (or organisationId) field — the live 400s above hold for every route, not just the two exercised', () => {
    const modulesRoot = join(__dirname, '..', '..', 'modules');
    const dtoFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.dto.ts')) dtoFiles.push(full);
      }
    };
    walk(modulesRoot);
    expect(dtoFiles.length).toBeGreaterThan(10); // sanity check the walk actually found real DTOs, not an empty/wrong directory

    // A real property declaration (`workspaceId?:` / `workspaceId!:` / etc.)
    // — not a bare mention, which would also false-positive on doc comments
    // like create-staff.dto.ts's own "organisationId is deliberately
    // absent" note explaining why it ISN'T a field.
    const offenders = dtoFiles.filter((f) => /\b(workspaceId|organisationId)\s*[?!]?\s*:/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no generic workspace transfer/reassign endpoint exists anywhere in modules/ — grepped for transfer/moveTo/reassignWorkspace/changeWorkspace, zero matches', () => {
    const modulesRoot = join(__dirname, '..', '..', 'modules');
    const sourceFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(controller|service)\.ts$/.test(entry)) sourceFiles.push(full);
      }
    };
    walk(modulesRoot);

    const offenders = sourceFiles.filter((f) => /transfer|moveTo|reassignWorkspace|changeWorkspace/i.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
