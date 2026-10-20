import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { PermissionFlag } from '@rab/shared';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { RealtimeEventService, RealtimeEventType } from '../../../engine/core-modules/realtime/realtime-event.service';
import { StaffService } from '../../staff/services/staff.service';
import { VenueService } from '../../venue/services/venue.service';
import { SchedulingService } from '../../scheduling/services/scheduling.service';
import { ManagerService } from '../../manager/services/manager.service';
import { NavigationItem, NavigationLayoutInvalid, summariseChange, validateNavigationItems } from '../navigation-layout.validation';
import { SaveNavigationLayoutDto } from '../dto/save-navigation-layout.dto';

export interface NavigationLayoutView {
  scope: 'personal';
  revision: number;
  items: NavigationItem[];
  updatedAt: string | null;
  /** True when this response is the already-committed result of a retried request (lost response), not a new write. */
  replayed?: boolean;
}

interface Row { revision: number; items: NavigationItem[]; last_request_id: string | null; updated_at: Date }

/**
 * Personal navigation layout ("Your navigation"): read and save the caller's OWN layout for the caller's server-derived
 * workspace. Layer 2 of the five-layer rule — every check here runs regardless of which route/job calls it:
 *  - workspace required; Admin Inspect may read but never write; the owner/workspace/organisation come from `ctx` only.
 *  - payload re-validated (allowlists, bounds, folders, links) and every referenced record re-checked through the owning
 *    service's own scoped `get` (404/403 there ⇒ refused here) — at SAVE time, not just when picked in the UI.
 *  - one transaction: optimistic revision check (UPDATE … WHERE revision = base), audit row, durable realtime event for
 *    the same user's other tabs. Any failure rolls all of it back; a stale base revision is a 409.
 *  - retried request (same requestId as the committed revision) returns the committed result, never a second write.
 * RLS (navigation_layout_own: org + workspace + user = transaction-local context, FORCE) is the database layer.
 * No cache: a single-row primary-key read needs none, so there is nothing to invalidate or keep coherent.
 */
@Injectable()
export class NavigationLayoutService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeEventService,
    private readonly staff: StaffService,
    private readonly venues: VenueService,
    private readonly scheduling: SchedulingService,
    private readonly managers: ManagerService,
  ) {}

  async get(ctx: AuthContext): Promise<NavigationLayoutView> {
    this.resourceScope.assertHasWorkspace(ctx);
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const [row] = await manager.query<Row[]>(
        `SELECT revision, items, last_request_id, updated_at FROM core.navigation_layout
          WHERE organisation_id = $1 AND workspace_id = $2 AND user_id = $3`,
        [ctx.organisationId, ctx.workspaceId, ctx.userId],
      );
      return row ? this.view(row) : { scope: 'personal', revision: 0, items: [], updatedAt: null };
    });
  }

  async save(ctx: AuthContext, dto: SaveNavigationLayoutDto): Promise<NavigationLayoutView> {
    this.resourceScope.assertHasWorkspace(ctx);
    if (ctx.inspectedBy) throw new ForbiddenException('Navigation cannot be changed while inspecting another account.');
    let items: NavigationItem[];
    try {
      items = validateNavigationItems(dto.items);
    } catch (e) {
      if (e instanceof NavigationLayoutInvalid) throw new BadRequestException({ message: 'The layout is not valid.', problems: e.problems });
      throw e;
    }
    await this.revalidateReferences(ctx, items);

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const params = [ctx.organisationId, ctx.workspaceId, ctx.userId];
      const [before] = await manager.query<Row[]>(
        `SELECT revision, items, last_request_id, updated_at FROM core.navigation_layout
          WHERE organisation_id = $1 AND workspace_id = $2 AND user_id = $3 FOR UPDATE`,
        params,
      );
      // Idempotent replay: this exact request already produced the current revision (its response was lost).
      if (before && before.last_request_id === dto.requestId) return { ...this.view(before), replayed: true };
      const currentRevision = before?.revision ?? 0;
      if (currentRevision !== dto.baseRevision) {
        throw new ConflictException({ message: 'Your navigation was changed somewhere else. Review the latest version before saving.', currentRevision });
      }
      // TypeORM's postgres driver returns `[rows, affectedCount]` for UPDATE … RETURNING and plain `rows` for INSERT.
      const rows = before
        ? (await manager.query<[Row[], number]>(
            `UPDATE core.navigation_layout
                SET items = $4::jsonb, revision = revision + 1, last_request_id = $5, updated_at = now()
              WHERE organisation_id = $1 AND workspace_id = $2 AND user_id = $3 AND revision = $6
              RETURNING revision, items, last_request_id, updated_at`,
            [...params, JSON.stringify(items), dto.requestId, dto.baseRevision],
          ))[0]
        : await manager.query<Row[]>(
            `INSERT INTO core.navigation_layout (organisation_id, workspace_id, user_id, items, revision, last_request_id)
             VALUES ($1, $2, $3, $4::jsonb, 1, $5)
             ON CONFLICT (organisation_id, workspace_id, user_id) DO NOTHING
             RETURNING revision, items, last_request_id, updated_at`,
            [...params, JSON.stringify(items), dto.requestId],
          );
      // A concurrent first save (or update) won the race between our read and write.
      if (!rows[0]) throw new ConflictException({ message: 'Your navigation was changed somewhere else. Review the latest version before saving.' });
      const saved = rows[0];
      await this.audit.record(manager, ctx, AuditAction.NAVIGATION_LAYOUT_SAVED, {
        entityType: 'navigation_layout',
        entityId: ctx.userId,
        metadata: { scope: 'personal', revision: saved.revision, ...summariseChange(before?.items ?? [], items) },
      });
      await this.realtime.record(manager, {
        organisationId: ctx.organisationId!,
        workspaceId: ctx.workspaceId,
        targetUserId: ctx.userId,
        eventKey: `navigation_layout:${ctx.workspaceId}:${ctx.userId}:${saved.revision}`,
        eventType: RealtimeEventType.NAVIGATION_LAYOUT_SAVED,
        entityType: 'navigation_layout',
        entityId: ctx.userId,
        payload: { revision: saved.revision },
      });
      return this.view(saved);
    });
  }

  /**
   * Every referenced record must be one the caller can open RIGHT NOW, via the owning service's own scoped read (the same
   * check its detail route makes). Object shortcuts that need a permission (Audit Log) are re-checked too. Nothing is
   * granted: opening a saved shortcut still goes through the destination's own guard.
   */
  private async revalidateReferences(ctx: AuthContext, items: NavigationItem[]): Promise<void> {
    const problems: string[] = [];
    if (items.some((s) => s.kind === 'object' && s.target === 'audit') && !(await this.permissions.userHasPermission(ctx, PermissionFlag.AUDIT_VIEW))) {
      problems.push('Audit Log is not available to you');
    }
    for (const s of items.filter((i) => i.kind === 'record')) {
      const [type, id] = s.target!.split(':') as [string, string];
      const ok = await this.canOpen(ctx, type, id);
      if (!ok) problems.push(`item ${s.id}: that record is not available to you`);
    }
    if (problems.length) throw new BadRequestException({ message: 'The layout is not valid.', problems });
  }

  private async canOpen(ctx: AuthContext, type: string, id: string): Promise<boolean> {
    try {
      if (type === 'Staff') { await this.staff.get(ctx, id); return true; }
      if (type === 'Venue') { await this.venues.get(ctx, id); return true; }
      if (type === 'Shift') { await this.scheduling.get(ctx, id); return true; }
      if (type === 'Manager') {
        if (await this.permissions.userHasPermission(ctx, PermissionFlag.MANAGER_MANAGE)) { await this.managers.get(ctx, id); return true; }
        if (!(await this.permissions.userHasPermission(ctx, PermissionFlag.VENUE_MANAGER_CREATE))) return false;
        const { data } = await this.managers.listVenueManagersInWorkspace(ctx, {}, { id });
        return data.length === 1;
      }
      return false;
    } catch {
      return false; // not found / not permitted / not in scope — all mean "not available to you"
    }
  }

  private view(row: Row): NavigationLayoutView {
    return { scope: 'personal', revision: row.revision, items: row.items, updatedAt: new Date(row.updated_at).toISOString() };
  }
}
