import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { StorageService } from '../../../engine/core-modules/storage/storage.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
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
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly storageService: StorageService,
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
    // Cross-organisation uniqueness check runs against the unscoped
    // connection, same as AuthService's pre-auth User lookups — `organisation`
    // is one of the tables deliberately not FORCEd (IdentitySchema's
    // documented trade-off) precisely because a tenant-bound query can only
    // ever see its own organisation's row, and checking "is this slug taken
    // by a DIFFERENT org" is structurally the same chicken-and-egg problem as
    // resolving which org an email belongs to at login.
    const taken = await this.dataSource.manager.findOne(Organisation, { where: { slug: dto.slug } });
    if (taken && taken.id !== ctx.organisationId) {
      throw new ConflictException('This subdomain is already taken.');
    }

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const current = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      if (dto.slug === current.slug) return this.toResponse(current);

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
      const { key } = await this.storageService.uploadLogo(ctx.organisationId!, buffer);
      await manager.update(Organisation, ctx.organisationId!, { logoKey: key });
      await this.storageService.deleteQuietly(before.logoKey);
      await this.auditService.record(manager, ctx, AuditAction.WORKSPACE_UPDATED, {
        entityType: 'organisation',
        entityId: ctx.organisationId!,
        metadata: { fields: ['logo'] },
      });
      const org = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      return this.toResponse(org);
    });
  }

  async deleteLogo(ctx: AuthContext): Promise<WorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const before = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      await manager.query(`UPDATE core.organisation SET logo_key = NULL WHERE id = $1`, [ctx.organisationId]);
      await this.storageService.deleteQuietly(before.logoKey);
      await this.auditService.record(manager, ctx, AuditAction.WORKSPACE_UPDATED, {
        entityType: 'organisation',
        entityId: ctx.organisationId!,
        metadata: { fields: ['logo'] },
      });
      const org = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      return this.toResponse(org);
    });
  }

  private toResponse(org: Organisation): WorkspaceResponse {
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logoKey: org.logoKey ?? null,
      timezone: org.timezone,
    };
  }
}
