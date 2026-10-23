import { Injectable, Logger } from '@nestjs/common';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { Request } from 'express';

import { EnvironmentService } from '../environment/environment.service';
import { WorkspaceOriginTrustRegistry } from '../environment/workspace-origin-trust.registry';
import { WorkspaceHostResolverService } from './workspace-host-resolver.service';

/**
 * Wave 3 lane H (C9 step 1) — registry-backed credentialed-Origin trust.
 *
 * `ensure(origin)` decides, asynchronously, whether `origin` is EXACTLY the canonical origin of a routable workspace
 * (`core.resolve_workspace_by_host_label`: READY, active, organisation not suspended), and records the answer in
 * `WorkspaceOriginTrustRegistry`, which the synchronous `EnvironmentService.isTrustedOrigin` reads. Never trusted:
 * reserved labels, `xn--`, unknown or CREATING/FAILED/suspended labels, a released (rename-quarantined) label, any
 * spelling or scheme or port other than the canonical one. Errors record "untrusted" (fail closed).
 *
 * Master switch: WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED (wave 1, default false). Off → nothing is ever recorded and
 * only exact CORS_ORIGINS entries are trusted. Configured CORS_ORIGINS never need this path.
 */
@Injectable()
export class WorkspaceOriginTrustService {
  private readonly logger = new Logger(WorkspaceOriginTrustService.name);

  constructor(
    private readonly env: EnvironmentService,
    private readonly resolver: WorkspaceHostResolverService,
    private readonly registry: WorkspaceOriginTrustRegistry,
  ) {}

  async ensure(origin: string | undefined | null): Promise<void> {
    if (!origin || this.env.corsOrigins.includes(origin)) return;
    const label = this.env.workspaceOriginLabel(origin);
    if (label === null) return;
    let trusted = false;
    try {
      const context = await this.resolver.contextForLabel(label, 'origin');
      trusted = context.kind === 'workspace' && context.canonicalOrigin === origin;
    } catch (error) {
      this.logger.warn(`origin trust lookup failed: ${(error as Error).message}`);
    }
    this.registry.record(origin, trusted);
  }

  /** Async form for callers that can await (the CORS origin callback). */
  async isTrusted(origin: string | undefined | null): Promise<boolean> {
    await this.ensure(origin);
    return this.env.isTrustedOrigin(origin);
  }
}

/**
 * The CORS `origin` option for `app.enableCors` (main.ts, and the integration tests that mirror it). Resolves the
 * registry first, then applies the one synchronous predicate every other consumer uses; any error → not allowed.
 */
export function buildCorsOriginCallback(originTrust: WorkspaceOriginTrustService) {
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void => {
    originTrust.isTrusted(origin).then(
      (allowed) => callback(null, allowed),
      () => callback(null, false),
    );
  };
}

/**
 * W6-E2E-03 — the per-request CORS policy `main.ts` installs (`app.enableCors(buildCorsOptionsDelegate(...))`). Same
 * trust predicate as `buildCorsOriginCallback`, plus: on a WORKSPACE host only that host's own origin (and the configured
 * platform origins) may read credentialed responses. Before, any registered workspace origin was allowed on every host,
 * so a script on workspace A's origin could read B's host's responses for a visitor holding a B session (the wrong-host
 * 404 even named the visitor's own workspace). Any error means not allowed.
 */
export function buildCorsOptionsDelegate(
  originTrust: WorkspaceOriginTrustService,
  resolver: WorkspaceHostResolverService,
  base: Omit<CorsOptions, 'origin'>,
) {
  return (req: Request, callback: (err: Error | null, options?: CorsOptions) => void): void => {
    const raw = req.headers.origin;
    const origin = typeof raw === 'string' ? raw : undefined;
    originTrust.isTrusted(origin).then(
      (trusted) => {
        let allowed = false;
        try {
          allowed = trusted && origin !== undefined && resolver.originMayReadRequestHost(origin, req);
        } catch {
          allowed = false;
        }
        callback(null, { ...base, origin: allowed });
      },
      () => callback(null, { ...base, origin: false }),
    );
  };
}
