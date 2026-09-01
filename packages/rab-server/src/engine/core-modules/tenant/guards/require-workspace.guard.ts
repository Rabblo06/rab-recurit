import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { AuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { ResourceScopeService } from '../../resource-scope/resource-scope.service';

/**
 * Stacked per-route (via `@UseGuards()`) on every CREATE endpoint that
 * stamps `workspaceId` directly from `ctx.workspaceId` (Staff/Venue/JobRole
 * creation — see `ResourceScopeService.assertHasWorkspace` for the full
 * rationale and why this applies uniformly with no CEO/Admin carve-out).
 * Never registered globally — unlike `MustResetPasswordGuard`, this only
 * protects a small, explicit set of routes, not "everything except an
 * allowlist," since Workspace onboarding's own endpoints (and every
 * Staff/Venue-Manager-facing read/self-service route) must keep working
 * with no Workspace at all.
 */
@Injectable()
export class RequireWorkspaceGuard implements CanActivate {
  constructor(private readonly resourceScope: ResourceScopeService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    this.resourceScope.assertHasWorkspace(request.authContext);
    return true;
  }
}
