import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { AuthenticatedRequest } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AiRecordNotFoundException } from '../exceptions/ai.exceptions';
import { AiSseService } from '../services/ai-sse.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The AI stream's pre-flight (layer 1): availability + ownership of the conversation AND the turn + the per-user stream
 * cap, run as a GUARD so that a refusal is a normal JSON response (uniform 404 for anything foreign or unavailable)
 * before Nest commits SSE headers. The service runs the same checks again when the stream opens (layer 2).
 */
@Injectable()
export class AiStreamAccessGuard implements CanActivate {
  constructor(private readonly sse: AiSseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const conversationId = String(request.params?.id ?? '');
    const turnId = String((request.query as Record<string, unknown>)?.turnId ?? '');
    if (!UUID.test(conversationId) || !UUID.test(turnId)) throw new AiRecordNotFoundException();
    await this.sse.assertCanOpen(request.authContext, conversationId, turnId);
    return true;
  }
}
