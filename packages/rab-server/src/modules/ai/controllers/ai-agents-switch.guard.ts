import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { AuthenticatedRequest } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AiAgentAuthority } from '../services/ai-agent-authority.service';

/**
 * Layer 1 for every `/rest/v1/ai/agents` route (declarative, after JwtAuthGuard). p6 merge: the FULL gate, every refusal
 * the uniform 404 AI_NOT_AVAILABLE (the p5 Q4 / AiDecidableGuard decision — a PermissionGuard 403 would disclose the
 * feature): Admin Inspect, `AI_AGENTS_ENABLED` / `AI_ENABLED` off, no `ai.use`, no `ai.agents.manage` (re-read from
 * PostgreSQL), not the CEO, the organisation's AI or agents switch off. The services re-run all of it (layer 2).
 */
@Injectable()
export class AiAgentsSwitchGuard implements CanActivate {
  constructor(private readonly authority: AiAgentAuthority) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    await this.authority.assertManager(request.authContext);
    return true;
  }
}
