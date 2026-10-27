import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { AuthenticatedRequest } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AiAccessService } from '../services/ai-access.service';

/**
 * Layer 1 for every AI route that needs AI to be available (declarative, `@UseGuards(JwtAuthGuard, AiAvailableGuard)` —
 * never an inline check in a handler). It runs the same `AiAccessService.assertAvailable` the services run again
 * (layer 2), in the order of docs/ai/PHASE1_TWENTY_PLAN.md §6, and throws the exception the evaluation names:
 *   - not an Admin Inspect session, `ai.use`, a workspace, CEO / current Initial Manager eligibility, the platform kill
 *     switch, the organisation switch → the SAME `404 AI_NOT_AVAILABLE` (which gate refused is never disclosed);
 *   - then, to an eligible user of an enabled organisation only: `503 AI_NOT_CONFIGURED` (no model resolves) or
 *     `403 AI_DEMO_DATA_ONLY` (a real provider and the organisation is not synthetic, EX-1). Fixed texts only.
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
