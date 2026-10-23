import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { OrganisationAuthProvidersService } from '../../../engine/core-modules/auth/services/organisation-auth-providers.service';
import { CoreEntityCacheService } from '../../../engine/core-modules/entity-cache/core-entity-cache.service';
import { PlatformAdminService } from '../../../engine/core-modules/platform-admin/platform-admin.service';
import { FileKind } from '../../../engine/core-modules/storage/file-kinds';
import { FileService } from '../../../engine/core-modules/storage/file.service';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { UpdateAuthProvidersDto } from '../dto/update-auth-providers.dto';
import { UpdateSubdomainDto } from '../dto/update-subdomain.dto';
import { UpdateWorkspaceDto } from '../dto/update-workspace.dto';
import { Organisation } from '../entities';
import { AuthProvidersView, WorkspaceResponse, WorkspaceService } from './workspace.service';

export type PlatformAdminActor = Pick<AuthContext, 'userId' | 'inspectedBy'>;

export interface OrganisationSettingsView {
  organisation: WorkspaceResponse;
  authProviders: AuthProvidersView;
}

/**
 * W6-E2E-04 — owner decision 2026-10-23: "Changing organisation settings (incl. turning off password sign-in) =
 * PLATFORM ADMIN ONLY."
 *
 * Every organisation-level setting that used to sit behind `settings.edit` on `PATCH/POST/DELETE /rest/v1/workspace…`
 * (inventory: name + timezone, the organisation slug, the logo, and the sign-in methods) is changed HERE and only here,
 * reached from `AdminOrganisationSettingsController` (`/rest/v1/admin/organisations/:organisationId/settings…`,
 * `JwtAuthGuard` + `PlatformAdminGuard`). The tenant routes for those mutations no longer exist (404); the tenant keeps
 * the read-only `GET /workspace` and `GET /workspace/security` (`settings.view`).
 *
 * Layers: guard (`PlatformAdminGuard`) → THIS service re-checks `core.is_active_platform_admin` for the actor before
 * any read or write (layer 2: a job, CLI or another service calling this never passes the guard) → the transaction is
 * bound to the TARGET organisation (`organisation_self` RLS: only that one row is visible/writable) → audit lands in the
 * target organisation's own trail, attributed to the administrator (`audit_log_recorded_identities` admits a platform
 * administrator actor across organisations), with `via: 'platform_admin'`.
 *
 * 403 for a non-administrator (the routes exist and are documented; the caller categorically lacks the claim), 404 for
 * an organisation id that does not exist. Admin Inspect sessions are refused for every mutation.
 */
@Injectable()
export class OrganisationSettingsAdminService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly fileService: FileService,
    private readonly organisationAuthProviders: OrganisationAuthProvidersService,
    private readonly entityCache: CoreEntityCacheService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  async get(actor: PlatformAdminActor, organisationId: string): Promise<OrganisationSettingsView> {
    return this.inTarget(actor, organisationId, false, async (manager, org) => ({
      organisation: WorkspaceService.toResponse(org),
      authProviders: this.workspaceService.authProvidersView(org),
    }));
  }

  async update(actor: PlatformAdminActor, organisationId: string, dto: UpdateWorkspaceDto): Promise<OrganisationSettingsView> {
    // Explicit field mapping (never a spread of the client object): name and timezone only.
    const patch: Partial<Pick<Organisation, 'name' | 'timezone'>> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.timezone !== undefined) patch.timezone = dto.timezone;
    const view = await this.inTarget(actor, organisationId, true, async (manager, org, ctx) => {
      if (Object.keys(patch).length > 0) await manager.update(Organisation, organisationId, patch);
      await this.auditService.record(manager, ctx, AuditAction.WORKSPACE_UPDATED, {
        entityType: 'organisation',
        entityId: organisationId,
        metadata: { fields: Object.keys(patch), via: 'platform_admin' },
      });
      return this.reload(manager, organisationId);
    });
    await this.entityCache.invalidate('organisation', organisationId);
    return view;
  }

  async updateSubdomain(actor: PlatformAdminActor, organisationId: string, dto: UpdateSubdomainDto): Promise<OrganisationSettingsView> {
    const view = await this.inTarget(actor, organisationId, true, async (manager, org, ctx) => {
      if (dto.slug === org.slug) return this.reload(manager, organisationId);
      // Cross-organisation uniqueness goes through the narrow SECURITY DEFINER check (PreAuthLookupFunctions1786667400000):
      // the bound transaction can only see the target organisation's own row.
      const [{ taken }] = await manager.query<[{ taken: boolean }]>('SELECT core.organisation_slug_taken($1, $2) AS taken', [dto.slug, organisationId]);
      if (taken) throw new ConflictException('This subdomain is already taken.');
      const oldSlug = org.slug;
      await manager.update(Organisation, organisationId, { slug: dto.slug });
      await this.auditService.record(manager, ctx, AuditAction.WORKSPACE_SUBDOMAIN_CHANGED, {
        entityType: 'organisation',
        entityId: organisationId,
        metadata: { oldSlug, newSlug: dto.slug, via: 'platform_admin' },
      });
      return this.reload(manager, organisationId);
    });
    await this.entityCache.invalidate('organisation', organisationId);
    return view;
  }

  async uploadLogo(actor: PlatformAdminActor, organisationId: string, buffer: Buffer): Promise<OrganisationSettingsView> {
    const view = await this.inTarget(actor, organisationId, true, async (manager, org, ctx) => {
      const file = await this.fileService.store(manager, {
        kind: FileKind.ORGANISATION_LOGO,
        organisationId,
        workspaceId: null, // organisation-level file
        resourceType: 'organisation',
        resourceId: organisationId,
        buffer,
        createdBy: actor.userId,
      });
      await manager.update(Organisation, organisationId, { logoFileId: file.id });
      await this.retireLogo(manager, org.logoFileId);
      await this.auditService.record(manager, ctx, AuditAction.WORKSPACE_UPDATED, {
        entityType: 'organisation',
        entityId: organisationId,
        metadata: { fields: ['logo'], via: 'platform_admin' },
      });
      return this.reload(manager, organisationId);
    });
    await this.entityCache.invalidate('organisation', organisationId);
    return view;
  }

  async deleteLogo(actor: PlatformAdminActor, organisationId: string): Promise<OrganisationSettingsView> {
    const view = await this.inTarget(actor, organisationId, true, async (manager, org, ctx) => {
      await manager.query(`UPDATE core.organisation SET logo_file_id = NULL, logo_key = NULL, updated_at = now() WHERE id = $1`, [organisationId]);
      await this.retireLogo(manager, org.logoFileId);
      await this.auditService.record(manager, ctx, AuditAction.WORKSPACE_UPDATED, {
        entityType: 'organisation',
        entityId: organisationId,
        metadata: { fields: ['logo'], via: 'platform_admin' },
      });
      return this.reload(manager, organisationId);
    });
    await this.entityCache.invalidate('organisation', organisationId);
    return view;
  }

  /** Sign-in methods. The lockout refusal, security-version bump and wave-1 password-session revocation live in `OrganisationAuthProvidersService.update`, which re-checks the administrator itself. */
  async updateAuthProviders(actor: PlatformAdminActor, organisationId: string, dto: UpdateAuthProvidersDto): Promise<OrganisationSettingsView> {
    const patch: { passwordAuthEnabled?: boolean; googleAuthEnabled?: boolean; microsoftAuthEnabled?: boolean } = {};
    if (dto.passwordAuthEnabled !== undefined) patch.passwordAuthEnabled = dto.passwordAuthEnabled;
    if (dto.googleAuthEnabled !== undefined) patch.googleAuthEnabled = dto.googleAuthEnabled;
    if (dto.microsoftAuthEnabled !== undefined) patch.microsoftAuthEnabled = dto.microsoftAuthEnabled;
    await this.organisationAuthProviders.update(actor, organisationId, patch);
    return this.get(actor, organisationId);
  }

  /** Platform-admin check (layer 2) + target-bound transaction + 404 for an unknown organisation. */
  private async inTarget<T>(
    actor: PlatformAdminActor,
    organisationId: string,
    mutation: boolean,
    fn: (manager: EntityManager, org: Organisation, ctx: Pick<AuthContext, 'organisationId' | 'userId' | 'inspectedBy'>) => Promise<T>,
  ): Promise<T> {
    if (mutation && actor.inspectedBy) throw new ForbiddenException('This action is unavailable while inspecting another user.');
    const ctx = { organisationId, workspaceId: null, userId: actor.userId, role: '', inspectedBy: undefined };
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      if (!(await this.platformAdmin.isPlatformAdminTx(manager, actor))) {
        throw new ForbiddenException('Only a platform administrator can manage organisation settings.');
      }
      const org = await manager.findOne(Organisation, { where: { id: organisationId } });
      if (!org) throw new NotFoundException('Organisation not found.');
      return fn(manager, org, ctx);
    });
  }

  private async reload(manager: EntityManager, organisationId: string): Promise<OrganisationSettingsView> {
    const org = await manager.findOneOrFail(Organisation, { where: { id: organisationId } });
    return { organisation: WorkspaceService.toResponse(org), authProviders: this.workspaceService.authProvidersView(org) };
  }

  /** Tombstones the replaced file (row kept as `DELETED`); its object is purged later by `storage:reconcile`. */
  private async retireLogo(manager: EntityManager, fileId: string | null | undefined): Promise<void> {
    if (!fileId) return;
    const file = await manager.findOne(StoredFile, { where: { id: fileId } });
    if (file) await this.fileService.tombstone(manager, file, { removeObject: false });
  }
}
