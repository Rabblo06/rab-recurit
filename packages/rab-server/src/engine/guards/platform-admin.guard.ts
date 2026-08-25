import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { AuthenticatedRequest } from '../core-modules/auth/guards/jwt-auth.guard';
import { PlatformAdminService } from '../core-modules/platform-admin/platform-admin.service';

/**
 * Guards every Admin Panel route: `@UseGuards(JwtAuthGuard, PlatformAdminGuard)`.
 * Unlike `PermissionGuard`, this takes no parameter and checks a dedicated
 * claim table, never a grantable `PermissionFlag` — see
 * `PlatformAdminService`'s docstring for why. Runs AFTER `JwtAuthGuard`
 * (needs `request.authContext` already attached).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly platformAdmin: PlatformAdminService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const allowed = await this.platformAdmin.isPlatformAdmin(request.authContext);
    if (allowed) return true;
    throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
  }
}
