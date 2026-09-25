import { PermissionFlagType } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

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
 * access-token TTL expires. `userHasPermission` opens its own short-lived
 * `runInTenantContext` transaction for a standalone caller. A caller that
 * already holds a tenant-bound `EntityManager` (e.g. a handler checking
 * several flags in the course of one request) should call
 * `userHasPermissionTx` instead — same query, no extra
 * BEGIN/set_config/COMMIT round trips per check. This became a real cost
 * once a caller started checking 4 flags per request (dashboard.service.ts)
 * — see the 2026-09-25 performance audit in docs/HANDOFF.md.
 */
@Injectable()
export class PermissionsService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async userHasPermission(ctx: AuthContext, permission: PermissionFlagType): Promise<boolean> {
    return this.tenantContext.runInTenantContext(ctx, (manager) =>
      this.userHasPermissionTx(manager, ctx, permission),
    );
  }

  async userHasPermissionTx(
    manager: EntityManager,
    ctx: AuthContext,
    permission: PermissionFlagType,
  ): Promise<boolean> {
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
  }
}
