import { Injectable, Logger } from '@nestjs/common';
import { buildWorkspaceOrigin, isReservedSubdomainLabel, isValidSubdomainShape } from '@rab/shared';

import { CoreEntityCacheService } from '../entity-cache/core-entity-cache.service';
import { EnvironmentService } from '../environment/environment.service';
import { WorkspaceOriginTrustRegistry } from '../environment/workspace-origin-trust.registry';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import {
  classifyRequestHost,
  classifyRequestOrigin,
  HostCandidate,
  HostClassificationConfig,
  MinimalHostRequest,
  platformAuthoritiesFrom,
  requestHostHeader,
  requestOriginHeader,
} from './request-host.util';
import { WorkspaceHostLookupService } from './workspace-host-lookup.service';
import { HostLabelResolution, WorkspaceHostContext, WorkspaceHostSource } from './workspace-host.types';

/** C13: positive answers ≤60 s, negative ≤10 s (a label becomes routable the moment it turns READY). */
export const HOST_LABEL_POSITIVE_TTL_SECONDS = 60;
export const HOST_LABEL_NEGATIVE_TTL_SECONDS = 10;
const HOST_MAP_EPOCH_ID = 'all';

interface CachedResolution {
  /** Wrapper so a negative answer is a non-null value the shared cache will store (it never caches null). */
  r: HostLabelResolution;
}

/**
 * Wave 3 lane H — host → workspace resolution (C5/C6/C13).
 *
 * SECURITY MODEL: a hostname is ROUTING CONTEXT, never authorisation. This service only answers "which workspace (if
 * any) is this browser addressing?". It never selects a session's workspace (that is `JwtAuthGuard`'s server-derived
 * `ctx.workspaceId`), never widens what a session may read (RLS is untouched), and a client-supplied workspace id can
 * never override it (none is read). It is used to (a) brand the public login page, (b) REFUSE an authenticated request
 * from a host that is not the session's own workspace, (c) decide registry-backed Origin trust and (d) build
 * workspace-specific links from the database's canonical label + env (never from a request header).
 *
 * CACHE: `CoreEntityCacheService` (the existing Redis epoch mechanism), kind `workspace_host_label`, keyed
 * `<global epoch>:<label>`. Rename invalidates the old and new labels; READY/FAILED invalidates the workspace's label;
 * organisation suspension/reactivation bumps the global epoch (every label at once). Disabled with
 * CORE_ENTITY_CACHE_ENABLED=false, in which case every lookup goes to the database. The cache only stores the
 * registry's public answer (ids + canonical label), never anything a session's access depends on.
 */
@Injectable()
export class WorkspaceHostResolverService {
  private readonly logger = new Logger(WorkspaceHostResolverService.name);

  constructor(
    private readonly env: EnvironmentService,
    private readonly lookup: WorkspaceHostLookupService,
    private readonly cache: CoreEntityCacheService,
    private readonly originRegistry: WorkspaceOriginTrustRegistry,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Host routing is active only with WORKSPACE_HOST_ROUTING_ENABLED=true and a base domain (env.validation enforces both). */
  isRoutingEnabled(): boolean {
    return this.env.get('WORKSPACE_HOST_ROUTING_ENABLED') === true && !!this.env.get('WORKSPACE_BASE_DOMAIN');
  }

  baseDomain(): string | null {
    return this.env.get('WORKSPACE_BASE_DOMAIN') ?? null;
  }

  /** The default (apex/app) URL: APP_URL, never derived from a request. */
  defaultAppUrl(): string {
    return this.env.get('APP_URL').replace(/\/+$/, '');
  }

  /** `<scheme>://<label>.<base>` for a label that came from the DATABASE, or null (reserved, malformed, no base domain). */
  canonicalOriginFor(label: string): string | null {
    return buildWorkspaceOrigin(this.env.canonicalWorkspaceScheme, label, this.baseDomain());
  }

  // ---------------------------------------------------------------- label resolution (cached)

  async resolveLabel(label: string): Promise<HostLabelResolution> {
    const normalised = label.toLowerCase();
    if (!isValidSubdomainShape(normalised) || isReservedSubdomainLabel(normalised)) return { kind: 'unknown' };
    const mapEpoch = await this.cache.currentEpoch('workspace_host_map', HOST_MAP_EPOCH_ID);
    const cached = await this.cache.getOrFetch<CachedResolution>(
      'workspace_host_label',
      `${mapEpoch}:${normalised}`,
      async () => ({ r: await this.lookup.lookup(normalised) }),
      this.cache.isEnabled(),
      (value) => (value.r.kind === 'unknown' ? HOST_LABEL_NEGATIVE_TTL_SECONDS : HOST_LABEL_POSITIVE_TTL_SECONDS),
    );
    return cached?.r ?? { kind: 'unknown' };
  }

  /** Call AFTER the write commits (rename: old and new label; READY/FAILED: the workspace's label). Never throws. */
  async invalidateLabels(...labels: (string | null | undefined)[]): Promise<void> {
    this.originRegistry.clear();
    try {
      const mapEpoch = await this.cache.currentEpoch('workspace_host_map', HOST_MAP_EPOCH_ID);
      for (const label of labels) {
        if (label) await this.cache.invalidate('workspace_host_label', `${mapEpoch}:${label.toLowerCase()}`);
      }
    } catch (error) {
      this.logger.warn(`host label invalidation failed: ${(error as Error).message}`);
    }
  }

  /** Drops every cached label at once (organisation suspension/reactivation). Never throws. */
  async invalidateAll(): Promise<void> {
    this.originRegistry.clear();
    try {
      await this.cache.invalidate('workspace_host_map', HOST_MAP_EPOCH_ID);
    } catch (error) {
      this.logger.warn(`host map invalidation failed: ${(error as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- request resolution

  private classificationConfig(baseDomain: string): HostClassificationConfig {
    return {
      baseDomain,
      platformAuthorities: platformAuthoritiesFrom([this.env.get('APP_URL'), this.env.get('ACCOUNTS_URL'), ...this.env.corsOrigins]),
    };
  }

  /**
   * Which workspace host this request addresses. The request host (Host, or X-Forwarded-Host from a trusted proxy) wins
   * when it names a workspace host — the same-origin topology where `<label>.<base>/rest/v1` is proxied to the API.
   * Otherwise the browser Origin is used — the topology where the API sits on its own fixed host and every page calls it
   * cross-origin. Both are values a browser sets and page script cannot forge; a non-browser client that forges either
   * can only make its OWN requests fail the wrong-host check, never gain access. If both name different workspace
   * hosts the request is `not-found` (conflict, fail closed).
   */
  async resolveRequest(req: MinimalHostRequest): Promise<WorkspaceHostContext> {
    if (!this.isRoutingEnabled()) return { kind: 'none' };
    const config = this.classificationConfig(this.baseDomain()!);
    const fromHost = classifyRequestHost(requestHostHeader(req, this.env.trustedProxyCidrs), config);
    const fromOrigin = classifyRequestOrigin(requestOriginHeader(req), config);

    let chosen: HostCandidate;
    let source: WorkspaceHostSource;
    if (fromHost.kind !== 'none') {
      chosen = fromHost;
      source = 'host';
      if (fromOrigin.kind !== 'none' && (fromOrigin.kind !== 'label' || fromHost.kind !== 'label' || fromOrigin.label !== fromHost.label)) {
        return { kind: 'not-found', source, label: fromHost.kind === 'label' ? fromHost.label : null };
      }
    } else {
      chosen = fromOrigin;
      source = 'origin';
    }

    if (chosen.kind === 'none') return { kind: 'none' };
    if (chosen.kind === 'invalid') return { kind: 'not-found', source, label: chosen.label };
    return this.contextForLabel(chosen.label, source);
  }

  async contextForLabel(label: string, source: WorkspaceHostSource): Promise<WorkspaceHostContext> {
    let resolution: HostLabelResolution;
    try {
      resolution = await this.resolveLabel(label);
    } catch (error) {
      this.logger.warn(`host label lookup failed: ${(error as Error).message}`);
      return { kind: 'unavailable', source, label };
    }
    if (resolution.kind === 'unknown') return { kind: 'not-found', source, label };
    const canonicalOrigin = this.canonicalOriginFor(resolution.canonicalLabel);
    if (!canonicalOrigin) return { kind: 'not-found', source, label };
    if (resolution.kind === 'renamed') return { kind: 'renamed', source, label, canonicalOrigin };
    // The registry is case-insensitive and returns the stored label; a request for any other spelling is not canonical.
    if (resolution.canonicalLabel !== label) return { kind: 'not-found', source, label };
    return {
      kind: 'workspace',
      source,
      label,
      workspaceId: resolution.workspaceId,
      organisationId: resolution.organisationId,
      canonicalLabel: resolution.canonicalLabel,
      canonicalOrigin,
      displayName: resolution.displayName,
    };
  }

  // ---------------------------------------------------------------- canonical URLs for a known workspace

  /**
   * The canonical origin of a workspace the CALLER has already been authorised for (the session's own workspace, or a
   * workspace a verified invitation token names). Reads the label through the caller's own RLS-scoped context, then
   * confirms it against the pre-auth registry (READY, active, not suspended, same workspace id). Null when routing is
   * off, the workspace is not routable, or anything fails — callers then use the default APP_URL.
   */
  async canonicalOriginForWorkspace(ctx: Pick<AuthContext, 'organisationId' | 'workspaceId' | 'userId' | 'role'> & Partial<AuthContext>): Promise<string | null> {
    if (!this.isRoutingEnabled() || !ctx.workspaceId) return null;
    try {
      const label = await this.tenantContext.runInTenantContext(ctx as AuthContext, async (manager) => {
        const rows = await manager.query<Array<{ subdomain: string }>>('SELECT subdomain FROM core.manager_workspace WHERE id = $1', [ctx.workspaceId]);
        return rows[0]?.subdomain?.toLowerCase() ?? null;
      });
      if (!label) return null;
      const resolution = await this.resolveLabel(label);
      if (resolution.kind !== 'workspace' || resolution.workspaceId !== ctx.workspaceId) return null;
      return this.canonicalOriginFor(resolution.canonicalLabel);
    } catch (error) {
      this.logger.warn(`canonical workspace origin lookup failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** `<canonical origin>/login` for a workspace-specific email link, else `<APP_URL>/login`. Never from a request header. */
  async workspaceLoginUrl(ctx: Pick<AuthContext, 'organisationId' | 'workspaceId' | 'userId' | 'role'>): Promise<string> {
    const origin = await this.canonicalOriginForWorkspace(ctx);
    return `${origin ?? this.defaultAppUrl()}/login`;
  }
}
