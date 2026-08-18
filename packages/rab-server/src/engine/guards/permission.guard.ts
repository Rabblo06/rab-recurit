import { PermissionFlagType } from '@rab/shared';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Type, mixin } from '@nestjs/common';

import { AuthenticatedRequest } from '../core-modules/auth/guards/jwt-auth.guard';
import { PermissionsService } from '../core-modules/permissions/permissions.service';

/**
 * Mixin factory, not a per-controller inline check — used declaratively:
 * `@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.PAYROLL_APPROVE))`.
 * Runs AFTER `JwtAuthGuard` (needs `request.authContext` already attached).
 * rab-workforce-architecture.md §5.2.
 */
export const PermissionGuard = (required: PermissionFlagType): Type<CanActivate> => {
  @Injectable()
  class PermissionGuardMixin implements CanActivate {
    constructor(private readonly permissionsService: PermissionsService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      const allowed = await this.permissionsService.userHasPermission(request.authContext, required);
      if (allowed) return true;
      throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
    }
  }
  return mixin(PermissionGuardMixin);
};
