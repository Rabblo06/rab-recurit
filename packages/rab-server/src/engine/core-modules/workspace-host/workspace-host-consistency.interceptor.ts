import { CallHandler, ExecutionContext, Injectable, NestInterceptor, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { from, mergeMap, Observable, throwError } from 'rxjs';

import { AuthContext } from '../tenant/auth-context.interface';
import { WorkspaceHostResolverService } from './workspace-host-resolver.service';
import { WORKSPACE_HOST_MISMATCH, WorkspaceHostRequest } from './workspace-host.types';

/**
 * Routes an authenticated session may still call from a workspace host that is not its own: signing out must always
 * work (otherwise the wrong-host screen would trap the user). Exact paths, nothing else.
 */
const ANY_HOST_PATHS: ReadonlySet<string> = new Set(['/rest/v1/auth/logout']);

/**
 * Wave 3 lane H — the wrong-host check (C6). Runs after every guard (so `req.authContext` is the session's own,
 * server-derived context) and before the handler.
 *
 * If the request addresses a workspace host (`req.workspaceHost` is workspace / renamed / not-found / unavailable) and
 * the session's server-derived `ctx.workspaceId` is not THAT host's workspace, the request is refused with 404
 * `WORKSPACE_HOST_MISMATCH`. The body depends only on the CALLER's own workspace (its canonical URL, or the default
 * APP_URL), so it is identical whether the host belongs to another workspace, is unknown, reserved, renamed or not READY
 * — nothing about the host is disclosed (CLAUDE.md: 404, not 403). It can only ever REFUSE: a matching host adds no
 * permission, and `ctx.workspaceId` is never changed. Requests with no session, and requests on the default/app/API
 * host (`none`), are untouched — so the mobile app (Bearer, API host, no Origin) is unaffected.
 */
@Injectable()
export class WorkspaceHostConsistencyInterceptor implements NestInterceptor {
  constructor(private readonly resolver: WorkspaceHostResolverService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<WorkspaceHostRequest & { authContext?: AuthContext }>();
    const host = request.workspaceHost;
    const ctx = request.authContext;
    if (!ctx || !host || host.kind === 'none') return next.handle();
    if (ANY_HOST_PATHS.has(request.path)) return next.handle();
    if (host.kind === 'workspace' && ctx.workspaceId !== null && ctx.workspaceId === host.workspaceId) return next.handle();
    if (host.kind === 'unavailable') return throwError(() => new ServiceUnavailableException({ code: 'WORKSPACE_HOST_UNAVAILABLE', message: 'Please try again shortly.' }));
    return from(this.mismatch(ctx)).pipe(mergeMap((error) => throwError(() => error)));
  }

  private async mismatch(ctx: AuthContext): Promise<NotFoundException> {
    const own = ctx.inspectedBy ? null : await this.resolver.canonicalOriginForWorkspace(ctx);
    return new NotFoundException({
      code: WORKSPACE_HOST_MISMATCH,
      message: 'Not found.',
      // The caller's OWN workspace address (DB label + env), or the default app URL. Never derived from the request.
      canonicalUrl: own ?? this.resolver.defaultAppUrl(),
    });
  }
}
