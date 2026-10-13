import type Redis from 'ioredis';

import { RealtimeEventEnvelope } from './realtime-envelope';

export type RealtimeMessageHandler = (envelope: RealtimeEventEnvelope, channel: string) => void;

/**
 * The minimal internal subscriber abstraction Stage 2 requires — reusable,
 * unchanged, by the Stage 3 NestJS gateway (which will wrap this in its own
 * module/DI, never re-implement the connection/parsing logic). Deliberately
 * NOT a NestJS `@Injectable()` here: it needs to be directly `new`-able from
 * `rab-worker`'s own integration tests (plain functions, no Nest DI
 * container), and from a future gateway via a thin wrapper provider,
 * exactly like `TenantContextService`'s own plain-class-reused-by-both-
 * processes precedent.
 *
 * ONE dedicated connection per `RealtimeSubscriber` instance, created via
 * `baseClient.duplicate()` — ioredis's own documented mechanism for "clone
 * this client's connection options into an independent connection," never a
 * brand-new `new Redis(url)` call that would duplicate configuration. This
 * is required, not optional: once a connection issues `SUBSCRIBE`, ioredis
 * puts it into subscriber mode and refuses ordinary commands on it. A
 * gateway process subscribes ONCE per process instance (per the design
 * doc), never once per connected user — this class is deliberately
 * ignorant of "how many users care about this channel"; that multiplexing
 * is the gateway's job, not this abstraction's.
 *
 * Every incoming message is parsed and shape-validated BEFORE a handler
 * ever sees it — a malformed or truncated message (a corrupted publish, a
 * future incompatible version) is logged and dropped, never forwarded as
 * raw, unchecked JSON. This mirrors `validateAndBuildEnvelope`'s own
 * "never trust the wire" posture on the publish side.
 */
export class RealtimeSubscriber {
  private readonly client: Redis;
  private readonly handlers = new Map<string, Set<RealtimeMessageHandler>>();
  private closed = false;
  private readonly onBadMessage: (channel: string, raw: string, reason: string) => void;

  constructor(baseClient: Redis, opts: { onBadMessage?: (channel: string, raw: string, reason: string) => void } = {}) {
    // `.duplicate()` inherits the BASE client's options verbatim unless overridden — if that base
    // is a fail-fast hot-path cache client (e.g. `AuthCacheRedisClientProvider`: `enableOfflineQueue:
    // false`, `commandTimeout: 150`, `maxRetriesPerRequest: 1`), a `subscribe()` issued immediately
    // after construction races the new connection's own async handshake and throws "Stream isn't
    // writeable" — found live, deterministically, the FIRST time any test tried it. A long-lived
    // subscriber connection should wait/queue until connected, never fail fast like a cache read:
    // override exactly the settings that make the inherited profile wrong for this different
    // connection role, nothing else (still the same host/port/auth/TLS as the base).
    this.client = baseClient.duplicate({ enableOfflineQueue: true, commandTimeout: undefined, maxRetriesPerRequest: null });
    this.onBadMessage = opts.onBadMessage ?? (() => undefined);
    this.client.on('message', (channel: string, raw: string) => this.dispatch(channel, raw));
  }

  async subscribe(channel: string, handler: RealtimeMessageHandler): Promise<void> {
    if (this.closed) throw new Error('RealtimeSubscriber is closed');
    const existing = this.handlers.get(channel);
    if (existing) {
      existing.add(handler);
      return;
    }
    this.handlers.set(channel, new Set([handler]));
    await this.client.subscribe(channel);
  }

  async unsubscribe(channel: string, handler: RealtimeMessageHandler): Promise<void> {
    const existing = this.handlers.get(channel);
    if (!existing) return;
    existing.delete(handler);
    if (existing.size === 0) {
      this.handlers.delete(channel);
      await this.client.unsubscribe(channel);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    try {
      await this.client.quit();
    } catch {
      // Already closed (e.g. a test or caller forced a disconnect on this exact connection
      // earlier) — `quit()` on a connection ioredis considers already ended throws "Connection is
      // closed," which is exactly the state this method was trying to reach anyway.
      this.client.disconnect();
    }
  }

  private dispatch(channel: string, raw: string): void {
    const handlers = this.handlers.get(channel);
    if (!handlers || handlers.size === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.onBadMessage(channel, raw, 'invalid_json');
      return;
    }

    const shapeError = findEnvelopeShapeError(parsed);
    if (shapeError) {
      this.onBadMessage(channel, raw, shapeError);
      return;
    }

    const envelope = parsed as RealtimeEventEnvelope;
    for (const handler of handlers) handler(envelope, channel);
  }
}

function findEnvelopeShapeError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'not_an_object';
  const v = value as Record<string, unknown>;
  if (typeof v.version !== 'number') return 'missing_version';
  if (typeof v.eventId !== 'string' || !v.eventId) return 'missing_event_id';
  if (typeof v.type !== 'string' || !v.type) return 'missing_type';
  if (typeof v.organisationId !== 'string' || !v.organisationId) return 'missing_organisation_id';
  if (typeof v.entityId !== 'string' || !v.entityId) return 'missing_entity_id';
  if (typeof v.occurredAt !== 'string' || !v.occurredAt) return 'missing_occurred_at';
  if (v.workspaceId !== null && typeof v.workspaceId !== 'string') return 'invalid_workspace_id';
  if (v.targetUserId !== null && typeof v.targetUserId !== 'string') return 'invalid_target_user_id';
  return null;
}
