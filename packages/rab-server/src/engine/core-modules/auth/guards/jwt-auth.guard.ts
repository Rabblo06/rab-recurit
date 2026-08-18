import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

import { AuthContext } from '../../tenant/auth-context.interface';
import { AccessTokenService } from '../token/services/access-token.service';
import { MustResetPasswordGuard } from './must-reset-password.guard';

export interface AuthenticatedRequest extends Request {
  authContext: AuthContext;
}

function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length);
}

/**
 * Layer 1 of the guard chain (rab-workforce-architecture.md §5.2): valid,
 * unexpired, correctly-signed access token. Attaches `request.authContext`,
 * consumed by `PermissionGuard` and every controller/service downstream —
 * never re-derived from anywhere else.
 *
 * Also runs `MustResetPasswordGuard` right after attaching the context,
 * rather than registering that as a separate global (`APP_GUARD`) guard —
 * Nest always runs global guards before any controller-level `@UseGuards`
 * ones, so a standalone global guard would run before this one ever sets
 * `request.authContext` and would have nothing to check. Delegating from
 * here is what makes it actually run in the right place, on every route
 * this guard already protects.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly accessTokenService: AccessTokenService,
    private readonly mustResetPasswordGuard: MustResetPasswordGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const payload = this.accessTokenService.verify(token);
      request.authContext = {
        userId: payload.sub,
        organisationId: payload.org,
        role: payload.roles.join(','),
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    return this.mustResetPasswordGuard.canActivate(context);
  }
}
