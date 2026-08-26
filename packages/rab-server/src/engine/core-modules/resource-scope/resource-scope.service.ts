import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Role, UserRole } from '../../../modules/identity/entities';
import { ManagerProfile, ManagerVenue } from '../../../modules/manager/entities';
import { AuthContext } from '../tenant/auth-context.interface';
import { PlatformAdminService } from '../platform-admin/platform-admin.service';

export type ResourceScope = { kind: 'admin' } | { kind: 'venue'; venueIds: string[] } | { kind: 'owner' };

/**
 * "What data-scope shape does this caller's role imply?" — a structural
 * question used to build a `WHERE` clause, distinct from `PermissionsService`
 * (which only answers "does this user hold flag X"). Kept as its own small
 * service rather than folded into `PermissionsService`, which has no other
 * reason to know about `ManagerVenue`/`ManagerProfile`.
 *
 * Always re-derived fresh per call from `ctx.userId` — never trusts
 * `ctx.role` (the JWT `roles` claim can be stale within its 15-minute TTL
 * if role membership changes mid-session, same reasoning `PermissionsService`
 * already documents for permissions themselves).
 */
@Injectable()
export class ResourceScopeService {
  constructor(private readonly platformAdmin: PlatformAdminService) {}

  async resolveTx(manager: EntityManager, ctx: Pick<AuthContext, 'organisationId' | 'userId'>): Promise<ResourceScope> {
    if (await this.platformAdmin.isPlatformAdminTx(manager, ctx)) return { kind: 'admin' };

    const roleKeys = await manager
      .createQueryBuilder(UserRole, 'ur')
      .innerJoin(Role, 'r', 'r.id = ur.role_id')
      .where('ur.user_id = :userId', { userId: ctx.userId })
      .select('r.key', 'key')
      .getRawMany<{ key: string }>();

    if (roleKeys.some((r) => r.key === 'venue_manager')) {
      const rows = await manager
        .createQueryBuilder(ManagerVenue, 'mv')
        .innerJoin(ManagerProfile, 'mp', 'mp.id = mv.manager_profile_id')
        .where('mp.user_id = :userId', { userId: ctx.userId })
        .select('mv.venue_id', 'venueId')
        .getRawMany<{ venueId: string }>();
      return { kind: 'venue', venueIds: rows.map((r) => r.venueId) };
    }

    return { kind: 'owner' };
  }
}
