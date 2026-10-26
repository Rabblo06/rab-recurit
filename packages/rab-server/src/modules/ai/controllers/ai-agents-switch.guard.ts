import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { AuthenticatedRequest } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AiAgentAuthority } from '../services/ai-agent-authority.service';

/**
 * Layer 1 for every `/rest/v1/ai/agents` route (declarative, after JwtAuthGuard and BEFORE the permission guard): an
 * Admin Inspect session, or `AI_AGENTS_ENABLED` / `AI_ENABLED` off, is the uniform 404 AI_NOT_AVAILABLE for everyone —
 * the routes do not exist for anybody while the platform switch is off (P6 §5 "Off"). No database read. The services
 * re-run it and every other check (layer 2).
 */
@Injectable()
export class AiAgentsSwitchGuard implements CanActivate {
  constructor(private readonly authority: AiAgentAuthority) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    this.authority.assertSwitchedOn(request.authContext);
    return true;
  }
}
