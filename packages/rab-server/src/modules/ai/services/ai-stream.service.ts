import { AiStreamEventV2 } from '@rab/shared';
import { Injectable } from '@nestjs/common';

import { AI_CANCEL_FLAG_TTL_SECONDS, AI_STREAM_MAX_ENTRIES, AI_STREAM_TTL_SECONDS } from '../constants/ai.constants';
import { AiCancelMessage, AiStreamKeys, AiWakeMessage } from '../contracts/turn';
import { AiQuotaUnavailableError } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';
import { AiRedisClientProvider } from './ai-redis-client.provider';

/** A Redis stream id (`<ms>-<seq>`), the SSE `id` / `Last-Event-ID` cursor. Anything else is refused. */
export const AI_STREAM_ID_PATTERN = /^\d{1,20}-\d{1,10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AiStreamEntry {
  id: string;
  event: AiStreamEventV2;
}

/** The wake hint `{t, id}`: ids only. Exported for the canary tests (T2-15). */
export function wakePayload(turnId: string, entryId: string): string {
  const message: AiWakeMessage = { t: turnId, id: entryId };
  return JSON.stringify(message);
}

/** The cancel hint `{t}`: the turn id only. */
export function cancelPayload(turnId: string): string {
  const message: AiCancelMessage = { t: turnId };
  return JSON.stringify(message);
}

/** A wake hint, or null for anything that is not exactly `{t: uuid, id: stream-id}` (dropped, never acted on). */
export function parseWake(payload: string): AiWakeMessage | null {
  try {
    const v = JSON.parse(payload) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 2) return null;
    return typeof v.t === 'string' && UUID.test(v.t) && typeof v.id === 'string' && AI_STREAM_ID_PATTERN.test(v.id) ? { t: v.t, id: v.id } : null;
  } catch {
    return null;
  }
}

/** A cancel hint, or null for anything that is not exactly `{t: uuid}`. */
export function parseCancel(payload: string): AiCancelMessage | null {
  try {
    const v = JSON.parse(payload) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 1) return null;
    return typeof v.t === 'string' && UUID.test(v.t) ? { t: v.t } : null;
  } catch {
    return null;
  }
}

/**
 * One Redis STREAM per turn: the Worker appends bounded events, every SSE connection of the turn's owner reads them from
 * its own cursor. A reconnect resumes from `Last-Event-ID`; nothing is ever re-generated, and the model is never called
 * again because a browser reconnected. Bounded: MAXLEN ~2000 entries, expires 15 minutes after the last write; after
 * that the persisted message in PostgreSQL is the answer.
 *
 * Keys and channels (rule 9.2, Phase 2 §2.3 — `AiStreamKeys`), all `crewflow:{env}:ai:conv:{conversationId}:…`:
 *   stream  `…:turn:{turnId}:stream`  STREAM of AiStreamEventV2 JSON (the owner's own text and tool NAMES), TTL 900 s
 *   wake    `…:wake`                  PUBLISH `{t, id}` after every append — ids only, never text (P2-C4)
 *   cancel  `…:cancel`                PUBLISH `{t}` (fast path) next to the flag `…:turn:{turnId}:cancel` (SET EX 3600)
 *                                     and the database `cancel_requested_at` (the durable paths)
 *
 * The key is never an authorisation boundary — the SSE endpoint proves ownership of the conversation and the turn
 * through RLS before reading it, and the Worker only acts on a turn id it holds in flight.
 */
@Injectable()
export class AiStreamService implements AiStreamKeys {
  constructor(
    private readonly config: AiConfigService,
    private readonly redis: AiRedisClientProvider,
  ) {}

  stream(conversationId: string, turnId: string): string {
    return this.config.redisKey('conv', conversationId, 'turn', turnId, 'stream');
  }

  wake(conversationId: string): string {
    return this.config.redisKey('conv', conversationId, 'wake');
  }

  cancel(conversationId: string): string {
    return this.config.redisKey('conv', conversationId, 'cancel');
  }

  cancelFlag(conversationId: string, turnId: string): string {
    return this.config.redisKey('conv', conversationId, 'turn', turnId, 'cancel');
  }

  /** Appends one event, refreshes the TTL, then publishes the id-only wake hint (best effort). Returns the entry id. */
  async publish(conversationId: string, turnId: string, event: AiStreamEventV2): Promise<string> {
    const key = this.stream(conversationId, turnId);
    const id = (await this.redis.client.xadd(key, 'MAXLEN', '~', String(AI_STREAM_MAX_ENTRIES), '*', 'e', JSON.stringify(event))) ?? '';
    await this.redis.client.expire(key, AI_STREAM_TTL_SECONDS);
    if (id) await this.redis.client.publish(this.wake(conversationId), wakePayload(turnId, id)).catch(() => undefined);
    return id;
  }

  /** Best-effort publish (the persisted turn is authoritative; a lost delta never changes the final answer). */
  async publishQuietly(conversationId: string, turnId: string, event: AiStreamEventV2): Promise<void> {
    await this.publish(conversationId, turnId, event).catch(() => undefined);
  }

  /** Publishes only while the turn's stream still exists (Phase 2 titles: never re-creates an expired stream). */
  async publishIfOpen(conversationId: string, turnId: string, event: AiStreamEventV2): Promise<boolean> {
    try {
      if ((await this.redis.client.exists(this.stream(conversationId, turnId))) !== 1) return false;
      await this.publish(conversationId, turnId, event);
      return true;
    } catch {
      return false;
    }
  }

  /** Entries strictly after `afterId` ('0-0' = from the start). Redis unavailable ⇒ AiQuotaUnavailableError. */
  async read(conversationId: string, turnId: string, afterId: string, count: number): Promise<AiStreamEntry[]> {
    try {
      const start = afterId === '0-0' ? '-' : `(${afterId}`;
      const rows = await this.redis.client.xrange(this.stream(conversationId, turnId), start, '+', 'COUNT', count);
      const entries: AiStreamEntry[] = [];
      for (const [id, fields] of rows) {
        const raw = fields[fields.indexOf('e') + 1];
        if (!raw) continue;
        try {
          entries.push({ id, event: JSON.parse(raw) as AiStreamEventV2 });
        } catch {
          // A malformed entry is skipped, never forwarded.
        }
      }
      return entries;
    } catch {
      throw new AiQuotaUnavailableError();
    }
  }

  /** The durable Redis flag first (survives a missed message), then the fast hint on the conversation's cancel channel. */
  async requestCancel(conversationId: string, turnId: string): Promise<void> {
    await this.redis.client.set(this.cancelFlag(conversationId, turnId), '1', 'EX', AI_CANCEL_FLAG_TTL_SECONDS);
    await this.redis.client.publish(this.cancel(conversationId), cancelPayload(turnId)).catch(() => undefined);
  }

  async isCancelRequested(conversationId: string, turnId: string): Promise<boolean> {
    return (await this.redis.client.exists(this.cancelFlag(conversationId, turnId)).catch(() => 0)) === 1;
  }

  async clearCancel(conversationId: string, turnId: string): Promise<void> {
    await this.redis.client.del(this.cancelFlag(conversationId, turnId)).catch(() => undefined);
  }
}
