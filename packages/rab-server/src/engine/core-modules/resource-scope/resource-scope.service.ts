import { ForbiddenException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Role, UserRole } from '../../../modules/identity/entities';
import { ManagerProfile, ManagerVenue } from '../../../modules/manager/entities';
import { AuthContext } from '../tenant/auth-context.interface';

export type ResourceScope = { kind: 'venue'; venueIds: string[] } | { kind: 'owner' };

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
 *
 * Stage 2A Phase 2 — no more `{kind: 'admin'}`. A platform admin outside an
 * active Admin Inspect session is scoped exactly like anyone else here
 * (resolves to `owner`, or `venue` if they also happen to hold that role) —
 * "Platform Admin is NOT a business role" and gets no operational-visibility
 * bypass baked into ordinary calls. Cross-workspace/cross-org visibility is
 * available only through Admin Inspect, which rebuilds `AuthContext` to an
 * explicit target's own identity before this service ever runs — so this
 * same resolution naturally reflects the TARGET's real scope while
 * inspecting, with zero special-casing needed here.
 */
@Injectable()
export class ResourceScopeService {
  async resolveTx(manager: EntityManager, ctx: Pick<AuthContext, 'organisationId' | 'userId'>): Promise<ResourceScope> {
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

  /**
   * The Private Workspace migration's `NULL = NULL` RLS behaviour (see
   * `SelectPreconditionForWritesRlsFix`/the workspace-scoped `WITH CHECK`
   * policies) means a Manager with no `ManagerWorkspace` yet cannot INSERT
   * ANY workspace-scoped operational row — the DB rejects it outright with a
   * raw, uncontrolled error. This is the central, pre-DB guard: called from
   * both `RequireWorkspaceGuard` (HTTP layer, before the request reaches a
   * controller method) and directly inside each affected service method
   * (defense-in-depth per CLAUDE.md's "layer 2 is the one people skip" rule
   * — jobs/CLI/other services call services directly, never through a
   * guard). Applies uniformly, with no CEO/Admin carve-out: no
   * `targetWorkspaceId` mechanism exists anywhere in this codebase (grep
   * confirmed), so there is no currently-working privileged flow to
   * preserve — inventing a speculative bypass here would be worse than a
   * uniform, honest rejection. A platform admin is, structurally, just a
   * Manager with their own real `ManagerWorkspace`, so they pass this check
   * naturally via their own onboarding, never via a special case.
   */
  assertHasWorkspace(ctx: Pick<AuthContext, 'workspaceId'>): void {
    if (!ctx.workspaceId) {
      throw new ForbiddenException(
        'Complete your Workspace setup before creating this — your account has no private Workspace yet.',
      );
    }
  }
}
