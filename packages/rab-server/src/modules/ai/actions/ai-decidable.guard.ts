import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { AuthenticatedRequest } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AiProposalAccessService } from './ai-proposal-access.service';

/**
 * Layer 1 for the proposal routes (p5 merge, Agent 5 Q4). Declarative, like `AiAvailableGuard`, and the same uniform
 * `404 AI_NOT_AVAILABLE` for every gate (Admin Inspect, `ai.use`, workspace, eligibility, kill switch, organisation
 * switch), so a user without `ai.use` learns nothing about the feature — a `PermissionGuard(ai.use)` 403 would. Unlike
 * `AiAvailableGuard`, a ready model is not required (P5-D9): deciding a proposal calls no model. The service re-checks
 * the same facts (layer 2) and again inside the decision's own transaction.
 */
@Injectable()
export class AiDecidableGuard implements CanActivate {
  constructor(private readonly access: AiProposalAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    await this.access.assertDecidable(request.authContext);
    return true;
  }
}
