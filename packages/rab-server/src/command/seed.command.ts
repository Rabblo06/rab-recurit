import { PermissionFlag, UserStatus } from '@rab/shared';
import { Command, CommandRunner } from 'nest-commander';
import { DataSource } from 'typeorm';

import {
  Organisation,
  OrganisationMember,
  Permission,
  Role,
  RolePermission,
  User,
  UserRole,
} from '../modules/identity/entities';
import { AuditAction, AuditService } from '../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { inSecureOwnerTransaction, withSecureOwner } from './ops/secure-owner-acting';
import { seedSuccessMessage } from './seed-success-message';

/** No real user exists yet while the seed is creating one — a fixed, unambiguous placeholder for `rab.user_id`. */
const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Idempotent: safe to run repeatedly (dev bootstrap, CI fixtures). Upserts
 * the permission catalogue (global, no RLS), then a demo organisation +
 * super-admin role holding every permission + one active user. Role,
 * role_permission and user_role are FORCEd (IdentitySchema migration), so
 * everything after the organisation exists runs inside
 * `runInTenantContext` — the seed command connects as the owner login, and
 * FORCE means even the owner can't skip RLS on those three tables without a
 * bound context.
 *
 * O-2: since M-T1 `organisation` and `platform_admin` are FORCE'd with an
 * owner-only definer policy too, so the login acting as itself can neither
 * find nor create the organisation (no tenant context exists before it does)
 * nor write the platform_admin row (its write policy demands an acting
 * admin). Those two steps act as the table owner rab_secure_owner
 * (`ops/secure-owner-acting.ts`, transaction-local); everything else is
 * unchanged.
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
    private readonly auditService: AuditService,
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
    const organisation = await inSecureOwnerTransaction(this.dataSource, { readOnly: false }, async (manager) => {
      const found = await manager.findOne(Organisation, { where: { slug } });
      if (found) return found;
      const result = await manager.insert(Organisation, {
        name: process.env.SEED_ORG_NAME ?? 'Acme Staffing',
        slug,
      });
      return manager.findOneByOrFail(Organisation, { id: result.identifiers[0]!.id as string });
    });

    const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@acme.test';
    // No default. A hard-coded seed password is a shared credential; the operator supplies a generated one for this run.
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (!password || password.length < 12) {
      throw new Error('SEED_ADMIN_PASSWORD is required (at least 12 characters). Generate one per run; it is never a default.');
    }
    const organisationId = organisation.id;

    const ctx: AuthContext = { organisationId, workspaceId: null, userId: SEED_ACTOR_ID, role: '' };
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      let role = await manager.findOne(Role, { where: { organisationId, key: 'super_admin' } });
      if (!role) {
        const result = await manager.insert(Role, {
          organisationId,
          key: 'super_admin',
          name: 'Administrator',
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
          firstName: process.env.SEED_ADMIN_FIRST_NAME ?? 'Alex',
          lastName: process.env.SEED_ADMIN_LAST_NAME ?? 'Morgan',
          status: UserStatus.ACTIVE,
        });
        user = await manager.findOneByOrFail(User, { id: result.identifiers[0]!.id as string });
        await manager.insert(UserRole, { userId: user.id, roleId: role.id, organisationId });
        // Increment 1 of the User/membership decoupling (see
        // organisation-member.entity.ts) — not read anywhere yet, just kept
        // complete going forward so a later cutover has no backfill gap.
        await manager.insert(OrganisationMember, { organisationId, userId: user.id });
        // `core.platform_admin` has no organisation_id at all (Stage 2A
        // Phase 2 — genuinely platform-wide, not "first user of this org").
        // Written as the table owner (no acting admin exists yet), then back
        // to the login — the same path `grant-platform-admin.command.ts` uses.
        const granted = await withSecureOwner(manager, (m) =>
          m.query<Array<{ user_id: string }>>(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`, [
            user!.id,
          ]),
        );
        // Every platform_admin grant path leaves an audit entry; back on the login, tenant context bound (O-2 review).
        if (granted.length === 1) {
          await this.auditService.record(manager, { organisationId, userId: user.id }, AuditAction.PLATFORM_ADMIN_GRANTED, {
            targetUserId: user.id,
            actorUserId: null,
            metadata: { via: 'seed' },
          });
        }
      }
    });

    // eslint-disable-next-line no-console
    console.log(seedSuccessMessage({ slug, email }));
  }
}
