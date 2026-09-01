import { UserStatus } from '@rab/shared';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { TenantContextService } from '../../tenant/tenant-context.service';
import { User } from '../../../../modules/identity/entities';
import { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Chained from `JwtAuthGuard`, same pattern as `MustResetPasswordGuard`/
 * `MaintenanceModeGuard`. A cryptographically valid, unexpired access token
 * proves who signed in — it says nothing about whether that account is
 * still allowed in *right now*. Before this guard existed, deactivating
 * Staff or suspending a Manager only ever changed a status column nothing
 * else read: the account's existing access token kept working until its own
 * 15-minute expiry, and its refresh token (unless the caller separately
 * revoked it) could mint new ones indefinitely. This is the single place
 * that check lives, rather than an `if (user.status...)` scattered across
 * every controller that touches account state.
 *
 * Exempt: `/auth/logout` (a disabled account must still be able to clear
 * its own local session) and any request already running as an Admin
 * Inspect target (`authContext.inspectedBy` set) — inspecting a deactivated
 * or suspended account's data is a legitimate, read-only investigative use
 * of that feature and shouldn't be blocked by the very status being
 * investigated. The admin's *own* account was already required to be
 * active to reach that point, since the inspect-header rewrite in
 * `JwtAuthGuard` only ever runs after this guard would otherwise have
 * checked the admin's real identity on the very same request.
 */
const EXEMPT_PATHS = new Set(['/rest/v1/auth/logout']);

@Injectable()
export class ActiveAccountGuard implements CanActivate {
  constructor(private readonly tenantContext: TenantContextService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.authContext) return true;
    if (EXEMPT_PATHS.has(request.path)) return true;
    if (request.authContext.inspectedBy) return true;

    const user = await this.tenantContext.runInTenantContext(request.authContext, (manager) =>
      manager.findOne(User, { where: { id: request.authContext.userId }, select: { status: true } }),
    );

    if (!user || user.status === UserStatus.SUSPENDED || user.status === UserStatus.DEACTIVATED) {
      throw new UnauthorizedException('This account is no longer active.');
    }
    return true;
  }
}
