import { ManagerType, PermissionFlag } from '@rab/shared';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { CreateAdminVenueManagerDto } from '../dto/create-admin-venue-manager.dto';
import { CreateVenueManagerDto } from '../dto/create-venue-manager.dto';
import { ManagerService } from './manager.service';

/**
 * Two Venue Manager creation flows, kept strictly separate (decision C):
 *
 * 1. NORMAL MANAGER: `createInOwnWorkspace`. Requires VENUE_MANAGER_CREATE (controller) and a workspace in the caller's
 *    server-side context (RequireWorkspaceGuard, and assertHasWorkspace here). When the caller is Manager A, the new Venue
 *    Manager's membership and profile are Workspace A. No request field can change that.
 *
 * 2. CEO / ADMIN: `createForWorkspace`. Requires MANAGER_MANAGE, checked here as well as at the route. The caller may be
 *    workspace-less. An explicit target workspace is accepted only after the caller is authenticated, holds the permission,
 *    the core registry confirms that workspace is active and belongs to the caller's organisation, and an audit row is
 *    written in the same transaction as the creation. A target is never trusted from the request by itself.
 *
 * Both delegate to ManagerService.createWithin, so the user, role, profile, membership and invite rules are written once.
 */
@Injectable()
export class VenueManagerService {
  @Inject(PermissionsService)
  private readonly permissions!: PermissionsService;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly managerService: ManagerService,
    private readonly resourceScope: ResourceScopeService,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  async createInOwnWorkspace(ctx: AuthContext, dto: CreateVenueManagerDto) {
    this.resourceScope.assertHasWorkspace(ctx);
    return this.tenantContext.runInWorkspaceContext(ctx, (manager) =>
      this.managerService.createWithin(manager, ctx, { ...dto, type: ManagerType.VENUE }),
    );
  }

  async createForWorkspace(ctx: AuthContext, dto: CreateAdminVenueManagerDto) {
    if (!(await this.permissions.userHasPermission(ctx, PermissionFlag.MANAGER_MANAGE))) {
      throw new ForbiddenException('Managing Manager accounts is not permitted.');
    }
    const [{ ok }] = await this.dataSource.query<Array<{ ok: boolean }>>(
      'SELECT core.admin_workspace_in_org($1, $2) AS ok',
      [dto.targetWorkspaceId, ctx.organisationId],
    );
    if (!ok) {
      // 404 for a workspace outside the caller's organisation, or one that does not exist: no existence oracle.
      throw new NotFoundException('Workspace not found.');
    }

    const { targetWorkspaceId, ...person } = dto;
    const targetCtx: AuthContext = { ...ctx, workspaceId: targetWorkspaceId };
    return this.tenantContext.runInWorkspaceContext(targetCtx, async (manager) => {
      const created = await this.managerService.createWithin(manager, targetCtx, { ...person, type: ManagerType.VENUE });
      const [{ user_id: createdUserId }] = await manager.query<Array<{ user_id: string }>>(
        'SELECT user_id FROM core.manager_profile WHERE id = $1',
        [created.id],
      );
      await this.auditService.record(manager, ctx, AuditAction.ADMIN_VENUE_MANAGER_CREATED, {
        entityType: 'user',
        entityId: createdUserId,
        targetUserId: createdUserId,
        // Identifiers and the action only. No email, password, token or other secret is written here.
        metadata: { targetWorkspaceId, action: 'venue_manager.create', actorUserId: ctx.userId },
      });
      return created;
    });
  }
}
