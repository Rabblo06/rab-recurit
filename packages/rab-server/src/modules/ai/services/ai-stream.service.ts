import { AiStreamEvent } from '@rab/shared';
import { Injectable } from '@nestjs/common';

import { AI_STREAM_MAX_ENTRIES, AI_STREAM_TTL_SECONDS } from '../constants/ai.constants';
import { AiQuotaUnavailableError } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';
import { AiRedisClientProvider } from './ai-redis-client.provider';

/** A Redis stream id (`<ms>-<seq>`), the SSE `id` / `Last-Event-ID` cursor. Anything else is refused. */
export const AI_STREAM_ID_PATTERN = /^\d{1,20}-\d{1,10}$/;

export interface AiStreamEntry {
  id: string;
  event: AiStreamEvent;
}

/**
 * One Redis STREAM per turn (`crewflow:<env>:ai:turn:<turnId>:stream`): the Worker appends bounded events, every SSE
 * connection of the turn's owner reads them from its own cursor. A reconnect resumes from `Last-Event-ID`; nothing is
 * ever re-generated, and the model is never called again because a browser reconnected. Bounded: MAXLEN ~2000 entries,
 * expires 15 minutes after the last write; after that the persisted message in PostgreSQL is the answer.
 *
 * Content in the stream is exactly what is persisted for the owner (their own reply text and tool NAMES); the key is
 * per-turn and never an authorisation boundary — the SSE endpoint proves ownership through RLS before reading it.
 */
@Injectable()
export class AiStreamService {
  constructor(
    private readonly config: AiConfigService,
    private readonly redis: AiRedisClientProvider,
  ) {}

  key(turnId: string): string {
    return this.config.redisKey('turn', turnId, 'stream');
  }

  cancelKey(turnId: string): string {
    return this.config.redisKey('turn', turnId, 'cancel');
  }

  async publish(turnId: string, event: AiStreamEvent): Promise<string> {
    const key = this.key(turnId);
    const id = await this.redis.client.xadd(key, 'MAXLEN', '~', String(AI_STREAM_MAX_ENTRIES), '*', 'e', JSON.stringify(event));
    await this.redis.client.expire(key, AI_STREAM_TTL_SECONDS);
    return id ?? '';
  }

  /** Best-effort publish (the persisted turn is authoritative; a lost delta never changes the final answer). */
  async publishQuietly(turnId: string, event: AiStreamEvent): Promise<void> {
    await this.publish(turnId, event).catch(() => undefined);
  }

  /** Entries strictly after `afterId` ('0-0' = from the start). */
  async read(turnId: string, afterId: string, count: number): Promise<AiStreamEntry[]> {
    try {
      const start = afterId === '0-0' ? '-' : `(${afterId}`;
      const rows = await this.redis.client.xrange(this.key(turnId), start, '+', 'COUNT', count);
      const entries: AiStreamEntry[] = [];
      for (const [id, fields] of rows) {
        const raw = fields[fields.indexOf('e') + 1];
        if (!raw) continue;
        try {
          entries.push({ id, event: JSON.parse(raw) as AiStreamEvent });
        } catch {
          // A malformed entry is skipped, never forwarded.
        }
      }
      return entries;
    } catch {
      throw new AiQuotaUnavailableError();
    }
  }

  async requestCancel(turnId: string): Promise<void> {
    await this.redis.client.set(this.cancelKey(turnId), '1', 'EX', 3600);
  }

  async isCancelRequested(turnId: string): Promise<boolean> {
    return (await this.redis.client.exists(this.cancelKey(turnId)).catch(() => 0)) === 1;
  }

  async clearCancel(turnId: string): Promise<void> {
    await this.redis.client.del(this.cancelKey(turnId)).catch(() => undefined);
  }
}
