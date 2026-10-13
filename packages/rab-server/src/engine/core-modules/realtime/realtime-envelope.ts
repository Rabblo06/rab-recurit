/**
 * The wire format published to Redis and the channel-naming scheme both
 * the Stage 2 publisher (`rab-worker`) and any future subscriber (the
 * Stage 3 gateway, and this stage's own test-only subscriber abstraction,
 * `realtime-subscriber.ts`) must agree on byte-for-byte. Deliberately a
 * plain, dependency-free module (no NestJS decorators) so `rab-worker` can
 * import it directly via the `@rab/server` path alias, same as every other
 * plain helper it already reuses (`TenantContextService`, `scoped-job.ts`'s
 * own imports, etc.) — never duplicated into a second copy.
 *
 * `crewflow:{env}:rt:...` is a namespace deliberately distinct from every
 * other Redis key family this codebase already has (`entitycache:`,
 * `wsmeta:`, `usersession:`, `authctx:`) — see
 * `docs/architecture/REALTIME-PUBSUB-DESIGN.md` §3, which this matches
 * exactly rather than inventing a new scheme.
 *
 * Channel collision analysis (why `{env}:rt:user:{userId}` alone is
 * sufficient, with no explicit organisationId segment): `userId` is a
 * `core.user.id` UUID, and every `User` row already belongs to exactly one
 * organisation (`organisationId` is a column on `User`, not shared across
 * orgs) — a UUID is therefore already org-scoped by construction, so
 * prefixing the channel with organisationId too would be redundant, not
 * safer. `{env}` prevents a local/staging/prod Redis misconfiguration from
 * ever cross-wiring environments. Event CATEGORY is deliberately NOT part
 * of the channel (no `rt:user:{userId}:offer.sent`-style per-type channel):
 * a subscriber subscribes once per recipient and filters on `envelope.type`
 * — fragmenting into one channel per category per user would multiply
 * subscriptions for no isolation benefit, since `type` is already inside
 * the envelope and nothing authorises on the channel name (see below).
 *
 * Redis channel names are never an authorisation boundary — "keep Redis
 * private" per the design doc. The Stage 3 gateway independently
 * re-verifies the current session, membership and permission for the
 * target user/workspace before ever forwarding a received message to a
 * browser/mobile socket; nothing in this file, or in Stage 2, claims that
 * subscribing to a channel is itself a permission check.
 */

export const REALTIME_ENVELOPE_SCHEMA_VERSION = 1;

/**
 * The ONLY event type Stage 2 wires end-to-end (matches Stage 1 exactly —
 * `RealtimeEventType.OFFER_SENT` in `realtime-event.service.ts`). Kept as
 * its own small allow-list here (not imported from that file) because the
 * publisher validates the CLAIMED ROW's `eventType` string independently
 * of whatever the inserting code believed was valid at insert time —
 * defence in depth, not trust-the-writer.
 */
export const KNOWN_REALTIME_EVENT_TYPES = new Set<string>(['offer.sent', 'offer.accepted', 'offer.confirmed']);

/**
 * Which event types broadcast to an entire workspace versus address one
 * specific recipient. `offer.sent` is recipient-only, by explicit
 * requirement — a job offer must never be visible to every member of an
 * organisation/workspace, only the staff member it was sent to.
 */
const WORKSPACE_BROADCAST_EVENT_TYPES = new Set<string>([]);

export interface RealtimeEventEnvelope {
  version: number;
  eventId: string;
  type: string;
  organisationId: string;
  workspaceId: string | null;
  targetUserId: string | null;
  entityId: string;
  occurredAt: string;
}

export interface ClaimedRealtimeEventLike {
  id: string;
  organisationId: string;
  workspaceId: string | null;
  targetUserId: string | null;
  eventType: string;
  entityId: string;
  schemaVersion: number;
  createdAt: Date;
}

export type RealtimeEventValidation =
  | { ok: true; envelope: RealtimeEventEnvelope; channel: string }
  | { ok: false; reason: string };

/** `crewflow:{env}:rt:user:{userId}` — events addressed to one specific recipient. */
export function realtimeUserChannel(env: string, userId: string): string {
  return `crewflow:${env}:rt:user:${userId}`;
}

/** `crewflow:{env}:rt:workspace:{workspaceId}` — events broadcast to everyone with access to a workspace. */
export function realtimeWorkspaceChannel(env: string, workspaceId: string): string {
  return `crewflow:${env}:rt:workspace:${workspaceId}`;
}

/**
 * Validates a claimed outbox row and, only if valid, builds the envelope
 * actually published to Redis — built from the row's own AUTHORITATIVE
 * columns (`organisation_id`, `workspace_id`, `target_user_id`,
 * `entity_id`, `created_at`), never from the row's `payload` jsonb column.
 * `payload` is never forwarded to Redis at all: a subscriber that needs
 * full detail re-fetches it over the existing authenticated REST API,
 * keyed by `entityId`/`type` — exactly Stage 1's own design, carried
 * forward. A failure here is a POISON event (a malformed/unknown row that
 * will never become valid by retrying) — the caller must route it to a
 * permanent terminal state (`cancelRealtimeEvent`), never `markRealtimeEventRetry`.
 */
export function validateAndBuildEnvelope(event: ClaimedRealtimeEventLike, env: string): RealtimeEventValidation {
  if (event.schemaVersion !== REALTIME_ENVELOPE_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported_schema_version:${event.schemaVersion}` };
  }
  if (!KNOWN_REALTIME_EVENT_TYPES.has(event.eventType)) {
    return { ok: false, reason: `unknown_event_type:${event.eventType}` };
  }
  if (!event.organisationId) {
    return { ok: false, reason: 'missing_organisation_id' };
  }
  const isWorkspaceBroadcast = WORKSPACE_BROADCAST_EVENT_TYPES.has(event.eventType);
  if (isWorkspaceBroadcast) {
    if (!event.workspaceId) return { ok: false, reason: 'missing_workspace_id_for_broadcast_event' };
  } else if (!event.targetUserId) {
    // Every currently-known event type is recipient-only; this branch exists so a future
    // broadcast type added to KNOWN_REALTIME_EVENT_TYPES without also being added to
    // WORKSPACE_BROADCAST_EVENT_TYPES fails loudly instead of silently publishing nowhere.
    return { ok: false, reason: 'missing_target_user_id_for_recipient_event' };
  }

  const envelope: RealtimeEventEnvelope = {
    version: REALTIME_ENVELOPE_SCHEMA_VERSION,
    eventId: event.id,
    type: event.eventType,
    organisationId: event.organisationId,
    workspaceId: event.workspaceId,
    targetUserId: event.targetUserId,
    entityId: event.entityId,
    occurredAt: event.createdAt.toISOString(),
  };

  const channel = isWorkspaceBroadcast ? realtimeWorkspaceChannel(env, event.workspaceId!) : realtimeUserChannel(env, event.targetUserId!);

  return { ok: true, envelope, channel };
}
