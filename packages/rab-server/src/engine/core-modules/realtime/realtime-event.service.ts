import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EnvironmentService } from '../environment/environment.service';
import { RealtimeRecipient, uniqueRecipients } from './realtime-recipients';

/**
 * Stage 1 wired exactly one real event type (`OFFER_SENT`, from
 * `OfferService.sendOne()`). Stage 4 adds `OFFER_ACCEPTED`, from
 * `OfferService.staffAccept()` — the existing, real `notify('offer_accepted', ...)`
 * call site (manager_assigned, i.e. `assignment.assignedBy`), same transaction,
 * same recipient; never a second, diverging notion of who should be told.
 * New values are added here as later stages wire more source methods from
 * the design doc's catalogue; `record()` rejects anything not in this list
 * rather than silently accepting an arbitrary string, since this table has
 * no DB-level CHECK constraint on `event_type` (unlike `status`) and a typo
 * here would otherwise insert a row no future consumer recognizes.
 */
export const RealtimeEventType = {
  OFFER_SENT: 'offer.sent',
  OFFER_ACCEPTED: 'offer.accepted',
  OFFER_CONFIRMED: 'offer.confirmed',
  // Phase C1b — every value below is raised by exactly the committed transition named in
  // `docs/architecture/REALTIME-PUBSUB-DESIGN.md`'s catalogue (see the C1b report's table for
  // file:line), in the same transaction, one row per server-computed recipient
  // (`recordForRecipients`). Payloads are ids only.
  OFFER_DECLINED: 'offer.declined',
  OFFER_WITHDRAWN: 'offer.withdrawn',
  OFFER_EXPIRED: 'offer.expired',
  OFFER_REJECTED: 'offer.rejected',
  SHIFT_UPDATED: 'shift.updated',
  SHIFT_CANCELLED: 'shift.cancelled',
  SHIFT_REQUEST_CREATED: 'shift_request.created',
  SHIFT_REQUEST_APPROVED: 'shift_request.approved',
  SHIFT_REQUEST_DECLINED: 'shift_request.declined',
  ATTENDANCE_CHANGED: 'attendance.changed',
  NOTIFICATION_CREATED: 'notification.created',
  PAYROLL_RECORD_CHANGED: 'payroll.record_changed',
  /** The user's own navigation layout was saved (their other open tabs refetch it). Targeted at that user only. */
  NAVIGATION_LAYOUT_SAVED: 'navigation_layout.saved',
} as const;
export type RealtimeEventTypeValue = (typeof RealtimeEventType)[keyof typeof RealtimeEventType];

/**
 * The request-path half of the real-time durable outbox (Stage 1 of
 * `docs/architecture/REALTIME-PUBSUB-DESIGN.md`) — see the migration
 * (`RealtimeEventOutbox1786698000000`) for why `core.realtime_event` is a
 * separate table from `core.worker_event`, not a repurposing of it.
 *
 * `record()` is the ONLY method here. It is deliberately called with the
 * SAME `EntityManager` the caller's business mutation is already using
 * (never its own transaction), so a rollback of the business mutation
 * removes the pending event with it — the atomicity Stage 1 requirement 2
 * demands. The claim/complete/retry side (what a worker does with a row
 * once it exists) is `rab-worker`'s own concern
 * (`core/database/realtime-event.ts`), mirroring how `core.worker_event`'s
 * schema lives in a migration here while its claim helpers live in
 * `rab-worker` — this codebase's existing split between "where a table's
 * schema is defined" and "which process claims rows from it."
 */
@Injectable()
export class RealtimeEventService {
  constructor(private readonly env: EnvironmentService) {}

  /**
   * Returns the new event's id, or `null` if `params.eventKey` was already
   * claimed (another call with the same key — a normal, expected dedup
   * outcome, never an error; same idiom as `claimWorkerEvent`), or `null`
   * when `REALTIME_ENABLED` is false (nothing written — see below).
   *
   * Phase A gating: with `REALTIME_ENABLED=false` the SSE gateway refuses
   * every stream (`RealtimeGatewayController`), so a `core.realtime_event`
   * row could only ever be claimed, published to a channel nobody can be
   * subscribed to, and completed — pure write/claim/complete churn on the
   * request path and the Worker. Nothing else reads this table as data
   * (no client catch-up/replay; the platform-admin outbox view lists only
   * FAILED rows; retention deletes terminal rows). So the row is simply
   * not written — same rule `PushDeliveryService` already applies to
   * `push_delivery` under `PUSH_ENABLED`. The event-type check still runs
   * FIRST either way, so an unknown type fails closed whatever the flag.
   */
  async record(manager: EntityManager, params: RealtimeEventRecordParams): Promise<string | null> {
    if (!Object.values(RealtimeEventType).includes(params.eventType as RealtimeEventTypeValue)) {
      throw new BadRequestException(`Unknown realtime event type: ${params.eventType}`);
    }
    if (!this.env.get('REALTIME_ENABLED')) return null;
    const rows = await manager.query<Array<{ id: string }>>(
      `INSERT INTO core.realtime_event
         (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      [
        params.organisationId,
        params.workspaceId ?? null,
        params.targetUserId ?? null,
        params.eventKey,
        params.eventType,
        params.entityType,
        params.entityId,
        JSON.stringify(params.payload ?? {}),
      ],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Phase C1b — the same outbox write as `record()`, once per recipient: one `core.realtime_event` row per
   * `targetUserId` (never a broadcast), in ONE statement, on the caller's own `manager`/transaction (a rollback
   * removes every row with the business write). `eventKey` is the per-occurrence key; each row's stored key is
   * `${eventKey}:${userId}` so the UNIQUE dedup still works per person.
   *
   * `resolveRecipients` runs ONLY when `REALTIME_ENABLED` is true: with the flag off this costs one in-memory type
   * check — no recipient SQL, no insert (Phase A gating, same rule as `record()`). The type check runs first either
   * way, so an unknown type fails closed whatever the flag. Returns the number of rows written.
   */
  async recordForRecipients(
    manager: EntityManager,
    params: Omit<RealtimeEventRecordParams, 'targetUserId' | 'workspaceId'>,
    resolveRecipients: (manager: EntityManager) => Promise<Array<RealtimeRecipient | null | undefined>>,
  ): Promise<number> {
    if (!Object.values(RealtimeEventType).includes(params.eventType as RealtimeEventTypeValue)) {
      throw new BadRequestException(`Unknown realtime event type: ${params.eventType}`);
    }
    if (!this.env.get('REALTIME_ENABLED')) return 0;
    const recipients = uniqueRecipients(await resolveRecipients(manager));
    if (recipients.length === 0) return 0;
    // A recipient's workspace is kept only when it is the workspace this transaction is bound to; anything else is
    // written as NULL ("any workspace of this organisation" for that ONE target user). The RLS WITH CHECK would
    // otherwise reject the row and abort the caller's business write — the outbox must never be able to do that.
    // Review F6: ONE active-account filter for every audience (same rule as `realtime-recipients.ts`' ACTIVE_USER) —
    // a suspended, deactivated or deleted user never gets an outbox row, whichever audience function named them.
    const rows = await manager.query<Array<{ id: string }>>(
      `INSERT INTO core.realtime_event
         (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id, payload)
       SELECT $1::uuid,
              CASE WHEN t.workspace_id IS NOT DISTINCT FROM core.current_workspace() THEN t.workspace_id END,
              t.user_id, $2::text || ':' || t.user_id::text, $3::text, $4::text, $5::uuid, $6::jsonb
         FROM unnest($7::uuid[], $8::uuid[]) AS t(user_id, workspace_id)
         JOIN core."user" u ON u.id = t.user_id AND u.status = 'active' AND u.deleted_at IS NULL
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      [
        params.organisationId,
        params.eventKey,
        params.eventType,
        params.entityType,
        params.entityId,
        JSON.stringify(params.payload ?? {}),
        recipients.map((r) => r.userId),
        recipients.map((r) => r.workspaceId),
      ],
    );
    return rows.length;
  }
}

export interface RealtimeEventRecordParams {
  organisationId: string;
  /** Null for a genuinely org-wide event; the RLS policy treats NULL as "matches any workspace in the org," never as "exempt from tenant isolation." */
  workspaceId?: string | null;
  /** Null for a broadcast event (anyone with access to the org/workspace scope); set to address exactly one recipient. */
  targetUserId?: string | null;
  /** Stable and deterministic per logical occurrence — include a version/timestamp/id component wherever the same entity can legitimately re-trigger the same event type. */
  eventKey: string;
  eventType: string;
  entityType: string;
  entityId: string;
  /** Ids only — never a password, raw session/refresh token, MFA secret, bank detail, or rendered message. The delivery consumer re-fetches full state over the existing REST API. */
  payload?: Record<string, unknown>;
}
