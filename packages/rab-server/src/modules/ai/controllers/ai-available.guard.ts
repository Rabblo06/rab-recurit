import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { AuthenticatedRequest } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AiAccessService } from '../services/ai-access.service';

/**
 * Layer 1 for every AI route that needs AI to be available (declarative, `@UseGuards(JwtAuthGuard, AiAvailableGuard)` —
 * never an inline check in a handler). It runs the same `AiAccessService.assertAvailable` the services run again
 * (layer 2): platform kill switch, organisation switch, `ai.use` (from the request's server-built security snapshot),
 * CEO / current Initial Manager eligibility, a workspace, and not an Admin Inspect session. Every refusal is the SAME
 * `404 AI_NOT_AVAILABLE` (the report's "every AI route 404 when off"; which gate refused is never disclosed).
 */
@Injectable()
export class AiAvailableGuard implements CanActivate {
  constructor(private readonly access: AiAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    await this.access.assertAvailable(request.authContext);
    return true;
  }
}
