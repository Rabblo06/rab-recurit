import { Controller, Get, Req, ServiceUnavailableException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { WorkspaceHostResolverService } from './workspace-host-resolver.service';
import { PublicWorkspaceHostResponse, WorkspaceHostRequest } from './workspace-host.types';

// Public and pre-auth, so throttled like the other public lookups. The answer for a label is the same public routing
// fact the browser would get by loading `<label>.<base>` (exists-and-is-routable or not), so this adds no enumeration
// surface beyond DNS + the availability check, and never discloses owner, member or user data.
const PUBLIC_HOST_THROTTLE = { default: { limit: 60, ttl: 60_000 } };

/**
 * Wave 3 lane H (C5/C6) — `GET /rest/v1/public/workspace-host`: what the web app is being served as. The host comes ONLY
 * from validated request inputs (`req.workspaceHost`, set by `WorkspaceHostMiddleware`: Host / trusted-proxy
 * X-Forwarded-Host / browser Origin). There is deliberately no query parameter: a client cannot name the host it wants.
 * Every URL in the response is built from APP_URL or from the database's canonical label + WORKSPACE_BASE_DOMAIN.
 */
@Controller('rest/v1/public/workspace-host')
export class PublicWorkspaceHostController {
  constructor(private readonly resolver: WorkspaceHostResolverService) {}

  @Get()
  @Throttle(PUBLIC_HOST_THROTTLE)
  resolve(@Req() req: WorkspaceHostRequest): PublicWorkspaceHostResponse {
    const defaultUrl = this.resolver.defaultAppUrl();
    const baseDomain = this.resolver.baseDomain();
    const host = req.workspaceHost ?? { kind: 'none' as const };
    if (!this.resolver.isRoutingEnabled() || !baseDomain || host.kind === 'none') {
      return { state: 'default', defaultUrl, workspaceBaseDomain: this.resolver.isRoutingEnabled() ? baseDomain : null };
    }
    switch (host.kind) {
      case 'workspace':
        return {
          state: 'workspace',
          defaultUrl,
          workspaceBaseDomain: baseDomain,
          canonicalUrl: host.canonicalOrigin,
          workspace: { subdomain: host.canonicalLabel, displayName: host.displayName },
        };
      case 'renamed':
        return { state: 'renamed', defaultUrl, workspaceBaseDomain: baseDomain, canonicalUrl: host.canonicalOrigin };
      case 'unavailable':
        throw new ServiceUnavailableException({ code: 'WORKSPACE_HOST_UNAVAILABLE', message: 'Please try again shortly.' });
      case 'not-found':
        return { state: 'not-found', defaultUrl, workspaceBaseDomain: baseDomain };
    }
  }
}
