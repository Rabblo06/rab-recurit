import { Injectable, Logger } from '@nestjs/common';

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
