import { PermissionFlagType } from '@rab/shared';
import { Injectable } from '@nestjs/common';

import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import {
  Permission,
  RolePermission,
  UserPermissionOverride,
  UserRole,
} from '../../../modules/identity/entities';

/**
 * Resolved server-side per request, never read off the JWT (§5.2) — a
 * revoked permission takes effect on the next request, not after a 15-min
 * access-token TTL expires. Each call opens its own short-lived
 * `runInTenantContext` transaction (RLS's `SET LOCAL` binding is
 * transaction-scoped — there's no framework-level hook that can hold one
 * transaction open across the whole guard→handler pipeline in Nest, so
 * every RLS-sensitive read/write gets its own transaction rather than
 * sharing one for the whole request). A Redis cache for this (§5.2 mentions
 * 30s) is a reasonable follow-up once it's actually a hot path, not before.
 */
@Injectable()
export class PermissionsService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async userHasPermission(ctx: AuthContext, permission: PermissionFlagType): Promise<boolean> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const override = await manager
        .createQueryBuilder(UserPermissionOverride, 'upo')
        .innerJoin(Permission, 'p', 'p.id = upo.permission_id')
        .where('upo.user_id = :userId', { userId: ctx.userId })
        .andWhere('p.key = :permission', { permission })
        .select('upo.effect', 'effect')
        .getRawOne<{ effect: 'grant' | 'revoke' }>();

      if (override?.effect === 'grant') return true;
      if (override?.effect === 'revoke') return false;

      const count = await manager
        .createQueryBuilder(UserRole, 'ur')
        .innerJoin(RolePermission, 'rp', 'rp.role_id = ur.role_id')
        .innerJoin(Permission, 'p', 'p.id = rp.permission_id')
        .where('ur.user_id = :userId', { userId: ctx.userId })
        .andWhere('p.key = :permission', { permission })
        .getCount();

      return count > 0;
    });
  }
}
