import { ManagerType, OfferStatus, PermissionFlag } from '@rab/shared';
import { Inject, Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService, ResourceScope } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { MemberAccessPolicyService, ObjectAccessPolicy } from '../../identity/member-access/member-access-policy.service';
import { ManagerProfile } from '../../manager/entities/manager-profile.entity';
import { Venue } from '../../venue/entities/venue.entity';

export interface DashboardSummary {
  staffCount: number | null;
  activeStaffCount: number | null;
  managerCount: number | null;
  /**
   * The caller's own workspace's Venue Managers — exactly the population `GET /venue-managers` lists (same organisation,
   * same server-derived workspace, `type = venue`, every lifecycle state including invited/invite-expired, distinct profiles,
   * never paged), under the same `VENUE_MANAGER_CREATE` permission. `null` when that list is not available to the caller.
   */
  venueManagerCount: number | null;
  venueCount: number | null;
  activeOfferCount: number | null;
}

// Matches Dashboard.tsx's own existing "Active Offers" stat-card definition
// exactly (pending + staff_accepted only) — not `offersByStatus`'s separate
// chart categorization, which is a different breakdown for a different
// widget. Changing this would silently change what the stat card displays.
const ACTIVE_OFFER_STATUSES = [OfferStatus.PENDING, OfferStatus.STAFF_ACCEPTED];

// PHASE 5.5 — was `WHERE workspace_id = $1` alone (Step 7 of the Private
// Workspace migration reasoned that `workspace_id` and `created_by` are
// equivalent for the `owner` scope, "since a fully-onboarded Manager's own
// private ManagerWorkspace has exactly one member"). That equivalence was
// never a database-enforced invariant: `manager_profile.workspace_id` has
// only a plain index, no UNIQUE constraint (confirmed live), so nothing
// stops two `owner`-scope ManagerProfiles from sharing one workspace_id —
// today only reachable via a direct data anomaly (no onboarding path
// creates it), but a same-org, same-workspace Manager B holding this
// aggregate query's own required permission (`STAFF_VIEW`/`VENUE_VIEW`/
// `SCHEDULE_VIEW`) must never be able to infer Manager A's private counts
// ("Manager A has 27 active staff") purely by that coincidence. `created_by`
// is the SAME per-manager boundary every other manager-facing list already
// enforces (`staff.service.ts`/`venue.service.ts`/`offer.service.ts`'s own
// `list()`), added back here as a second, ANDed condition — tightening,
// never loosening, since in the current one-workspace-per-manager reality
// the two predicates already agree on every real row.
const OWNER_WORKSPACE_PREDICATE = `WHERE workspace_id = $1 AND created_by = $2`;

/**
 * Real `COUNT(*)` aggregation, never "download the list and take `.length`"
 * — replaces `Dashboard.tsx`'s previous pattern of fetching up to 500 full
 * Staff/Manager/Venue/Offer rows just to display four numbers, which also
 * silently under-counted past the 500-row page cap. Every count reuses the
 * IDENTICAL scoping each entity's own `list()` already enforces (never a
 * relaxed or reinvented rule) — see `staff.service.ts`/`manager.service.ts`/
 * `venue.service.ts`/`offer.service.ts` for the source of truth each count
 * here mirrors. A field a caller lacks the underlying list permission for is
 * `null`, never guessed or defaulted to 0 — the same "invisible, not wrong"
 * outcome their own list call already gets today (`ManagerController`'s
 * class-level `MANAGER_MANAGE` guard already 403s a plain Manager's
 * `GET /managers`; this endpoint must not accidentally leak that count via a
 * different door).
 */
@Injectable()
export class DashboardService {
  @Inject(MemberAccessPolicyService)
  private readonly memberAccess!: MemberAccessPolicyService;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
    private readonly permissions: PermissionsService,
  ) {}

  async getSummary(ctx: AuthContext): Promise<DashboardSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // All 4 checks share this one transaction/connection — this used to be
      // 4 separate runInTenantContext calls via Promise.all, which looks
      // parallel but each opened its OWN transaction (its own BEGIN +
      // set_config + COMMIT), so it was 4 simultaneous pool connections and
      // ~32 round trips just to decide what to count. See the 2026-09-25
      // performance audit in docs/HANDOFF.md.
      const canViewStaff = await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.STAFF_VIEW);
      const canViewManagers = await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.MANAGER_MANAGE);
      const canViewVenues = await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.VENUE_VIEW);
      const canViewSchedule = await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.SCHEDULE_VIEW);
      const canListVenueManagers = Boolean(ctx.workspaceId) && await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.VENUE_MANAGER_CREATE);

      const scope = await this.resourceScope.resolveTx(manager, ctx);
      // Custom workspace-members: counters respect object denial and record filters exactly like the lists do,
      // so a count can never reveal records the member cannot list. No-op for everyone else.
      const staffPolicy = await this.memberAccess.resolveTx(manager, ctx, 'staff');
      const venuePolicy = await this.memberAccess.resolveTx(manager, ctx, 'venue');
      const shiftPolicy = await this.memberAccess.resolveTx(manager, ctx, 'shift');

      const [staffCounts, managerCount, venueManagerCount, venueCount, activeOfferCount] = await Promise.all([
        canViewStaff && staffPolicy.canRead ? this.countStaff(manager, ctx, scope, staffPolicy) : Promise.resolve(null),
        canViewManagers
          ? manager.count(ManagerProfile, { where: { organisationId: ctx.organisationId! } })
          : Promise.resolve(null),
        canListVenueManagers
          ? manager.count(ManagerProfile, { where: { organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId!, type: ManagerType.VENUE } })
          : Promise.resolve(null),
        canViewVenues && venuePolicy.canRead ? this.countVenues(manager, ctx, scope, venuePolicy) : Promise.resolve(null),
        canViewSchedule && shiftPolicy.canRead ? this.countActiveOffers(manager, ctx, scope, shiftPolicy) : Promise.resolve(null),
      ]);

      return {
        staffCount: staffCounts?.total ?? null,
        activeStaffCount: staffCounts?.active ?? null,
        managerCount,
        venueManagerCount,
        venueCount,
        activeOfferCount,
      };
    });
  }

  /** Whose created_by these counters read: the caller, or — for a custom workspace-member only — their workspace owner. */
  private ownerOf(ctx: AuthContext, scope: ResourceScope): string {
    return scope.kind === 'owner' ? scope.ownerUserId : ctx.userId;
  }

  private async countStaff(manager: EntityManager, ctx: AuthContext, scope: ResourceScope, policy: ObjectAccessPolicy): Promise<{ total: number; active: number }> {
    const filter = this.memberAccess.rawWhere(policy, 'staff_profile', 3);
    const [{ total }] = await manager.query(
      `SELECT COUNT(*)::int AS total FROM staff_profile ${OWNER_WORKSPACE_PREDICATE} AND (${filter.sql})`,
      [ctx.workspaceId, this.ownerOf(ctx, scope), ...filter.positional],
    );
    const [{ active }] = await manager.query(
      `SELECT COUNT(*)::int AS active FROM staff_profile ${OWNER_WORKSPACE_PREDICATE} AND employment_status = 'active' AND (${filter.sql})`,
      [ctx.workspaceId, this.ownerOf(ctx, scope), ...filter.positional],
    );
    return { total, active };
  }

  private async countVenues(manager: EntityManager, ctx: AuthContext, scope: ResourceScope, policy: ObjectAccessPolicy): Promise<number> {
    if (scope.kind === 'venue') {
      if (scope.venueIds.length === 0) return 0;
      return manager.count(Venue, { where: { id: In(scope.venueIds) } });
    }
    const filter = this.memberAccess.rawWhere(policy, 'venue', 3);
    const [{ count }] = await manager.query(`SELECT COUNT(*)::int AS count FROM venue ${OWNER_WORKSPACE_PREDICATE} AND (${filter.sql})`, [
      ctx.workspaceId,
      this.ownerOf(ctx, scope),
      ...filter.positional,
    ]);
    return count;
  }

  private async countActiveOffers(manager: EntityManager, ctx: AuthContext, scope: ResourceScope, policy: ObjectAccessPolicy): Promise<number> {
    if (scope.kind === 'venue') {
      if (scope.venueIds.length === 0) return 0;
      const [{ count }] = await manager.query(
        `SELECT COUNT(*)::int AS count
           FROM job_offer o
           JOIN shift_assignment sa ON sa.id = o.shift_assignment_id
           JOIN shift s ON s.id = sa.shift_id
          WHERE o.status = ANY($1) AND s.venue_id = ANY($2::uuid[])`,
        [ACTIVE_OFFER_STATUSES, scope.venueIds],
      );
      return count;
    }
    if (policy.restricted) {
      // A member counts only offers on shifts their role's Shift record filter allows.
      const filter = this.memberAccess.rawWhere(policy, 's', 4);
      const [{ count }] = await manager.query(
        `SELECT COUNT(*)::int AS count
           FROM job_offer o
           JOIN shift_assignment sa ON sa.id = o.shift_assignment_id
           JOIN shift s ON s.id = sa.shift_id
          WHERE o.status = ANY($1) AND o.workspace_id = $2 AND o.created_by = $3 AND (${filter.sql})`,
        [ACTIVE_OFFER_STATUSES, ctx.workspaceId, this.ownerOf(ctx, scope), ...filter.positional],
      );
      return count;
    }
    // PHASE 5.5 — `created_by`, not just `workspace_id`; see this file's
    // own `OWNER_WORKSPACE_PREDICATE` doc comment.
    const [{ count }] = await manager.query(
      `SELECT COUNT(*)::int AS count FROM job_offer WHERE status = ANY($1) AND workspace_id = $2 AND created_by = $3`,
      [ACTIVE_OFFER_STATUSES, ctx.workspaceId, this.ownerOf(ctx, scope)],
    );
    return count;
  }
}
