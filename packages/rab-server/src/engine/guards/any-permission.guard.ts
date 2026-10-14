import { PermissionFlagType } from '@rab/shared';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Type, mixin } from '@nestjs/common';

import { AuthenticatedRequest } from '../core-modules/auth/guards/jwt-auth.guard';
import { PermissionsService } from '../core-modules/permissions/permissions.service';
import { timeStage } from '../observability/request-context';

/**
 * `PermissionGuard`'s sibling for routes that serve several roles, each authorised by a different flag — for
 * example member invitations, where inviting Staff needs STAFF_CREATE, a Venue Manager VENUE_MANAGER_CREATE or
 * MANAGER_MANAGE, and an additional Manager MANAGER_MANAGE. Passes when the caller holds AT LEAST ONE of the
 * flags; the service then decides, per operation, exactly which flag the specific action needs (CLAUDE.md
 * layer 2). Same snapshot-first evaluation and the same Admin Inspect rules as `PermissionGuard`.
 */
export const AnyPermissionGuard = (...flags: PermissionFlagType[]): Type<CanActivate> => {
  if (flags.length === 0) throw new Error('AnyPermissionGuard requires at least one permission flag.');

  @Injectable()
  class AnyPermissionGuardMixin implements CanActivate {
    constructor(private readonly permissionsService: PermissionsService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      if (request.authContext.inspectedBy && request.method !== 'GET') {
        throw new ForbiddenException('This action is unavailable while inspecting another user.');
      }
      const allowed = await timeStage('permission_check', async () => {
        if (!request.authContext.inspectedBy) {
          const held = request.authContext.security?.effectivePermissions;
          return held ? flags.some((flag) => held.has(flag)) : false;
        }
        for (const flag of flags) {
          if (await this.permissionsService.userHasPermission(request.authContext, flag)) return true;
        }
        return false;
      });
      if (allowed) return true;
      throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
    }
  }
  return mixin(AnyPermissionGuardMixin);
};
