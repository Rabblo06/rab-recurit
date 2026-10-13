import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { PlatformAdminService } from '../../platform-admin/platform-admin.service';
import { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * P2.8 — chained from `JwtAuthGuard`, same pattern as `MaintenanceModeGuard`. A suspended
 * organisation's already-issued access tokens/cookies otherwise keep working until their own
 * natural expiry; this is the one place that gets closed, reusing the SAME security-version-vector
 * cache-busting `suspend()`/`reactivate()` already trigger (`SecurityVersionService.bumpOrganisation`)
 * — no separate session-revocation mechanism, per the owner's explicit P2.8 instruction to reuse
 * `AuthSecuritySnapshot`/session-invalidation rather than build a new one.
 *
 * Exempt: `/auth/logout` (a suspended org's users must still be able to clear their own local
 * session) and a platform admin's own identity — Crewflow staff must be able to log in and
 * operate normally against a suspended tenant in order to investigate or reactivate it. Uses
 * `PlatformAdminService.isPlatformAdmin` directly (never the snapshot's own `isPlatformAdmin`
 * field) for the exact same reason `MaintenanceModeGuard` does: this must answer for the CURRENT
 * `request.authContext.userId` (the Admin Inspect target, if inspecting), not the identity
 * resolved before any inspect-header rewrite.
 */
const EXEMPT_PATHS = new Set(['/rest/v1/auth/logout']);

@Injectable()
export class OrganisationSuspendedGuard implements CanActivate {
  constructor(private readonly platformAdmin: PlatformAdminService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.authContext) return true;
    if (EXEMPT_PATHS.has(request.path)) return true;

    const suspended = request.authContext.security?.organisationSuspended ?? false;
    if (!suspended) return true;

    if (await this.platformAdmin.isPlatformAdmin(request.authContext)) return true;

    throw new UnauthorizedException('This organisation has been suspended. Contact your administrator.');
  }
}
