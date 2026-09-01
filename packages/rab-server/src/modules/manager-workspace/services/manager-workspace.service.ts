import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { ManagerProfile } from '../../manager/entities/manager-profile.entity';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { StorageService } from '../../../engine/core-modules/storage/storage.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { CreateManagerWorkspaceDto } from '../dto/create-manager-workspace.dto';
import { UpdateManagerWorkspaceNameDto } from '../dto/update-manager-workspace-name.dto';
import { UpdateManagerWorkspaceSubdomainDto } from '../dto/update-manager-workspace-subdomain.dto';
import { ManagerWorkspace } from '../entities/manager-workspace.entity';
import { SubdomainService } from './subdomain.service';

const POSTGRES_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION;
}

export interface ManagerWorkspaceResponse {
  id: string;
  name: string;
  subdomain: string;
  logoKey: string | null;
  status: string;
  onboardingCompletedAt: string | null;
  createdAt: Date;
}

function toResponse(workspace: ManagerWorkspace): ManagerWorkspaceResponse {
  return {
    id: workspace.id,
    name: workspace.name,
    subdomain: workspace.subdomain,
    logoKey: workspace.logoKey ?? null,
    status: workspace.status,
    onboardingCompletedAt: workspace.onboardingCompletedAt?.toISOString() ?? null,
    createdAt: workspace.createdAt,
  };
}

/**
 * `ManagerWorkspace` — a private, individually-owned workspace per Manager.
 * Not the same concept as `WorkspaceService`/`WorkspaceController`
 * (`modules/identity/`), which edits the shared Organisation's own
 * settings — see the entity's own doc comment for the naming rationale.
 */
@Injectable()
export class ManagerWorkspaceService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly subdomainService: SubdomainService,
    private readonly storageService: StorageService,
  ) {}

  private async ownManagerProfile(manager: EntityManager, ctx: AuthContext): Promise<ManagerProfile> {
    const profile = await manager.findOne(ManagerProfile, { where: { userId: ctx.userId } });
    // 404, not 403 — a Staff account (or anything else without a ManagerProfile)
    // must find this indistinguishable from a route that doesn't exist for them.
    if (!profile) throw new NotFoundException('Manager profile not found.');
    return profile;
  }

  private async ownWorkspace(manager: EntityManager, ctx: AuthContext): Promise<ManagerWorkspace> {
    const workspace = await manager.findOne(ManagerWorkspace, { where: { ownerUserId: ctx.userId } });
    if (!workspace) throw new NotFoundException('Workspace not found.');
    return workspace;
  }

  /** Caller's own workspace, or 404 — never "first workspace" or any other fallback. */
  async getMine(ctx: AuthContext): Promise<ManagerWorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const workspace = await this.ownWorkspace(manager, ctx);
      return toResponse(workspace);
    });
  }

  /** Same shape as `WorkspaceService.update` — name is independent of subdomain, changing it never touches the live URL. */
  async updateName(ctx: AuthContext, dto: UpdateManagerWorkspaceNameDto): Promise<ManagerWorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const workspace = await this.ownWorkspace(manager, ctx);
      await manager.update(ManagerWorkspace, workspace.id, { name: dto.name.trim() });
      const updated = await manager.findOneByOrFail(ManagerWorkspace, { id: workspace.id });
      await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_UPDATED, {
        entityType: 'manager_workspace',
        entityId: updated.id,
        metadata: { fields: ['name'] },
      });
      return toResponse(updated);
    });
  }

  async uploadLogo(ctx: AuthContext, buffer: Buffer): Promise<ManagerWorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const workspace = await this.ownWorkspace(manager, ctx);
      const { key } = await this.storageService.uploadLogo(ctx.organisationId!, buffer);
      await manager.update(ManagerWorkspace, workspace.id, { logoKey: key });
      await this.storageService.deleteQuietly(workspace.logoKey);
      await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_UPDATED, {
        entityType: 'manager_workspace',
        entityId: workspace.id,
        metadata: { fields: ['logo'] },
      });
      const updated = await manager.findOneByOrFail(ManagerWorkspace, { id: workspace.id });
      return toResponse(updated);
    });
  }

  async deleteLogo(ctx: AuthContext): Promise<ManagerWorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const workspace = await this.ownWorkspace(manager, ctx);
      await manager.query(`UPDATE core.manager_workspace SET logo_key = NULL WHERE id = $1`, [workspace.id]);
      await this.storageService.deleteQuietly(workspace.logoKey);
      await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_UPDATED, {
        entityType: 'manager_workspace',
        entityId: workspace.id,
        metadata: { fields: ['logo'] },
      });
      const updated = await manager.findOneByOrFail(ManagerWorkspace, { id: workspace.id });
      return toResponse(updated);
    });
  }

  /**
   * The one and only place `onboardingCompletedAt` is ever written — called
   * by the web Create Profile step once the second onboarding step
   * finishes. Idempotent: calling it again just re-stamps the timestamp,
   * never errors — a double-submit or a retried request must not fail.
   */
  async completeOnboarding(ctx: AuthContext): Promise<ManagerWorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const workspace = await this.ownWorkspace(manager, ctx);
      await manager.update(ManagerWorkspace, workspace.id, { onboardingCompletedAt: new Date() });
      const updated = await manager.findOneByOrFail(ManagerWorkspace, { id: workspace.id });
      await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_ONBOARDING_COMPLETED, {
        entityType: 'manager_workspace',
        entityId: updated.id,
      });
      return toResponse(updated);
    });
  }

  /**
   * Atomic: verify caller is a Manager -> verify they don't already own a
   * workspace -> normalize/validate/check the requested subdomain -> insert
   * -> audit. `ownerUserId`/`organisationId` are always derived from `ctx`,
   * never the request body (`CreateManagerWorkspaceDto` whitelists only
   * `name`/`subdomain`). The DB's own `UNIQUE(subdomain)` constraint is the
   * real race-condition backstop — `SubdomainService`'s own check just
   * gives a clean 409-with-suggestions instead of a raw constraint error in
   * the (rare) case two requests for the same subdomain land concurrently.
   */
  async create(ctx: AuthContext, dto: CreateManagerWorkspaceDto): Promise<ManagerWorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const ownProfile = await this.ownManagerProfile(manager, ctx);

      const alreadyOwned = await manager.findOne(ManagerWorkspace, { where: { ownerUserId: ctx.userId } });
      if (alreadyOwned) throw new ConflictException('You already have a workspace.');

      const availability = await this.subdomainService.checkAvailability(dto.subdomain);
      if (!availability.available) {
        throw new ConflictException({
          message: availability.reserved ? 'This subdomain cannot be used.' : 'This subdomain is already taken.',
          normalized: availability.normalized,
          suggested: availability.suggested,
          alternatives: availability.alternatives,
        });
      }

      const workspace = manager.create(ManagerWorkspace, {
        organisationId: ctx.organisationId!,
        ownerUserId: ctx.userId,
        name: dto.name.trim(),
        subdomain: availability.normalized,
        status: 'active',
      });
      try {
        await manager.save(workspace);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('That subdomain was just taken.');
        }
        throw error;
      }

      // This Manager now owns a real Workspace — resolve_workspace_for_user
      // (used by every subsequent request's JwtAuthGuard) already covers
      // manager_workspace.owner_user_id directly, but stamping the
      // profile's own workspace_id too keeps manager_profile self-consistent
      // for any code that reads it directly rather than re-resolving.
      await manager.update(ManagerProfile, { id: ownProfile.id }, { workspaceId: workspace.id });

      await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_CREATED, {
        entityType: 'manager_workspace',
        entityId: workspace.id,
        metadata: { subdomain: workspace.subdomain },
      });

      return toResponse(workspace);
    });
  }

  /**
   * Reuses the identical normalization/validation/reserved-check/
   * availability pipeline as `create` — only the Workspace owner may call
   * this (structurally true here: it only ever operates on the caller's
   * OWN workspace, never an id from the request).
   */
  async updateSubdomain(ctx: AuthContext, dto: UpdateManagerWorkspaceSubdomainDto): Promise<ManagerWorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const workspace = await manager.findOne(ManagerWorkspace, { where: { ownerUserId: ctx.userId } });
      if (!workspace) throw new NotFoundException('Workspace not found.');

      const availability = await this.subdomainService.checkAvailability(dto.subdomain, workspace.id);
      if (!availability.available) {
        throw new ConflictException({
          message: availability.reserved ? 'This subdomain cannot be used.' : 'This subdomain is already taken.',
          normalized: availability.normalized,
          suggested: availability.suggested,
          alternatives: availability.alternatives,
        });
      }

      if (availability.normalized === workspace.subdomain) return toResponse(workspace);

      const oldSubdomain = workspace.subdomain;
      try {
        await manager.update(ManagerWorkspace, workspace.id, { subdomain: availability.normalized });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('That subdomain was just taken.');
        }
        throw error;
      }

      const updated = await manager.findOneByOrFail(ManagerWorkspace, { id: workspace.id });
      await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_SUBDOMAIN_CHANGED, {
        entityType: 'manager_workspace',
        entityId: updated.id,
        metadata: { oldSubdomain, newSubdomain: updated.subdomain },
      });
      return toResponse(updated);
    });
  }
}
