import { Reflector } from '@nestjs/core';
import { MANAGER_APPLICATION } from './manager-application.decorator';
import { PlatformAdminService } from '../../platform-admin/platform-admin.service';
import { ApplicationTarget, applicationAllowed, applicationDenied, APPLICATION_TARGETS } from '../application-access';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

import { AdminInspectService } from '../../platform-admin/admin-inspect.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { WorkspaceResolverService } from '../../tenant/workspace-resolver.service';
import { AccessTokenService } from '../token/services/access-token.service';
import { SessionValidityService } from '../services/session-validity.service';
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
    private readonly tenantContext: TenantContextService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly sessionValidity: SessionValidityService,
    private readonly reflector: Reflector,
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
        applicationTarget: payload.applicationTarget,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    request.authContext.workspaceId = await this.workspaceResolver.resolveForUser(request.authContext.userId);

    // PHASE 10 / AUTH-02: a valid, unexpired JWT signature proves who signed
    // it, not that the SESSION it was minted from is still alive — logout,
    // reuse-detection revocation, password reset/change, and the absolute
    // session deadline all only ever touched `core.refresh_token` before
    // this check existed. Fails closed: an error here (including a
    // transient DB issue) is not distinguished from "invalid" at the HTTP
    // layer — the caller gets 401 either way, per Phase 10 §22 — but IS
    // distinguished in logs so an outage isn't silently misread as an attack.
    try {
      await this.tenantContext.runInTenantContext(request.authContext, (manager) =>
        this.sessionValidity.assertActive(manager, {
          userId: request.authContext.userId,
          organisationId: request.authContext.organisationId,
          sid: request.authContext.sessionId!,
        }),
      );
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      // eslint-disable-next-line no-console
      console.error('Session validity check failed unexpectedly (treated as not-active, fail-closed):', error);
      throw new UnauthorizedException('Please sign in again.');
    }

    const target = request.authContext.applicationTarget;
    if (!target || !APPLICATION_TARGETS.includes(target)) throw new UnauthorizedException('Please sign in again.');
    if (this.reflector.getAllAndOverride<boolean>(MANAGER_APPLICATION, [context.getHandler(), context.getClass()]) && target !== 'manager_web') throw applicationDenied('manager_web');
    const expected = request.headers['x-application-target'];
    if (expected && expected !== target) throw applicationDenied(APPLICATION_TARGETS.includes(expected as ApplicationTarget) ? expected as ApplicationTarget : target);
    const roles = await this.tenantContext.runInTenantContext(request.authContext, async manager => {
      const rows = await manager.query('SELECT r.key FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $1', [request.authContext.userId]);
      return rows.map((r: {key: string}) => r.key);
    });
    if (!applicationAllowed(roles, target, await this.platformAdmin.isPlatformAdmin(request.authContext))) {
      // A deleted/suspended/deactivated account has no (or revoked) roles, so its still-valid token would otherwise read
      // as "not allowed in this app" (403). Let the account-status check speak first: the session has ENDED (401), which
      // is what every client must handle by signing out. An active account outside its app still gets the 403.
      await this.activeAccountGuard.canActivate(context);
      throw applicationDenied(target);
    }
    request.authContext.role = roles.join(',');
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
