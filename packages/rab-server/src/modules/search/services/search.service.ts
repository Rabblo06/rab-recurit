import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService, ResourceScope } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { SearchDto } from '../dto/search.dto';

export interface SearchResult {
  id: string;
  name: string;
  type: 'Staff' | 'Manager' | 'Shift' | 'Offer' | 'Venue';
  group: 'People' | 'Shifts' | 'Offers' | 'Venues';
  to: string;
}

const DEFAULT_LIMIT_PER_TYPE = 8;
const MAX_LIMIT_PER_TYPE = 20;

/**
 * Postgres's default `LIKE`/`ILIKE` escape character is already `\` — a
 * caller-supplied `%` or `_` would otherwise act as a wildcard rather than a
 * literal character search, which is a correctness footgun (not an
 * injection risk on its own, since every value is still bound as a
 * parameter, never string-concatenated into the query), so it's escaped
 * here rather than passed through.
 */
function toIlikePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Step 7 (Private Workspace migration): the `owner` scope's real boundary
// is `workspace_id`, matching the DB-level RLS dimension exactly — see
// `dashboard.service.ts`'s identical constant for the full rationale,
// including why there's deliberately no `created_by` fallback for a NULL
// `workspace_id` row: it's already admin-only at the RLS layer itself
// (`OperationalWorkspaceRlsTransition`'s own design), and confirmed live
// that an app-layer fallback here couldn't reach such a row anyway — each
// table's own SELECT policy excludes it upstream of whatever WHERE clause
// this query adds. `paramIdx` is the 1-based index of the single param
// this predicate consumes (`ctx.workspaceId`).
function ownerWorkspacePredicate(workspaceCol: string, paramIdx: number): string {
  return `${workspaceCol} = $${paramIdx}`;
}

/**
 * Every resource type's WHERE clause mirrors the IDENTICAL scoping its own
 * `list()` method already enforces (`staff.service.ts`/`manager.service.ts`/
 * `venue.service.ts`/`scheduling.service.ts`/`offer.service.ts`) — search is
 * a different transport over the same authorized data, never a second,
 * looser authorization path. A resource type the caller lacks the
 * corresponding view permission for is silently omitted from results, the
 * same "invisible, not an error" outcome a direct list call already gets.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
    private readonly permissions: PermissionsService,
  ) {}

  async search(ctx: AuthContext, dto: SearchDto): Promise<SearchResult[]> {
    const limit = Math.min(dto.limit ?? DEFAULT_LIMIT_PER_TYPE, MAX_LIMIT_PER_TYPE);
    const pattern = toIlikePattern(dto.q.trim());
    if (pattern === '%%') return [];

    const [canViewStaff, canViewManagers, canViewVenues, canViewSchedule] = await Promise.all([
      this.permissions.userHasPermission(ctx, PermissionFlag.STAFF_VIEW),
      this.permissions.userHasPermission(ctx, PermissionFlag.MANAGER_MANAGE),
      this.permissions.userHasPermission(ctx, PermissionFlag.VENUE_VIEW),
      this.permissions.userHasPermission(ctx, PermissionFlag.SCHEDULE_VIEW),
    ]);

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);

      const [staff, managers, venues, shifts, offers] = await Promise.all([
        canViewStaff ? this.searchStaff(manager, ctx, scope, pattern, limit) : Promise.resolve([]),
        canViewManagers ? this.searchManagers(manager, pattern, limit) : Promise.resolve([]),
        canViewVenues ? this.searchVenues(manager, ctx, scope, pattern, limit) : Promise.resolve([]),
        canViewSchedule ? this.searchShifts(manager, ctx, scope, pattern, limit) : Promise.resolve([]),
        canViewSchedule ? this.searchOffers(manager, ctx, scope, pattern, limit) : Promise.resolve([]),
      ]);

      return [...staff, ...managers, ...shifts, ...offers, ...venues];
    });
  }

  private scopeVenueIds(scope: ResourceScope): string[] | null {
    return scope.kind === 'venue' ? scope.venueIds : null;
  }

  private async searchStaff(
    manager: EntityManager,
    ctx: AuthContext,
    scope: ResourceScope,
    pattern: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const params: unknown[] = [pattern, ctx.workspaceId, limit];
    const limitIdx = params.length;
    const rows = await manager.query(
      `SELECT sp.id, u.first_name, u.last_name
         FROM core.staff_profile sp
         JOIN core."user" u ON u.id = sp.user_id
        WHERE (u.first_name ILIKE $1 OR u.last_name ILIKE $1 OR u.email::text ILIKE $1 OR sp.staff_ref ILIKE $1)
          AND ${ownerWorkspacePredicate('sp.workspace_id', 2)}
        ORDER BY u.first_name ASC
        LIMIT $${limitIdx}`,
      params,
    );
    return rows.map((r: { id: string; first_name: string; last_name: string }) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      type: 'Staff' as const,
      group: 'People' as const,
      to: '/users',
    }));
  }

  private async searchManagers(manager: EntityManager, pattern: string, limit: number): Promise<SearchResult[]> {
    const rows = await manager.query(
      `SELECT mp.id, u.first_name, u.last_name
         FROM core.manager_profile mp
         JOIN core."user" u ON u.id = mp.user_id
        WHERE u.first_name ILIKE $1 OR u.last_name ILIKE $1 OR u.email::text ILIKE $1
        ORDER BY u.first_name ASC
        LIMIT $2`,
      [pattern, limit],
    );
    return rows.map((r: { id: string; first_name: string; last_name: string }) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      type: 'Manager' as const,
      group: 'People' as const,
      to: '/users',
    }));
  }

  private async searchVenues(
    manager: EntityManager,
    ctx: AuthContext,
    scope: ResourceScope,
    pattern: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const venueIds = this.scopeVenueIds(scope);
    if (venueIds && venueIds.length === 0) return [];

    let where = 'name ILIKE $1';
    const params: unknown[] = [pattern];
    if (scope.kind === 'venue' && venueIds) {
      where += ` AND id = ANY($${params.length + 1}::uuid[])`;
      params.push(venueIds);
    } else if (scope.kind === 'owner') {
      where += ` AND ${ownerWorkspacePredicate('workspace_id', params.length + 1)}`;
      params.push(ctx.workspaceId);
    }
    params.push(limit);

    const rows = await manager.query(
      `SELECT id, name FROM core.venue WHERE ${where} ORDER BY name ASC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r: { id: string; name: string }) => ({
      id: r.id,
      name: r.name,
      type: 'Venue' as const,
      group: 'Venues' as const,
      to: '/venues',
    }));
  }

  private async searchShifts(
    manager: EntityManager,
    ctx: AuthContext,
    scope: ResourceScope,
    pattern: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const venueIds = this.scopeVenueIds(scope);
    if (venueIds && venueIds.length === 0) return [];

    let where = 'v.name ILIKE $1';
    const params: unknown[] = [pattern];
    if (scope.kind === 'venue' && venueIds) {
      where += ` AND s.venue_id = ANY($${params.length + 1}::uuid[])`;
      params.push(venueIds);
    } else if (scope.kind === 'owner') {
      where += ` AND ${ownerWorkspacePredicate('s.workspace_id', params.length + 1)}`;
      params.push(ctx.workspaceId);
    }
    params.push(limit);

    const rows = await manager.query(
      `SELECT s.id, v.name AS venue_name, s.starts_at
         FROM core.shift s
         JOIN core.venue v ON v.id = s.venue_id
        WHERE ${where}
        ORDER BY s.starts_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((r: { id: string; venue_name: string; starts_at: Date }) => ({
      id: r.id,
      name: `${r.venue_name} · ${new Date(r.starts_at).toLocaleDateString('en-GB')}`,
      type: 'Shift' as const,
      group: 'Shifts' as const,
      to: '/shifts',
    }));
  }

  private async searchOffers(
    manager: EntityManager,
    ctx: AuthContext,
    scope: ResourceScope,
    pattern: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const venueIds = this.scopeVenueIds(scope);
    if (venueIds && venueIds.length === 0) return [];

    let where = '(u.first_name ILIKE $1 OR u.last_name ILIKE $1 OR v.name ILIKE $1)';
    const params: unknown[] = [pattern];
    if (scope.kind === 'venue' && venueIds) {
      where += ` AND s.venue_id = ANY($${params.length + 1}::uuid[])`;
      params.push(venueIds);
    } else if (scope.kind === 'owner') {
      where += ` AND ${ownerWorkspacePredicate('o.workspace_id', params.length + 1)}`;
      params.push(ctx.workspaceId);
    }
    params.push(limit);

    const rows = await manager.query(
      `SELECT o.id, v.name AS venue_name, u.first_name, u.last_name
         FROM core.job_offer o
         JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id
         JOIN core.shift s ON s.id = sa.shift_id
         JOIN core.venue v ON v.id = s.venue_id
         JOIN core.staff_profile sp ON sp.id = o.staff_profile_id
         JOIN core."user" u ON u.id = sp.user_id
        WHERE ${where}
        ORDER BY o.sent_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((r: { id: string; venue_name: string; first_name: string; last_name: string }) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name} → ${r.venue_name}`,
      type: 'Offer' as const,
      group: 'Offers' as const,
      to: '/offers',
    }));
  }
}
