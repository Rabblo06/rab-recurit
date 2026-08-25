import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException } from '@nestjs/common';

import { PlatformAdminService } from '../../platform-admin/platform-admin.service';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { PlatformConfig } from '../../../../modules/identity/entities';
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
 */
@Injectable()
export class MaintenanceModeGuard implements CanActivate {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly platformAdmin: PlatformAdminService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.authContext) return true;

    const enabled = await this.tenantContext.runInTenantContext(request.authContext, async (manager) => {
      const config = await manager.findOne(PlatformConfig, {
        where: { organisationId: request.authContext.organisationId! },
      });
      return config?.maintenanceModeEnabled ?? false;
    });
    if (!enabled) return true;

    if (await this.platformAdmin.isPlatformAdmin(request.authContext)) return true;

    throw new ServiceUnavailableException('This workspace is temporarily down for maintenance.');
  }
}
