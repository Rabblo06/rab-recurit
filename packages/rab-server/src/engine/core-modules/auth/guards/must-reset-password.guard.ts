import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { TenantContextService } from '../../tenant/tenant-context.service';
import { User } from '../../../../modules/identity/entities';
import { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Global guard (registered as APP_GUARD in app.module.ts) — runs on every
 * request, but only has anything to check once `JwtAuthGuard` has already
 * attached `request.authContext` (a route with no auth guard at all, e.g.
 * `/auth/login`, has nothing to enforce here and passes through).
 *
 * This is the actual server-side control behind "staff acceptance does not
 * mean confirmation"'s sibling rule for accounts: "temporary credentials do
 * not mean full access." The frontend redirect to the set-password screen
 * is UX; a client that skips it (or calls the API directly) is still
 * blocked here.
 */
const EXEMPT_PATHS = new Set(['/rest/v1/auth/me', '/rest/v1/auth/set-password', '/rest/v1/auth/logout']);

@Injectable()
export class MustResetPasswordGuard implements CanActivate {
  constructor(private readonly tenantContext: TenantContextService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.authContext) return true;
    if (EXEMPT_PATHS.has(request.path)) return true;

    let mustReset: boolean;
    if (request.authContext.inspectedBy) {
      // P1C: `request.authContext.security` was built for the ADMIN's own identity, before the
      // inspect-header rewrite — it must never be reused here, which would silently check the
      // ADMIN's own must-reset status instead of the INSPECTED TARGET's. Rare, read-mostly path;
      // a direct lookup here (same query this guard always ran before P1C) is the correct,
      // narrow exception, not a reason to teach the snapshot to carry two users' state at once.
      const row = await this.tenantContext.runInTenantContext(request.authContext, (manager) =>
        manager.findOne(User, { where: { id: request.authContext.userId }, select: { mustResetPassword: true } }),
      );
      mustReset = row?.mustResetPassword ?? false;
    } else {
      mustReset = request.authContext.security?.mustResetPassword ?? false;
    }

    if (mustReset) {
      throw new ForbiddenException('You must set a new password before continuing.');
    }
    return true;
  }
}
