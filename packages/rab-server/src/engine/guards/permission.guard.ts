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

      // Admin Inspect is read-only, unconditionally — checked before the
      // permission lookup so it can never be bypassed by anything the
      // inspected identity happens to be permitted to do.
      if (request.authContext.inspectedBy && request.method !== 'GET') {
        throw new ForbiddenException('This action is unavailable while inspecting another user.');
      }

      const allowed = await this.permissionsService.userHasPermission(request.authContext, required);
      if (allowed) return true;
      throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
    }
  }
  return mixin(PermissionGuardMixin);
};
