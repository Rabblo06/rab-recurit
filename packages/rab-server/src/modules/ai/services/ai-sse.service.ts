import { AiErrorCode, AiErrorCodeType, AiStreamEventV2 } from '@rab/shared';
import { Injectable, MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import {
  AI_SSE_KEEPALIVE_MS,
  AI_SSE_MAX_CONNECTIONS_PER_USER,
  AI_SSE_MAX_DURATION_MS,
  AI_SSE_POLL_FALLBACK_MS,
  AI_SSE_POLL_MS,
  AI_SSE_READ_COUNT,
} from '../constants/ai.constants';
import { AiAccessRevokedError, AiRecordNotFoundException, AiTooManyRequestsException } from '../exceptions/ai.exceptions';
import { AiAccessService } from './ai-access.service';
import { AiConversationService } from './ai-conversation.service';
import { AiRedisSubscriberProvider } from './ai-redis-subscriber.provider';
import { AI_STREAM_ID_PATTERN, AiStreamService, parseWake } from './ai-stream.service';

interface TurnState {
  status: string;
  content: string;
  error_code: string | null;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** A failed re-check ends the stream: a revocation (or the conversation/turn gone) is AI_ACCESS_REVOKED, anything else 503. */
export function recheckErrorCode(error: unknown): AiErrorCodeType {
  return error instanceof AiAccessRevokedError || error instanceof AiRecordNotFoundException ? AiErrorCode.ACCESS_REVOKED : AiErrorCode.SERVICE_UNAVAILABLE;
}

/**
 * `GET /rest/v1/ai/conversations/:id/stream?turnId=…` — the narrow AI SSE endpoint (the realtime gateway's envelope is
 * ID-only by design, so model text never travels through it).
 *
 *  - Authentication: the ordinary JwtAuthGuard session (cookie on the web; the turn id is in the query, never a token).
 *  - Authorisation before ANY byte: AI availability (kill switch, org switch, ai.use, eligibility, not inspecting) and
 *    ownership of the conversation AND the turn under RLS — a forged or foreign id is the uniform 404 (a normal JSON
 *    response, the stream never opens).
 *  - While open (Phase 2 §2.4): every AI_SSE_KEEPALIVE_MS (2 s) a FAIL-CLOSED re-check — session, account, organisation,
 *    ai.use, eligibility, both switches (`assertStillAllowed`) AND ownership of the conversation and the turn re-read
 *    under RLS — then a `keepalive` event whose SSE id is the CURRENT cursor (the resume position never moves; Nest would
 *    otherwise number it). A revocation, a deleted
 *    conversation or turn ends the stream with `error` AI_ACCESS_REVOKED; a database error with AI_SERVICE_UNAVAILABLE.
 *  - Reads: woken by the conversation's wake channel (`{t, id}` hints only — the text is read from the STREAM with this
 *    connection's own cursor), with a 1 s poll fallback, 250 ms while the subscriber connection is down.
 *  - Resume: events carry the Redis stream id as SSE `id`; a reconnect with `Last-Event-ID` continues after it. When the
 *    stream has expired or the turn is already finished, the PERSISTED message is sent as the final `done` — the model
 *    is never called again because a browser reconnected.
 *  - Bounded: ≤ AI_SSE_MAX_CONNECTIONS_PER_USER open streams per user per API instance, ≤ AI_SSE_MAX_DURATION_MS each,
 *    reads of ≤ AI_SSE_READ_COUNT entries; the client disconnecting stops reading and unsubscribes at once.
 */
@Injectable()
export class AiSseService {
  private readonly openPerUser = new Map<string, number>();

  constructor(
    private readonly access: AiAccessService,
    private readonly streams: AiStreamService,
    private readonly conversations: AiConversationService,
    private readonly tenantContext: TenantContextService,
    private readonly subscriberConnection: AiRedisSubscriberProvider,
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
    const actorIds = { organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId!, userId: ctx.userId, sessionId: ctx.sessionId ?? '' };

    return new Observable<MessageEvent>((subscriber) => {
      this.openPerUser.set(ctx.userId, (this.openPerUser.get(ctx.userId) ?? 0) + 1);
      let closed = false;
      let timer: NodeJS.Timeout | undefined;
      let busy = false;
      let wokenWhileBusy = false;
      let cursor = startCursor;
      let emptyReads = 0;
      let unsubscribeWake: (() => void) | null = null;
      const openedAt = Date.now();
      let lastRecheck = Date.now();

      // Every frame carries an explicit SSE id. Nest's SseStream numbers any frame WITHOUT one ("1", "2", …), and a
      // browser would then send that number back as Last-Event-ID (refused by the pattern ⇒ a full replay). Frames that
      // are not stream entries (keepalive, the database `done`, `error`) therefore carry the CURRENT cursor: the resume
      // position never moves for them.
      const emit = (event: AiStreamEventV2, id?: string) => subscriber.next({ id: id ?? cursor, type: event.type, data: event });
      const end = () => {
        if (!closed) subscriber.complete();
      };
      const fail = (errorCode: AiErrorCodeType) => {
        if (closed) return;
        emit({ type: 'error', turnId, errorCode });
        end();
      };
      /** Drains what is left on the stream, then answers from PostgreSQL (the persisted message is the answer). */
      const finish = async (turn: TurnState): Promise<void> => {
        const tail = await this.streams.read(conversationId, turnId, cursor, AI_SSE_READ_COUNT);
        for (const entry of tail) {
          if (entry.event.turnId !== turnId) continue;
          cursor = entry.id;
          emit(entry.event, entry.id);
          if (entry.event.type === 'done') return end();
        }
        emit({ type: 'done', turnId, status: turn.status as 'completed' | 'failed' | 'cancelled', errorCode: (turn.error_code as never) ?? null, content: turn.content });
        end();
      };
      const nextDelay = (): number => {
        const poll = this.subscriberConnection.ready && unsubscribeWake ? AI_SSE_POLL_FALLBACK_MS : AI_SSE_POLL_MS;
        return Math.max(0, Math.min(poll, AI_SSE_KEEPALIVE_MS - (Date.now() - lastRecheck)));
      };

      const step = async (): Promise<boolean> => {
        if (closed) return false;
        if (Date.now() - openedAt > AI_SSE_MAX_DURATION_MS) {
          end();
          return false;
        }
        if (Date.now() - lastRecheck >= AI_SSE_KEEPALIVE_MS) {
          lastRecheck = Date.now();
          let turn: TurnState;
          try {
            // Fail closed: session/account/organisation/ai.use/switches, then the conversation and the turn under RLS.
            await this.access.assertStillAllowed(actorIds);
            turn = await this.readTurn(ctx, conversationId, turnId);
          } catch (error) {
            fail(recheckErrorCode(error));
            return false;
          }
          if (closed) return false;
          emit({ type: 'keepalive', turnId }); // id = the current cursor: never moves the resume position
          if (TERMINAL.has(turn.status)) {
            await finish(turn);
            return false;
          }
        }
        const entries = await this.streams.read(conversationId, turnId, cursor, AI_SSE_READ_COUNT);
        if (closed) return false;
        for (const entry of entries) {
          if (entry.event.turnId !== turnId) continue; // never forward anything that is not this turn's
          cursor = entry.id;
          emit(entry.event, entry.id);
          if (entry.event.type === 'done') {
            end();
            return false;
          }
        }
        if (entries.length === 0) {
          emptyReads += 1;
          // First empty read: an already-finished turn (or an expired stream) is answered from the database at once.
          if (emptyReads === 1) {
            const turn = await this.readTurn(ctx, conversationId, turnId);
            if (TERMINAL.has(turn.status)) {
              await finish(turn);
              return false;
            }
          }
        } else {
          emptyReads = 0;
        }
        return true;
      };

      const schedule = (ms: number) => {
        if (closed) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(run, ms);
      };
      const run = () => {
        if (closed) return;
        if (busy) {
          wokenWhileBusy = true;
          return;
        }
        busy = true;
        step()
          .then((more) => {
            busy = false;
            if (!more || closed) return;
            if (wokenWhileBusy) {
              wokenWhileBusy = false;
              schedule(0);
            } else schedule(nextDelay());
          })
          .catch((error) => {
            busy = false;
            fail(recheckErrorCode(error));
          });
      };

      // Wake-ups (hints only): a `{t, id}` for THIS turn makes the next read happen now.
      void this.subscriberConnection
        .subscribe(this.streams.wake(conversationId), (payload) => {
          const wake = parseWake(payload);
          if (wake && wake.t === turnId) run();
        })
        .then((unsubscribe) => {
          if (closed) unsubscribe();
          else unsubscribeWake = unsubscribe;
        });
      run();

      return () => {
        closed = true;
        if (timer) clearTimeout(timer);
        unsubscribeWake?.();
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
