import 'reflect-metadata';
import { ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import {
  Organisation,
  OrganisationMember,
  Permission,
  Role,
  RolePermission,
  User,
  UserRole,
} from '../../modules/identity/entities';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Increment 1 of the User/membership decoupling (organisation-member.entity.ts):
 * `organisation_member` is purely additive and unread by any existing query,
 * so this suite only proves the table itself is correct — backfill coverage,
 * go-forward population from every User-creating path, and the same RLS
 * fail-closed guarantee every other tenant-scoped table gets.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('organisation-member (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const ownerPassword = 'correct horse battery staple 1!';
  const OWNER_PERMISSIONS = [
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.MANAGER_MANAGE,
  ];

  async function seedOrgWithOwner(): Promise<{ organisation: Organisation; ownerEmail: string }> {
    const slug = `test-${randomUUID()}`;
    const email = `owner-${randomUUID()}@example.test`;

    const insertResult = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, {
      id: insertResult.identifiers[0]!.id as string,
    });

    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
      async (manager) => {
        const permissions = await Promise.all(
          OWNER_PERMISSIONS.map(async (key) => {
            let permission = await manager.findOne(Permission, { where: { key } });
            if (!permission) {
              const [resource, action] = key.split('.');
              permission = await manager.save(Permission, { key, resource: resource!, action: action ?? key });
            }
            return permission;
          }),
        );

        const roleResult = await manager.insert(Role, {
          organisationId: organisation.id,
          key: `owner-${randomUUID()}`,
          name: 'Owner',
          isSystem: true,
        });
        const roleId = roleResult.identifiers[0]!.id as string;
        await manager.insert(
          RolePermission,
          permissions.map((permission) => ({ roleId, permissionId: permission.id, organisationId: organisation.id })),
        );

        const passwordHash = await passwordHashing.hash(ownerPassword);
        const userResult = await manager.insert(User, {
          organisationId: organisation.id,
          email,
          passwordHash,
          firstName: 'Test',
          lastName: 'Owner',
          status: UserStatus.ACTIVE,
        });
        const userId = userResult.identifiers[0]!.id as string;
        await manager.insert(UserRole, {
          userId,
          roleId,
          organisationId: organisation.id,
        });
        // A real ManagerWorkspace, otherwise this owner's resolved
        // workspaceId stays NULL forever and POST /staff's real INSERT
        // trips the combined org+workspace RLS WITH CHECK (NULL = NULL is
        // never true) — matching the fix already applied to this session's
        // other abuse-case specs. manager_workspace_write's own WITH CHECK
        // also requires owner_user_id = current_uid() — rebind it to the
        // real new user, not this transaction's throwaway bootstrap identity.
        await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
        const workspace = await manager.save(ManagerWorkspace, {
          organisationId: organisation.id,
          ownerUserId: userId,
          name: `Test Workspace ${userId}`,
          subdomain: `test-${userId.slice(0, 8)}`,
          status: 'active',
        });
        await manager.insert(ManagerProfile, {
          organisationId: organisation.id,
          userId,
          type: ManagerType.INTERNAL,
          workspaceId: workspace.id,
        });
      },
    );

    return { organisation, ownerEmail: email };
  }

  async function loginOwner(ownerEmail: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .send({ email: ownerEmail, password: ownerPassword });
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
    await adminDataSource.destroy();
    await app.close();
  });

  describe('backfill', () => {
    it('assigns exactly one organisation_member row per pre-existing user, matching (user_id, organisation_id)', async () => {
      const { organisation } = await seedOrgWithOwner();

      // Seed a second, plain user with no organisation_member row yet —
      // reproduces the "pre-existing user" state the migration's backfill
      // runs against, using the same backfill SQL the migration itself uses.
      const passwordHash = await passwordHashing.hash(ownerPassword);
      const preExisting = await adminDataSource.manager.insert(User, {
        organisationId: organisation.id,
        email: `preexisting-${randomUUID()}@example.test`,
        passwordHash,
        firstName: 'Pre',
        lastName: 'Existing',
        status: UserStatus.ACTIVE,
      });
      const preExistingUserId = preExisting.identifiers[0]!.id as string;

      // FORCE ROW LEVEL SECURITY means even the table-owning connection gets
      // zero rows with no tenant context bound — the same guarantee this
      // suite's own "fail-closed" tests assert below — so every read of this
      // table in this file goes through runInTenantContext, matching how
      // every other test in this codebase reads a FORCEd table.
      const readMember = (userId: string) =>
        tenantContext.runInTenantContext(
          { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
          (manager) => manager.findOne(OrganisationMember, { where: { userId, organisationId: organisation.id } }),
        );

      expect(await readMember(preExistingUserId)).toBeNull();

      // Owner connection deliberately (adminDataSource, rab_owner) — this
      // block simulates the migration's own backfill SQL, which genuinely
      // only ever runs as rab_owner (ALTER TABLE requires ownership; no
      // grant makes it possible for rab_app), not the app's runtime role.
      await adminDataSource.query(`ALTER TABLE core.organisation_member DISABLE ROW LEVEL SECURITY;`);
      await adminDataSource.query(`
        INSERT INTO core.organisation_member (organisation_id, user_id)
        SELECT organisation_id, id FROM core."user" WHERE id = $1
        ON CONFLICT (user_id, organisation_id) DO NOTHING;
      `, [preExistingUserId]);
      await adminDataSource.query(`ALTER TABLE core.organisation_member ENABLE ROW LEVEL SECURITY;`);
      await adminDataSource.query(`ALTER TABLE core.organisation_member FORCE ROW LEVEL SECURITY;`);

      const after = await readMember(preExistingUserId);
      expect(after).not.toBeNull();
      expect(after!.status).toBe('active');
    });

    it('re-running the backfill insert is a no-op (ON CONFLICT DO NOTHING), no duplicate rows', async () => {
      const { organisation } = await seedOrgWithOwner();
      const passwordHash = await passwordHashing.hash(ownerPassword);
      const seeded = await adminDataSource.manager.insert(User, {
        organisationId: organisation.id,
        email: `repeat-${randomUUID()}@example.test`,
        passwordHash,
        firstName: 'Repeat',
        lastName: 'Backfill',
        status: UserStatus.ACTIVE,
      });
      const userId = seeded.identifiers[0]!.id as string;

      // Owner connection deliberately — see the identical comment on the
      // sibling backfill test above.
      const runBackfill = async () => {
        await adminDataSource.query(`ALTER TABLE core.organisation_member DISABLE ROW LEVEL SECURITY;`);
        await adminDataSource.query(
          `INSERT INTO core.organisation_member (organisation_id, user_id)
             SELECT organisation_id, id FROM core."user" WHERE id = $1
             ON CONFLICT (user_id, organisation_id) DO NOTHING;`,
          [userId],
        );
        await adminDataSource.query(`ALTER TABLE core.organisation_member ENABLE ROW LEVEL SECURITY;`);
        await adminDataSource.query(`ALTER TABLE core.organisation_member FORCE ROW LEVEL SECURITY;`);
      };

      await runBackfill();
      await runBackfill();

      const rows = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
        (manager) => manager.find(OrganisationMember, { where: { userId, organisationId: organisation.id } }),
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('go-forward population', () => {
    it('POST /rest/v1/staff creates a matching active organisation_member row for the new user', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const createRes = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          email: `staff-${randomUUID()}@example.test`,
          firstName: 'New',
          lastName: 'Staff',
          staffRef: `STF-${randomUUID().slice(0, 8)}`,
        });
      expect(createRes.status).toBe(201);

      const [{ id: ownerWorkspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
        `SELECT id FROM core.manager_workspace WHERE organisation_id = $1`,
        [organisation.id],
      );
      const member = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: ownerWorkspaceId, userId: randomUUID(), role: '' },
        async (manager) => {
          const profile = await manager.findOneByOrFail(StaffProfile, { id: createRes.body.id });
          return manager.findOne(OrganisationMember, { where: { userId: profile.userId, organisationId: organisation.id } });
        },
      );
      expect(member).not.toBeNull();
      expect(member!.status).toBe('active');
    });

    it('POST /rest/v1/managers creates a matching active organisation_member row for the new user', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const createRes = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'New', lastName: 'Manager', type: 'internal' });
      expect(createRes.status).toBe(201);

      const member = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
        async (manager) => {
          const profile = await manager.findOneByOrFail(ManagerProfile, { id: createRes.body.id });
          return manager.findOne(OrganisationMember, { where: { userId: profile.userId, organisationId: organisation.id } });
        },
      );
      expect(member).not.toBeNull();
      expect(member!.status).toBe('active');
    });
  });

  describe('row-level security — the fail-closed guarantee', () => {
    it('a query with no tenant context bound returns zero rows for organisation_member', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      await loginOwner(ownerEmail); // owner's own User row already has a backfilled membership

      const rows = await dataSource.manager.find(OrganisationMember, { where: { organisationId: organisation.id } });
      expect(rows).toHaveLength(0);
    });

    it('an insert with no tenant context bound is rejected, not silently cross-tenant', async () => {
      const { organisation } = await seedOrgWithOwner();
      const passwordHash = await passwordHashing.hash(ownerPassword);
      const seeded = await adminDataSource.manager.insert(User, {
        organisationId: organisation.id,
        email: `unbound-${randomUUID()}@example.test`,
        passwordHash,
        firstName: 'Unbound',
        lastName: 'Insert',
        status: UserStatus.ACTIVE,
      });
      const userId = seeded.identifiers[0]!.id as string;

      await expect(
        dataSource.manager.insert(OrganisationMember, { organisationId: organisation.id, userId }),
      ).rejects.toThrow();
    });
  });
});
