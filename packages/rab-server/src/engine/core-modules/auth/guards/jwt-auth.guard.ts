import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

import { AdminInspectService } from '../../platform-admin/admin-inspect.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { WorkspaceResolverService } from '../../tenant/workspace-resolver.service';
import { AccessTokenService } from '../token/services/access-token.service';
import { ActiveAccountGuard } from './active-account.guard';
import { MaintenanceModeGuard } from './maintenance-mode.guard';
import { MustResetPasswordGuard } from './must-reset-password.guard';

const INSPECT_SESSION_HEADER = 'x-inspect-session-id';
// Ending inspection using the inspected identity would be nonsensical —
// this path prefix always runs as the admin's own real identity, header or not.
const INSPECT_ROUTE_PREFIX = '/rest/v1/admin/inspect';

export interface AuthenticatedRequest extends Request {
  authContext: AuthContext;
}

function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length);
}

/**
 * Layer 1 of the guard chain (rab-workforce-architecture.md §5.2): valid,
 * unexpired, correctly-signed access token. Attaches `request.authContext`,
 * consumed by `PermissionGuard` and every controller/service downstream —
 * never re-derived from anywhere else.
 *
 * Also runs `MustResetPasswordGuard` and `MaintenanceModeGuard` right after
 * attaching the context, rather than registering either as a separate
 * global (`APP_GUARD`) guard — Nest always runs global guards before any
 * controller-level `@UseGuards` ones, so a standalone global guard would
 * run before this one ever sets `request.authContext` and would have
 * nothing to check. Delegating from here is what makes them actually run
 * in the right place, on every route this guard already protects.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly accessTokenService: AccessTokenService,
    private readonly activeAccountGuard: ActiveAccountGuard,
    private readonly mustResetPasswordGuard: MustResetPasswordGuard,
    private readonly maintenanceModeGuard: MaintenanceModeGuard,
    private readonly adminInspectService: AdminInspectService,
    private readonly workspaceResolver: WorkspaceResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const payload = this.accessTokenService.verify(token);
      request.authContext = {
        userId: payload.sub,
        organisationId: payload.org,
        // Resolved fresh from the DB below, never trusted from the token —
        // no `workspace` claim exists in the JWT at all, deliberately (see
        // AuthContext.workspaceId's own doc comment).
        workspaceId: null,
        role: payload.roles.join(','),
        sessionId: payload.sid,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    request.authContext.workspaceId = await this.workspaceResolver.resolveForUser(request.authContext.userId);

    await this.applyInspectHeader(request);

    await this.activeAccountGuard.canActivate(context);
    await this.mustResetPasswordGuard.canActivate(context);
    return this.maintenanceModeGuard.canActivate(context);
  }

  /**
   * Rebuilds `request.authContext` to the inspected target's identity when
   * a live session is proven to belong to the CALLING admin's own
   * already-verified token — the header is only ever a lookup key, never
   * trusted on its own. Any invalid/foreign/ended session id is silently
   * ignored (fail-closed to the admin's real identity), never an error, so
   * a stale or forged header can't even be used to distinguish "session
   * exists" from "session doesn't" via response codes.
   */
  private async applyInspectHeader(request: AuthenticatedRequest): Promise<void> {
    if (request.path.startsWith(INSPECT_ROUTE_PREFIX)) return;

    const sessionId = request.headers[INSPECT_SESSION_HEADER];
    if (typeof sessionId !== 'string' || !sessionId) return;

    const adminCtx = request.authContext;
    const target = await this.adminInspectService.resolveActiveTarget(adminCtx, sessionId);
    if (!target) return;

    request.authContext = {
      ...adminCtx,
      userId: target.targetUserId,
      // Re-resolved for the TARGET, not inherited from the admin — reads
      // must scope to the inspected user's own workspace, never the
      // admin's (which may not even exist, per §7's platform-admin
      // redesign — Admin is no longer a Workspace owner by construction).
      workspaceId: await this.workspaceResolver.resolveForUser(target.targetUserId),
      role: '',
      inspectedBy: adminCtx.userId,
    };
  }
}
