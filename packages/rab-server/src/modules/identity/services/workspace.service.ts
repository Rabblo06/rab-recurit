import { EntityManager } from 'typeorm';
import { ConflictException, Injectable } from '@nestjs/common';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { EffectiveAuthProviders, OrganisationAuthProvidersService } from '../../../engine/core-modules/auth/services/organisation-auth-providers.service';
import { FileKind } from '../../../engine/core-modules/storage/file-kinds';
import { FileService } from '../../../engine/core-modules/storage/file.service';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { UpdateAuthProvidersDto } from '../dto/update-auth-providers.dto';
import { UpdateSubdomainDto } from '../dto/update-subdomain.dto';
import { UpdateWorkspaceDto } from '../dto/update-workspace.dto';
import { Organisation } from '../entities';

export interface WorkspaceResponse {
  id: string;
  name: string;
  slug: string;
  logoKey: string | null;
  timezone: string;
}

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly fileService: FileService,
    private readonly organisationAuthProviders: OrganisationAuthProvidersService,
  ) {}

  async get(ctx: AuthContext): Promise<WorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const org = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      return this.toResponse(org);
    });
  }

  async update(ctx: AuthContext, dto: UpdateWorkspaceDto): Promise<WorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await manager.update(Organisation, ctx.organisationId!, {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
      });
      const org = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      await this.auditService.record(manager, ctx, AuditAction.WORKSPACE_UPDATED, {
        entityType: 'organisation',
        entityId: org.id,
        metadata: { fields: Object.keys(dto) },
      });
      return this.toResponse(org);
    });
  }

  async updateSubdomain(ctx: AuthContext, dto: UpdateSubdomainDto): Promise<WorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const current = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      if (dto.slug === current.slug) return this.toResponse(current);

      // A tenant-bound query can only ever see this org's own row —
      // checking "is this slug taken by a DIFFERENT org" is a genuine
      // cross-tenant existence check, so it goes through the narrow
      // SECURITY DEFINER function (PreAuthLookupFunctions1786667400000)
      // rather than an unscoped `organisation` read, which the intended
      // runtime role (`rab_app`) cannot see any rows through at all —
      // confirmed live during this same remediation pass.
      const [{ organisation_slug_taken: taken }] = await manager.query<[{ organisation_slug_taken: boolean }]>(
        'SELECT core.organisation_slug_taken($1, $2) AS organisation_slug_taken',
        [dto.slug, ctx.organisationId!],
      );
      if (taken) {
        throw new ConflictException('This subdomain is already taken.');
      }

      const oldSlug = current.slug;
      await manager.update(Organisation, ctx.organisationId!, { slug: dto.slug });
      const org = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      await this.auditService.record(manager, ctx, AuditAction.WORKSPACE_SUBDOMAIN_CHANGED, {
        entityType: 'organisation',
        entityId: org.id,
        metadata: { oldSlug, newSlug: dto.slug },
      });
      return this.toResponse(org);
    });
  }

  async uploadLogo(ctx: AuthContext, buffer: Buffer): Promise<WorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const before = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      const file = await this.fileService.store(manager, {
        kind: FileKind.ORGANISATION_LOGO,
        organisationId: ctx.organisationId!,
        workspaceId: null, // organisation-level file
        resourceType: 'organisation',
        resourceId: ctx.organisationId!,
        buffer,
        createdBy: ctx.userId,
      });
      await manager.update(Organisation, ctx.organisationId!, { logoFileId: file.id });
      await this.retireLogo(manager, before.logoFileId);
      await this.auditService.record(manager, ctx, AuditAction.WORKSPACE_UPDATED, {
        entityType: 'organisation',
        entityId: ctx.organisationId!,
        metadata: { fields: ['logo'] },
      });
      const org = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      return this.toResponse(org);
    });
  }

  /** Tombstones the replaced file (row kept as `DELETED`); its object is purged later by `storage:reconcile`, so a rolled-back transaction can never leave an AVAILABLE row whose object is already gone. */
  private async retireLogo(manager: EntityManager, fileId: string | null | undefined): Promise<void> {
    if (!fileId) return;
    const file = await manager.findOne(StoredFile, { where: { id: fileId } });
    if (file) await this.fileService.tombstone(manager, file, { removeObject: false });
  }

  async deleteLogo(ctx: AuthContext): Promise<WorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const before = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      await manager.query(`UPDATE core.organisation SET logo_file_id = NULL, logo_key = NULL WHERE id = $1`, [ctx.organisationId]);
      await this.retireLogo(manager, before.logoFileId);
      await this.auditService.record(manager, ctx, AuditAction.WORKSPACE_UPDATED, {
        entityType: 'organisation',
        entityId: ctx.organisationId!,
        metadata: { fields: ['logo'] },
      });
      const org = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      return this.toResponse(org);
    });
  }

  /**
   * P1C.1B — Settings -> Security -> Authentication. Returns BOTH the organisation's own flag
   * and the system-level flag per provider, so the frontend can truthfully render "Unavailable
   * on this deployment" instead of implying a toggle it flips has any effect when the system
   * itself has the provider disabled (P1C.1B brief §8's own explicit requirement).
   */
  async getAuthProviders(ctx: AuthContext): Promise<Record<keyof EffectiveAuthProviders, { organisationEnabled: boolean; systemEnabled: boolean }>> {
    const system = this.organisationAuthProviders.systemEnabled();
    const org = await this.tenantContext.runInTenantContext(ctx, (manager) => this.organisationAuthProviders.getOrganisationFlags(manager, ctx.organisationId!));
    return {
      password: { organisationEnabled: org.passwordAuthEnabled, systemEnabled: system.password },
      google: { organisationEnabled: org.googleAuthEnabled, systemEnabled: system.google },
      microsoft: { organisationEnabled: org.microsoftAuthEnabled, systemEnabled: system.microsoft },
    };
  }

  async updateAuthProviders(ctx: AuthContext, dto: UpdateAuthProvidersDto) {
    await this.organisationAuthProviders.update(ctx, dto);
    return this.getAuthProviders(ctx);
  }

  private toResponse(org: Organisation): WorkspaceResponse {
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logoKey: org.logoFileId ?? null, // opaque FILE ID (name kept for client compatibility)
      timezone: org.timezone,
    };
  }
}
