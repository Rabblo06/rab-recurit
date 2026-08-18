import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { AuthenticatedRequest } from '../core-modules/auth/guards/jwt-auth.guard';
import { AuthContext } from '../core-modules/tenant/auth-context.interface';

/** `@AuthUser() ctx: AuthContext` in a controller handler — never re-derive this from anywhere else. */
export const AuthUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthContext => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.authContext;
});
