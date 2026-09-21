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
import { TestIdentityFactory } from './helpers/test-identities';

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
  let factory: TestIdentityFactory;
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
    const organisation = await factory.createOrganisation(label);
    return { organisationId: organisation.id };
  }

  /** A real Internal Manager with their own Workspace and the staff/manager permissions these tests need, able to log in and create staff. */
  async function seedManagerWithWorkspace(organisationId: string, label: string): Promise<{ email: string; userId: string; workspaceId: string }> {
    const manager = await factory.createInternalManager({ id: organisationId }, { permissions: ['staff.view', 'staff.create', 'manager.manage'], label });
    return { email: manager.email, userId: manager.userId, workspaceId: manager.workspaceId! };
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
