import { PermissionFlagType } from '@rab/shared';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Type, mixin } from '@nestjs/common';

import { AuthenticatedRequest } from '../core-modules/auth/guards/jwt-auth.guard';
import { PermissionsService } from '../core-modules/permissions/permissions.service';
import { timeStage } from '../observability/request-context';

/**
 * Mixin factory, not a per-controller inline check — used declaratively:
 * `@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.PAYROLL_APPROVE))`.
 * Runs AFTER `JwtAuthGuard` (needs `request.authContext` already attached).
 * rab-workforce-architecture.md §5.2.
 *
 * P1C: the common case is now an in-memory `.has(required)` lookup against
 * `request.authContext.security.effectivePermissions` — the ONE consolidated PostgreSQL security
 * snapshot `JwtAuthGuard` already built this request, which already resolved role-granted
 * permissions AND per-user overrides (the exact same precedence `PermissionsService
 * .userHasPermissionTx` computes one flag at a time) — zero additional SQL, zero additional
 * transaction. The Admin Inspect path keeps its own direct DB check: `security` was computed for
 * the ADMIN's own identity, before the inspect-header rewrite, and an inspected GET must be
 * evaluated against the TARGET's own permissions, never the admin's — reusing the snapshot there
 * would silently authorize based on the wrong user's grants.
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

      const allowed = request.authContext.inspectedBy
        ? await timeStage('permission_check', () => this.permissionsService.userHasPermission(request.authContext, required))
        : await timeStage('permission_check', () => Promise.resolve(request.authContext.security?.effectivePermissions.has(required) ?? false));
      if (allowed) return true;
      throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
    }
  }
  return mixin(PermissionGuardMixin);
};
