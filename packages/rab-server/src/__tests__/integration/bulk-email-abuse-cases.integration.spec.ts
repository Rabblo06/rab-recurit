import 'reflect-metadata';
import { ManagerType, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { EmailOutbox, Organisation, Role, User, UserRole } from '../../modules/identity/entities';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * `POST /staff/bulk-email` and `POST /managers/bulk-email` — the Users
 * page's new bulk "Send Email" action. `dto.userIds` are never trusted as
 * authorization on their own; both endpoints re-derive the caller's real
 * scope (creator-private for Staff, org-wide for Managers — the same rule
 * `list()`/`get()` already enforce) and silently drop any requested id
 * outside it, matching this repo's "404 not 403, never disclose existence"
 * convention extended to a filtered bulk operation.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('bulk email abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';

  async function withContext<T>(ctx: { organisationId: string; workspaceId: string | null; userId: string }, fn: (manager: DataSource['manager']) => Promise<T>): Promise<T> {
    return dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ctx.organisationId]);
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [ctx.workspaceId ?? '']);
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ctx.userId]);
      await manager.query(`SELECT set_config('rab.role', '', true)`);
      return fn(manager);
    });
  }

  async function seedOrg(label: string): Promise<{ organisationId: string }> {
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: `${label}-${randomUUID()}`, slug: `${label}-${randomUUID()}` });
    return { organisationId: orgInsert.identifiers[0]!.id as string };
  }

  /** A real Manager with their own Workspace, full staff/manager permissions, able to log in and create staff. */
  async function seedManagerWithWorkspace(organisationId: string, label: string): Promise<{ email: string; userId: string; workspaceId: string }> {
    const email = `${label}-${randomUUID()}@example.test`;
    let userId!: string;
    let workspaceId!: string;
    await withContext({ organisationId, workspaceId: null, userId: randomUUID() }, async (manager) => {
      const roleResult = await manager.insert(Role, {
        organisationId,
        key: `manager-${label}-${randomUUID()}`,
        name: 'Manager',
        isSystem: true,
      });
      const roleId = roleResult.identifiers[0]!.id as string;
      const hash = await passwordHashing.hash(password);
      const userResult = await manager.insert(User, { organisationId, email, passwordHash: hash, firstName: label, lastName: 'Mgr', status: UserStatus.ACTIVE });
      userId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId, roleId, organisationId });
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId,
        ownerUserId: userId,
        name: `${label} Workspace ${userId}`,
        subdomain: `${label}-${userId.slice(0, 8)}`,
        status: 'active',
      });
      workspaceId = workspace.id;
      await manager.insert(ManagerProfile, { organisationId, userId, type: ManagerType.INTERNAL, workspaceId });
    });
    // Grant every permission these tests need directly against the shared global catalogue (avoids re-deriving ROLE_DEFS here).
    const perms = ['staff.view', 'staff.create', 'manager.manage'];
    await withContext({ organisationId, workspaceId, userId }, async (manager) => {
      const role = await manager.query<[{ id: string }]>(`SELECT role_id AS id FROM core.user_role WHERE user_id = $1 LIMIT 1`, [userId]);
      const roleId = role[0]!.id;
      for (const key of perms) {
        const [resource, action] = key.split('.');
        let permRows = await manager.query<Array<{ id: string }>>(`SELECT id FROM core.permission WHERE key = $1`, [key]);
        if (permRows.length === 0) {
          await manager.query(`INSERT INTO core.permission (key, resource, action) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`, [key, resource, action]);
          permRows = await manager.query<Array<{ id: string }>>(`SELECT id FROM core.permission WHERE key = $1`, [key]);
        }
        await manager.query(`INSERT INTO core.role_permission (role_id, permission_id, organisation_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [roleId, permRows[0]!.id, organisationId]);
      }
    });
    return { email, userId, workspaceId };
  }

  /** A real, active Staff member created by (owned by) the given manager. */
  async function seedStaffOwnedBy(organisationId: string, workspaceId: string, ownerUserId: string, label: string): Promise<{ id: string; email: string }> {
    let staffProfileId!: string;
    let staffEmail!: string;
    await withContext({ organisationId, workspaceId, userId: ownerUserId }, async (manager) => {
      staffEmail = `${label}-${randomUUID()}@example.test`;
      const hash = await passwordHashing.hash(password);
      const userResult = await manager.insert(User, { organisationId, email: staffEmail, passwordHash: hash, firstName: label, lastName: 'Staff', status: UserStatus.ACTIVE });
      const staffUserId = userResult.identifiers[0]!.id as string;
      const profile = await manager.save(StaffProfile, {
        organisationId,
        userId: staffUserId,
        staffRef: `STF-${label}-${randomUUID().slice(0, 8)}`,
        createdBy: ownerUserId,
        workspaceId,
      });
      staffProfileId = profile.id;
    });
    return { id: staffProfileId, email: staffEmail };
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

  it('Manager A can bulk-email their OWN staff — a durable outbox row is created per recipient', async () => {
    const { organisationId } = await seedOrg('bea');
    const a = await seedManagerWithWorkspace(organisationId, 'a');
    const s1 = await seedStaffOwnedBy(organisationId, a.workspaceId, a.userId, 's1');
    const s2 = await seedStaffOwnedBy(organisationId, a.workspaceId, a.userId, 's2');
    const token = await login(a.email);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff/bulk-email')
      .set('Authorization', `Bearer ${token}`)
      .send({ userIds: [s1.id, s2.id], subject: 'Hello team', message: 'This is a test message.' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ queued: 2, skipped: 0 });

    const outboxRows = await withContext({ organisationId, workspaceId: a.workspaceId, userId: a.userId }, (m) =>
      m.find(EmailOutbox, { where: { recipientEmail: s1.email } }),
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.renderedSubject).toBe('Hello team');
  });

  it('Manager A CANNOT bulk-email Manager B\'s staff — silently skipped, not a 403/404 error', async () => {
    const { organisationId } = await seedOrg('beb');
    const a = await seedManagerWithWorkspace(organisationId, 'a');
    const b = await seedManagerWithWorkspace(organisationId, 'b');
    const bStaff = await seedStaffOwnedBy(organisationId, b.workspaceId, b.userId, 'bstaff');
    const tokenA = await login(a.email);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff/bulk-email')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ userIds: [bStaff.id], subject: 'Hello', message: 'Test.' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ queued: 0, skipped: 1 });

    const outboxRows = await withContext({ organisationId, workspaceId: b.workspaceId, userId: b.userId }, (m) =>
      m.find(EmailOutbox, { where: { recipientEmail: bStaff.email } }),
    );
    expect(outboxRows).toHaveLength(0);
  });

  it('a cross-organisation id is silently skipped, never leaked across tenants', async () => {
    const orgA = await seedOrg('beca');
    const orgB = await seedOrg('becb');
    const a = await seedManagerWithWorkspace(orgA.organisationId, 'a');
    const b = await seedManagerWithWorkspace(orgB.organisationId, 'b');
    const bStaff = await seedStaffOwnedBy(orgB.organisationId, b.workspaceId, b.userId, 'bstaff');
    const tokenA = await login(a.email);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff/bulk-email')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ userIds: [bStaff.id], subject: 'Hello', message: 'Test.' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ queued: 0, skipped: 1 });
  });

  it('Manager A CAN bulk-email Manager B (managers are org-wide visible, matching list())', async () => {
    const { organisationId } = await seedOrg('bemgr');
    const a = await seedManagerWithWorkspace(organisationId, 'a');
    const b = await seedManagerWithWorkspace(organisationId, 'b');
    const tokenA = await login(a.email);

    // ManagerProfile id (not User id) is the id the Users list/table actually exposes.
    const bProfile = await withContext({ organisationId, workspaceId: a.workspaceId, userId: a.userId }, (m) =>
      m.query<[{ id: string }]>(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [b.userId]),
    );

    const res = await request(app.getHttpServer())
      .post('/rest/v1/managers/bulk-email')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ userIds: [bProfile[0]!.id], subject: 'Hello manager', message: 'Test.' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ queued: 1, skipped: 0 });
  });

  it('a request body carrying more than 50 ids is rejected (400)', async () => {
    const { organisationId } = await seedOrg('becap');
    const a = await seedManagerWithWorkspace(organisationId, 'a');
    const token = await login(a.email);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff/bulk-email')
      .set('Authorization', `Bearer ${token}`)
      .send({ userIds: Array.from({ length: 51 }, () => randomUUID()), subject: 'x', message: 'x' });

    expect(res.status).toBe(400);
  });
});
