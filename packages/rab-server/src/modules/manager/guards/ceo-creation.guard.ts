import { ManagerType } from '@rab/shared';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { AuthenticatedRequest } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PlatformAdminService } from '../../../engine/core-modules/platform-admin/platform-admin.service';

/**
 * Stacked on `POST /managers` only, on top of the controller's class-level
 * `MANAGER_MANAGE` guard — same per-route-stacking idiom `resetPassword`
 * already uses. Without this, once a CEO account exists (holding
 * `MANAGER_MANAGE`, same as any Manager), it could mint a peer CEO through
 * the same route any other manager type is created through. CEO accounts
 * are meant to be small, rare, and powerful — creating one requires the
 * platform-admin claim, not just the ordinary manager-management flag.
 * Every other `type` value is unaffected by this guard.
 */
@Injectable()
export class CeoCreationGuard implements CanActivate {
  constructor(private readonly platformAdmin: PlatformAdminService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest & { body: { type?: string } }>();
    if (request.body?.type !== ManagerType.CEO) return true;

    const allowed = await this.platformAdmin.isPlatformAdmin(request.authContext);
    if (allowed) return true;
    throw new ForbiddenException('Only the platform administrator can create a CEO account.');
  }
}
