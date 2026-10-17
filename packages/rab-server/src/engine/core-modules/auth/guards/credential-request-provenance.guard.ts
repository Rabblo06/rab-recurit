import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { EnvironmentService } from '../../environment/environment.service';
import { assertCredentialIssuingRequestProvenance } from './cookie-csrf.util';

/**
 * CF-05: the login-CSRF provenance rule (`assertCredentialIssuingRequestProvenance`) as a guard, so it runs before body
 * validation and before any credential work: a forged cross-site request is refused for what it is (415 / 403), never
 * reaches authentication, and never receives a cookie.
 */
@Injectable()
export class CredentialRequestProvenanceGuard implements CanActivate {
  constructor(private readonly env: EnvironmentService) {}

  canActivate(context: ExecutionContext): boolean {
    assertCredentialIssuingRequestProvenance(context.switchToHttp().getRequest<Request>(), (origin) => this.env.isTrustedOrigin(origin));
    return true;
  }
}
