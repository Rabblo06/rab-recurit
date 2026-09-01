import { OfferStatus, PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService, ResourceScope } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { ManagerProfile } from '../../manager/entities/manager-profile.entity';
import { Venue } from '../../venue/entities/venue.entity';

export interface DashboardSummary {
  staffCount: number | null;
  activeStaffCount: number | null;
  managerCount: number | null;
  venueCount: number | null;
  activeOfferCount: number | null;
}

// Matches Dashboard.tsx's own existing "Active Offers" stat-card definition
// exactly (pending + staff_accepted only) — not `offersByStatus`'s separate
// chart categorization, which is a different breakdown for a different
// widget. Changing this would silently change what the stat card displays.
const ACTIVE_OFFER_STATUSES = [OfferStatus.PENDING, OfferStatus.STAFF_ACCEPTED];

// Step 7 (Private Workspace migration): the `owner` scope's real boundary
// is `workspace_id`, matching the DB-level RLS dimension exactly — not
// `created_by` alone, which only ever matched it by coincidence for a
// fully-onboarded Manager (their own private ManagerWorkspace has exactly
// one member). No `created_by` fallback for a NULL `workspace_id` row: a
// row in that state is already, deliberately, admin-only-visible at the
// RLS layer itself (`OperationalWorkspaceRlsTransition`'s own documented
// design — "unresolved rows are admin-only... never a broadened RLS
// predicate"), and confirmed live that an app-layer fallback here couldn't
// reach such a row anyway — `staff_profile_tenant`'s own SELECT policy
// (`workspace_id = current_workspace()`) already excludes it upstream of
// whatever this query's own WHERE clause says, since `rab_app` is fully
// bound by that policy regardless of what this code asks for. `$1` is
// always `ctx.workspaceId` at every call site below; when it's `null` this
// resolves to `workspace_id = NULL`, which correctly matches nothing —
// consistent with "a caller who hasn't onboarded has no private data to
// aggregate yet" (and, separately, confirmed they structurally can't have
// created any such rows in the first place — `workspace_id = current_workspace()`
// in `WITH CHECK` rejects NULL-vs-NULL exactly like it rejects any other
// mismatch, so this state now only ever arises from legacy backfill gaps).
const OWNER_WORKSPACE_PREDICATE = `WHERE workspace_id = $1`;

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
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
    private readonly permissions: PermissionsService,
  ) {}

  async getSummary(ctx: AuthContext): Promise<DashboardSummary> {
    const [canViewStaff, canViewManagers, canViewVenues, canViewSchedule] = await Promise.all([
      this.permissions.userHasPermission(ctx, PermissionFlag.STAFF_VIEW),
      this.permissions.userHasPermission(ctx, PermissionFlag.MANAGER_MANAGE),
      this.permissions.userHasPermission(ctx, PermissionFlag.VENUE_VIEW),
      this.permissions.userHasPermission(ctx, PermissionFlag.SCHEDULE_VIEW),
    ]);

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);

      const [staffCounts, managerCount, venueCount, activeOfferCount] = await Promise.all([
        canViewStaff ? this.countStaff(manager, ctx) : Promise.resolve(null),
        canViewManagers
          ? manager.count(ManagerProfile, { where: { organisationId: ctx.organisationId! } })
          : Promise.resolve(null),
        canViewVenues ? this.countVenues(manager, ctx, scope) : Promise.resolve(null),
        canViewSchedule ? this.countActiveOffers(manager, ctx, scope) : Promise.resolve(null),
      ]);

      return {
        staffCount: staffCounts?.total ?? null,
        activeStaffCount: staffCounts?.active ?? null,
        managerCount,
        venueCount,
        activeOfferCount,
      };
    });
  }

  private async countStaff(manager: EntityManager, ctx: AuthContext): Promise<{ total: number; active: number }> {
    const [{ total }] = await manager.query(
      `SELECT COUNT(*)::int AS total FROM core.staff_profile ${OWNER_WORKSPACE_PREDICATE}`,
      [ctx.workspaceId],
    );
    const [{ active }] = await manager.query(
      `SELECT COUNT(*)::int AS active FROM core.staff_profile ${OWNER_WORKSPACE_PREDICATE} AND employment_status = 'active'`,
      [ctx.workspaceId],
    );
    return { total, active };
  }

  private async countVenues(manager: EntityManager, ctx: AuthContext, scope: ResourceScope): Promise<number> {
    if (scope.kind === 'venue') {
      if (scope.venueIds.length === 0) return 0;
      return manager.count(Venue, { where: { id: In(scope.venueIds) } });
    }
    const [{ count }] = await manager.query(`SELECT COUNT(*)::int AS count FROM core.venue ${OWNER_WORKSPACE_PREDICATE}`, [
      ctx.workspaceId,
    ]);
    return count;
  }

  private async countActiveOffers(manager: EntityManager, ctx: AuthContext, scope: ResourceScope): Promise<number> {
    if (scope.kind === 'venue') {
      if (scope.venueIds.length === 0) return 0;
      const [{ count }] = await manager.query(
        `SELECT COUNT(*)::int AS count
           FROM core.job_offer o
           JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id
           JOIN core.shift s ON s.id = sa.shift_id
          WHERE o.status = ANY($1) AND s.venue_id = ANY($2::uuid[])`,
        [ACTIVE_OFFER_STATUSES, scope.venueIds],
      );
      return count;
    }
    const [{ count }] = await manager.query(
      `SELECT COUNT(*)::int AS count FROM core.job_offer WHERE status = ANY($1) AND workspace_id = $2`,
      [ACTIVE_OFFER_STATUSES, ctx.workspaceId],
    );
    return count;
  }
}
