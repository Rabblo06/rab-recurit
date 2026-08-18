import { PermissionFlag, UserStatus } from '@rab/shared';
import { Command, CommandRunner } from 'nest-commander';
import { DataSource } from 'typeorm';

import {
  Organisation,
  Permission,
  Role,
  RolePermission,
  User,
  UserRole,
} from '../modules/identity/entities';
import { PasswordHashingService } from '../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';

/** No real user exists yet while the seed is creating one — a fixed, unambiguous placeholder for `rab.user_id`. */
const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Idempotent: safe to run repeatedly (dev bootstrap, CI fixtures). Upserts
 * the permission catalogue (global, no RLS), then a demo organisation +
 * super-admin role holding every permission + one active user. Role,
 * role_permission and user_role are FORCEd (IdentitySchema migration), so
 * everything after the organisation exists runs inside
 * `runInTenantContext` — the seed command connects as `rab_owner`, and
 * FORCE means even the owner can't skip RLS on those three tables without a
 * bound context.
 */
@Command({
  name: 'seed',
  description: 'Seed the permission catalogue and a demo organisation + super admin for local dev',
})
export class SeedCommand extends CommandRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly passwordHashing: PasswordHashingService,
  ) {
    super();
  }

  async run(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      for (const key of Object.values(PermissionFlag)) {
        const existing = await manager.findOne(Permission, { where: { key } });
        if (existing) continue;
        const [resource, action] = key.split('.');
        await manager.insert(Permission, { key, resource, action });
      }
    });

    const slug = process.env.SEED_ORG_SLUG ?? 'acme';
    let organisation = await this.dataSource.manager.findOne(Organisation, { where: { slug } });
    if (!organisation) {
      const result = await this.dataSource.manager.insert(Organisation, {
        name: process.env.SEED_ORG_NAME ?? 'Acme Staffing',
        slug,
      });
      organisation = await this.dataSource.manager.findOneByOrFail(Organisation, {
        id: result.identifiers[0]!.id as string,
      });
    }

    const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@acme.test';
    const password = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';
    const organisationId = organisation.id;

    const ctx: AuthContext = { organisationId, userId: SEED_ACTOR_ID, role: '' };
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      let role = await manager.findOne(Role, { where: { organisationId, key: 'super_admin' } });
      if (!role) {
        const result = await manager.insert(Role, {
          organisationId,
          key: 'super_admin',
          name: 'Super Admin',
          isSystem: true,
        });
        role = await manager.findOneByOrFail(Role, { id: result.identifiers[0]!.id as string });
      }

      // Backfill, not just grant-once-at-creation: the permission catalogue
      // grows over time (a new PermissionFlag added to @rab/shared), and an
      // already-seeded super_admin role from before that flag existed must
      // still end up holding it on a re-run — otherwise "seed is idempotent"
      // silently stops being true the moment a new permission ships.
      const [allPermissions, grantedRows] = await Promise.all([
        manager.find(Permission),
        manager.find(RolePermission, { where: { roleId: role.id } }),
      ]);
      const grantedPermissionIds = new Set(grantedRows.map((r) => r.permissionId));
      const missing = allPermissions.filter((p) => !grantedPermissionIds.has(p.id));
      if (missing.length > 0) {
        await manager.insert(
          RolePermission,
          missing.map((permission) => ({ roleId: role!.id, permissionId: permission.id, organisationId })),
        );
      }

      let user = await manager.findOne(User, { where: { organisationId, email } });
      if (!user) {
        const passwordHash = await this.passwordHashing.hash(password);
        const result = await manager.insert(User, {
          organisationId,
          email,
          passwordHash,
          firstName: 'Super',
          lastName: 'Admin',
          status: UserStatus.ACTIVE,
        });
        user = await manager.findOneByOrFail(User, { id: result.identifiers[0]!.id as string });
        await manager.insert(UserRole, { userId: user.id, roleId: role.id, organisationId });
      }
    });

    // eslint-disable-next-line no-console
    console.log(
      `Seeded organisation "${slug}" — login with organisationSlug="${slug}", email="${email}", password="${password}"`,
    );
  }
}
