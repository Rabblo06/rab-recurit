import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException } from '@nestjs/common';

import { PlatformAdminService } from '../../platform-admin/platform-admin.service';
import { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Chained from `JwtAuthGuard`, same pattern as `MustResetPasswordGuard` —
 * only has anything to check once `request.authContext` is attached, so a
 * pre-auth route (login) is never blocked by this (a locked-out user must
 * still be able to log in, and the platform admin must still be able to
 * log in to turn maintenance mode back off).
 *
 * Checks `PlatformAdminService.isPlatformAdmin` — never a revocable
 * PermissionFlag/role — so the one caller who can turn maintenance mode
 * off can always still reach the endpoint that does it, regardless of
 * what maintenance mode itself has disabled for everyone else.
 *
 * P1C: `enabled` reads `request.authContext.security.maintenanceModeEnabled` — the ONE
 * consolidated security snapshot `JwtAuthGuard` already built — instead of its own separate
 * `core.platform_config` query/transaction. Safe unchanged even under Admin Inspect: maintenance
 * mode is keyed by `organisationId`, which the inspect-header rewrite never touches (`§7`'s
 * platform-admin redesign retired Admin as a workspace owner; `organisationId` stays the real
 * admin's own throughout). The `isPlatformAdmin` half below keeps its own direct DB check instead
 * — see that branch's own comment for why reusing the snapshot there would be a real behaviour
 * change, not a safe optimisation.
 */
@Injectable()
export class MaintenanceModeGuard implements CanActivate {
  constructor(private readonly platformAdmin: PlatformAdminService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.authContext) return true;

    const enabled = request.authContext.security?.maintenanceModeEnabled ?? false;
    if (!enabled) return true;

    // Deliberately NOT `request.authContext.security.isPlatformAdmin` here: that snapshot field
    // was computed for the identity BEFORE any Admin Inspect rewrite, but this check must answer
    // "is the CURRENT `request.authContext.userId` (the inspected TARGET, during inspect) a
    // platform admin" — exactly what this call already asked before P1C, preserved verbatim
    // rather than silently changed to ask about the real admin's own status instead.
    if (await this.platformAdmin.isPlatformAdmin(request.authContext)) return true;

    throw new ServiceUnavailableException('This workspace is temporarily down for maintenance.');
  }
}
