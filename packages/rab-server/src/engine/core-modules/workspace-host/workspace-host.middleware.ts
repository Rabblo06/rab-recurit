import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';

import { WorkspaceHostResolverService } from './workspace-host-resolver.service';
import { WorkspaceOriginTrustService } from './workspace-origin-trust.service';
import { WorkspaceHostRequest } from './workspace-host.types';

/**
 * Wave 3 lane H — runs for every route, before every guard:
 *   1. attaches `req.workspaceHost` (routing context, see `WorkspaceHostResolverService.resolveRequest`);
 *   2. resolves the request's Origin into `WorkspaceOriginTrustRegistry`, so the synchronous `isTrustedOrigin` used by
 *      the cookie-CSRF check, login provenance, `/auth/refresh` and the OAuth handoff sees a fresh registry answer.
 * Never throws and never short-circuits the request: a lookup failure becomes the `unavailable` context (refused later
 * for authenticated requests) and an untrusted Origin (refused by the CSRF/provenance checks).
 */
@Injectable()
export class WorkspaceHostMiddleware implements NestMiddleware {
  constructor(
    private readonly resolver: WorkspaceHostResolverService,
    private readonly originTrust: WorkspaceOriginTrustService,
  ) {}

  async use(req: WorkspaceHostRequest, _res: Response, next: NextFunction): Promise<void> {
    try {
      req.workspaceHost = await this.resolver.resolveRequest(req);
    } catch {
      req.workspaceHost = { kind: 'not-found', source: 'host', label: null };
    }
    try {
      const origin = req.headers.origin;
      await this.originTrust.ensure(typeof origin === 'string' ? origin : undefined);
    } catch {
      // ensure() records "untrusted" itself; nothing to add.
    }
    next();
  }
}
