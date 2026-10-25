import { AiErrorCode, AiStreamEvent } from '@rab/shared';
import { Injectable, MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AI_SSE_MAX_CONNECTIONS_PER_USER, AI_SSE_MAX_DURATION_MS, AI_SSE_POLL_MS, AI_SSE_READ_COUNT, AI_SSE_REVALIDATE_MS } from '../constants/ai.constants';
import { AiRecordNotFoundException, AiTooManyRequestsException } from '../exceptions/ai.exceptions';
import { AiAccessService } from './ai-access.service';
import { AiConversationService } from './ai-conversation.service';
import { AI_STREAM_ID_PATTERN, AiStreamService } from './ai-stream.service';

interface TurnState {
  status: string;
  content: string;
  error_code: string | null;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
/** Empty polls between two database checks of a turn's state (≈ 2 s at the 250 ms poll). */
const DB_CHECK_EVERY_EMPTY_POLLS = 8;

/**
 * `GET /rest/v1/ai/conversations/:id/stream?turnId=…` — the narrow AI SSE endpoint (the realtime gateway's envelope is
 * ID-only by design, so model text never travels through it).
 *
 *  - Authentication: the ordinary JwtAuthGuard session (cookie on the web; the turn id is in the query, never a token).
 *  - Authorisation before ANY byte: AI availability (kill switch, org switch, ai.use, eligibility, not inspecting) and
 *    ownership of the conversation AND the turn under RLS — a forged or foreign id is the uniform 404 (a normal JSON
 *    response, the stream never opens).
 *  - While open: every AI_SSE_REVALIDATE_MS the session, account, organisation and AI gates are re-checked; a
 *    revocation ends the stream with an `error` event (AI_ACCESS_REVOKED).
 *  - Resume: events carry the Redis stream id as SSE `id`; a reconnect with `Last-Event-ID` continues after it. When the
 *    stream has expired or the turn is already finished, the PERSISTED message is sent as the final `done` — the model
 *    is never called again because a browser reconnected.
 *  - Bounded: ≤ AI_SSE_MAX_CONNECTIONS_PER_USER open streams per user per API instance, ≤ AI_SSE_MAX_DURATION_MS each,
 *    reads of ≤ AI_SSE_READ_COUNT entries; the client disconnecting stops polling at once.
 */
@Injectable()
export class AiSseService {
  private readonly openPerUser = new Map<string, number>();

  constructor(
    private readonly access: AiAccessService,
    private readonly streams: AiStreamService,
    private readonly conversations: AiConversationService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Everything that must hold BEFORE the stream opens (availability, ownership of the conversation and the turn, the
   * per-user connection cap). Called by `AiStreamAccessGuard` — a guard, so a refusal is an ordinary JSON 404/429 response;
   * once Nest has started an SSE response a thrown error could only become an in-stream event.
   */
  async assertCanOpen(ctx: AuthContext, conversationId: string, turnId: string): Promise<void> {
    await this.access.assertAvailable(ctx);
    await this.readTurn(ctx, conversationId, turnId);
    if ((this.openPerUser.get(ctx.userId) ?? 0) >= AI_SSE_MAX_CONNECTIONS_PER_USER) throw new AiTooManyRequestsException(AiErrorCode.RATE_LIMITED, 5);
  }

  async open(ctx: AuthContext, conversationId: string, turnId: string, lastEventId: string | undefined): Promise<Observable<MessageEvent>> {
    await this.assertCanOpen(ctx, conversationId, turnId); // layer 2 (the guard ran the same checks)
    const startCursor = lastEventId && AI_STREAM_ID_PATTERN.test(lastEventId) ? lastEventId : '0-0';

    return new Observable<MessageEvent>((subscriber) => {
      this.openPerUser.set(ctx.userId, (this.openPerUser.get(ctx.userId) ?? 0) + 1);
      let closed = false;
      let timer: NodeJS.Timeout | undefined;
      let cursor = startCursor;
      let emptyPolls = 0;
      const openedAt = Date.now();
      let checkedAt = Date.now();

      const emit = (event: AiStreamEvent, id?: string) => subscriber.next({ id, type: event.type, data: event });
      const end = () => {
        if (!closed) subscriber.complete();
      };
      const finishFromDatabase = async () => {
        const turn = await this.readTurn(ctx, conversationId, turnId);
        emit({ type: 'done', turnId, status: turn.status as 'completed' | 'failed' | 'cancelled', errorCode: (turn.error_code as never) ?? null, content: turn.content });
        end();
      };

      const tick = async (): Promise<void> => {
        if (closed) return;
        if (Date.now() - openedAt > AI_SSE_MAX_DURATION_MS) return end();
        if (Date.now() - checkedAt > AI_SSE_REVALIDATE_MS) {
          checkedAt = Date.now();
          try {
            await this.access.assertStillAllowed({ organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId!, userId: ctx.userId, sessionId: ctx.sessionId ?? '' });
          } catch {
            emit({ type: 'error', turnId, errorCode: AiErrorCode.ACCESS_REVOKED });
            return end();
          }
        }
        const entries = await this.streams.read(turnId, cursor, AI_SSE_READ_COUNT);
        if (closed) return;
        for (const entry of entries) {
          if (entry.event.turnId !== turnId) continue; // never forward anything that is not this turn's
          cursor = entry.id;
          emit(entry.event, entry.id);
          if (entry.event.type === 'done') return end();
        }
        if (entries.length === 0) {
          emptyPolls += 1;
          if (emptyPolls % DB_CHECK_EVERY_EMPTY_POLLS === 1) {
            const turn = await this.readTurn(ctx, conversationId, turnId);
            if (TERMINAL.has(turn.status)) {
              const tail = await this.streams.read(turnId, cursor, AI_SSE_READ_COUNT);
              for (const entry of tail) {
                cursor = entry.id;
                emit(entry.event, entry.id);
                if (entry.event.type === 'done') return end();
              }
              return finishFromDatabase();
            }
          }
        } else {
          emptyPolls = 0;
        }
        timer = setTimeout(run, AI_SSE_POLL_MS);
      };
      const run = () => {
        tick().catch(() => {
          if (closed) return;
          emit({ type: 'error', turnId, errorCode: AiErrorCode.SERVICE_UNAVAILABLE });
          end();
        });
      };
      run();

      return () => {
        closed = true;
        if (timer) clearTimeout(timer);
        const n = (this.openPerUser.get(ctx.userId) ?? 1) - 1;
        if (n <= 0) this.openPerUser.delete(ctx.userId);
        else this.openPerUser.set(ctx.userId, n);
      };
    });
  }

  /** Open streams on this API instance (metrics/tests). */
  openCount(): number {
    let total = 0;
    for (const n of this.openPerUser.values()) total += n;
    return total;
  }

  private async readTurn(ctx: AuthContext, conversationId: string, turnId: string): Promise<TurnState> {
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      await this.conversations.ownConversation(m, ctx, conversationId);
      const [turn] = await m.query<TurnState[]>(
        `SELECT status, content, error_code FROM core.ai_message WHERE id = $1 AND conversation_id = $2 AND role = 'assistant' AND user_id = $3`,
        [turnId, conversationId, ctx.userId],
      );
      if (!turn) throw new AiRecordNotFoundException();
      return turn;
    });
  }
}
