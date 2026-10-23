import { Injectable } from '@nestjs/common';

import { EffectiveAuthProviders, OrganisationAuthProvidersService } from '../../../engine/core-modules/auth/services/organisation-auth-providers.service';
import { CoreEntityCacheService } from '../../../engine/core-modules/entity-cache/core-entity-cache.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../entities';

export interface WorkspaceResponse {
  id: string;
  name: string;
  slug: string;
  logoKey: string | null;
  timezone: string;
}

export type AuthProvidersView = Record<keyof EffectiveAuthProviders, { organisationEnabled: boolean; systemEnabled: boolean }>;

/**
 * The tenant's READ-ONLY view of its own organisation settings (`settings.view`).
 *
 * W6-E2E-04 — owner decision 2026-10-23: changing organisation settings (name, timezone, slug, logo, sign-in methods)
 * is PLATFORM ADMIN ONLY. The mutations moved to `OrganisationSettingsAdminService` (admin routes); the tenant routes
 * that used to call them here (`PATCH /workspace`, `PATCH /workspace/domain`, `POST|DELETE /workspace/logo`,
 * `PATCH /workspace/security`) were removed, so no tenant role can change them whatever it holds (`settings.edit`
 * guards no tenant route any more).
 */
@Injectable()
export class WorkspaceService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly organisationAuthProviders: OrganisationAuthProvidersService,
    private readonly entityCache: CoreEntityCacheService,
  ) {}

  /** Redis checkpoint — Core Entity Cache: display-only, see CoreEntityCacheService's own doc comment. */
  async get(ctx: AuthContext): Promise<WorkspaceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const cached = await this.entityCache.getOrganisationDisplay(manager, ctx.organisationId!);
      if (cached) return { id: cached.id, name: cached.name, slug: cached.slug, logoKey: cached.logoFileId, timezone: cached.timezone };
      const org = await manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } });
      return WorkspaceService.toResponse(org);
    });
  }

  /**
   * P1C.1B — Settings -> Security -> Authentication (read-only for the tenant since W6-E2E-04). Returns BOTH the
   * organisation's own flag and the system-level flag per provider, so the page can truthfully render "Unavailable on
   * this deployment" instead of implying a provider is usable when the system has it disabled.
   */
  async getAuthProviders(ctx: AuthContext): Promise<AuthProvidersView> {
    const org = await this.tenantContext.runInTenantContext(ctx, (manager) => manager.findOneOrFail(Organisation, { where: { id: ctx.organisationId! } }));
    return this.authProvidersView(org);
  }

  authProvidersView(org: Pick<Organisation, 'passwordAuthEnabled' | 'googleAuthEnabled' | 'microsoftAuthEnabled'>): AuthProvidersView {
    const system = this.organisationAuthProviders.systemEnabled();
    return {
      password: { organisationEnabled: org.passwordAuthEnabled, systemEnabled: system.password },
      google: { organisationEnabled: org.googleAuthEnabled, systemEnabled: system.google },
      microsoft: { organisationEnabled: org.microsoftAuthEnabled, systemEnabled: system.microsoft },
    };
  }

  static toResponse(org: Organisation): WorkspaceResponse {
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logoKey: org.logoFileId ?? null, // opaque FILE ID (name kept for client compatibility)
      timezone: org.timezone,
    };
  }
}
