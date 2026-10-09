import { CanActivate, ExecutionContext, ForbiddenException, Injectable, mixin, Type } from '@nestjs/common';

import { EnvironmentService } from '../../environment/environment.service';

/**
 * P1C.1B — SYSTEM-level gate only (layer 1 of CLAUDE.md's 5-layer model). The organisation
 * doesn't exist as a known value until the OAuth callback resolves an identity, so the
 * tenant-level check (`OrganisationAuthProvidersService.assertProviderEnabledOrThrow`, layer 2)
 * cannot run here — it runs inside `AuthService.signInWithProvider` instead, which is why that
 * service-layer check exists independently rather than trusting this guard alone.
 */
export function AuthProviderEnabledGuard(provider: 'google' | 'microsoft'): Type<CanActivate> {
  @Injectable()
  class Guard implements CanActivate {
    constructor(private readonly env: EnvironmentService) {}

    canActivate(_context: ExecutionContext): boolean {
      const enabled = provider === 'google' ? this.env.get('AUTH_GOOGLE_ENABLED') : this.env.get('AUTH_MICROSOFT_ENABLED');
      if (!enabled) {
        throw new ForbiddenException(`${provider === 'google' ? 'Google' : 'Microsoft'} sign-in is not enabled on this deployment.`);
      }
      return true;
    }
  }
  return mixin(Guard);
}
