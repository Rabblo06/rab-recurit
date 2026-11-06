import { NotificationType, OfferStatus, ShiftStatus } from '@rab/shared';
import { DataSource, EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { RealtimeEventService, RealtimeEventType } from '@rab/server/engine/core-modules/realtime/realtime-event.service';
import { offerAudience } from '@rab/server/engine/core-modules/realtime/realtime-recipients';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { withdrawUnconfirmedOffer, WithdrawalSource } from '@rab/server/modules/offer/services/withdraw-unconfirmed-offer';
import { claimExpiredOffer } from '@rab/server/modules/offer/services/claim-expired-offer';
import { confirmationDeadlineSql } from '@rab/server/modules/scheduling/utils/assignment-time';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { claimDueWork, completeDueWork, rescheduleDueWork } from '../../core/database/due-work';
import { claimWorkerEvent, cancelWorkerEvent, completeWorkerEvent } from '../../core/database/worker-event';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';

/**
 * Proactive offer expiry — `OfferService.staffAccept()` already expires a
 * stale `PENDING` offer LAZILY, the moment a staff member happens to touch
 * it past `expiresAt`. An offer nobody ever touches again just sits
 * `PENDING` forever with a past `expiresAt` — this job is that same
 * transition, run proactively on a periodic scan instead of waiting for a
 * request that may never come.
 *
 * PHASE 6 — the actual state transition now goes through
 * `claimExpiredOffer` (`@rab/server/modules/offer/services/claim-expired-
 * offer`), the ONE canonical, atomic `PENDING -> EXPIRED` claim shared with
 * `staffAccept`'s own lazy check — see that file's own doc comment for the
 * exact race this closes ("Worker reads PENDING / Staff accepts / Worker
 * blindly writes EXPIRED", named directly in this phase's own brief).
 * Previously this job did a blind `manager.update()` with no `WHERE
 * status = ...` guard at all — confirmed, by direct testing, to let a
 * concurrent staff acceptance be silently overwritten back to EXPIRED. The
 * audit action name/shape and the `assignment.assignedBy` notification stay
 * exactly as they were — only the underlying claim changed, never the
 * observable side effects.
 *
 * Same owner-scan + `crewflow`-scoped-mutation two-phase shape as the other
 * new operational jobs — see `shift-monitor.job.ts`'s doc comment.
 */
export interface OfferExpiryResult {
  expired: number;
}

interface ScanCandidate {
  offer_id: string;
  organisation_id: string;
  workspace_id: string | null;
}

export async function runOfferExpiryCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  notificationService: NotificationService,
  auditService: AuditService,
  // Phase C1b: optional so existing callers (and the specs that drive this cycle directly) keep their signature; the
  // processor passes it. It writes nothing while REALTIME_ENABLED is false.
  realtimeEventService?: RealtimeEventService,
): Promise<OfferExpiryResult> {
  const candidates = await discoverInWorkspaces(ownerDataSource, tenantContext, async (manager) => {
      return await manager.query<ScanCandidate[]>(`
        SELECT id AS offer_id, organisation_id, workspace_id
        FROM job_offer
        WHERE status = 'pending' AND expires_at < now()
        ORDER BY expires_at ASC
        LIMIT 500
      `);
  });

  let expired = 0;
  const deps: OfferExpiryDeps = { notificationService, auditService, realtimeEventService };
  for (const candidate of candidates) {
    const didExpire = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, (manager) =>
      expireOfferCandidate(manager, deps, candidate),
    );
    if (didExpire) expired += 1;
  }

  return { expired };
}

export interface OfferExpiryDeps {
  notificationService: NotificationService;
  auditService: AuditService;
  realtimeEventService?: RealtimeEventService;
}

export type OfferExpiryCandidate = ScanCandidate;

/**
 * Phase D-Q4b (refactor only, no behaviour change): the per-candidate body of `runOfferExpiryCycle`, moved verbatim out
 * of the loop so the offer-expiry timer trigger runs EXACTLY the scan's compare-and-set and side effects (never a copy).
 * Runs in the caller's `runScopedForOrg` transaction for `candidate`'s organisation/workspace.
 */
export async function expireOfferCandidate(manager: EntityManager, deps: OfferExpiryDeps, candidate: OfferExpiryCandidate): Promise<boolean> {
  const { notificationService, auditService, realtimeEventService } = deps;
  // PHASE 6 — the atomic claim itself IS the revalidation: a fresh,
  // unlocked `findOne` immediately before a blind `update()` (the old
  // code) leaves a real window for a concurrent `staffAccept()` to
  // land in between — `claimExpiredOffer`'s `WHERE status = 'pending'
  // AND expires_at <= now()` is what actually closes it, using real DB
  // time, not this scan's own possibly-stale `Date.now()`-free read.
  const offer = await claimExpiredOffer(manager, candidate.offer_id);
  if (!offer) return false; // already resolved by something else (accepted/declined/withdrawn/already expired) — no side effects.

  await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.OFFER_EXPIRED_BY_WORKER, {
    entityType: 'offer',
    entityId: offer.id,
    metadata: { offerBatchId: offer.offerBatchId },
    actorUserId: null,
  });

  const assignment = await manager.findOne(ShiftAssignment, { where: { id: offer.shiftAssignmentId } });
  if (assignment?.assignedBy) {
    await notificationService.notify(manager, {
      organisationId: candidate.organisation_id,
      userId: assignment.assignedBy,
      type: NotificationType.OFFER_EXPIRED,
      title: 'Offer expired',
      message: 'A shift offer expired before the staff member responded.',
      relatedEntityType: 'offer',
      relatedEntityId: offer.id,
    });
  }
  // C1b realtime (same transaction as the expiry claim; same key and audience as the API's lazy expiry in
  // OfferService.staffAccept): offer.expired → staff, sender, shift owner, venue managers. Ids only.
  await realtimeEventService?.recordForRecipients(manager, {
    organisationId: candidate.organisation_id, eventKey: `offer.expired:${offer.id}`, eventType: RealtimeEventType.OFFER_EXPIRED, entityType: 'offer', entityId: offer.id,
  }, (m) => offerAudience(m, offer.id));
  return true;
}

/**
 * Manager-confirmation DEADLINE (owner rule 2026-11-06) — the separate half of the two-step confirmation flow:
 * `runOfferExpiryCycle` above covers "staff never responded". This covers "staff accepted (STAFF_ACCEPTED) but no
 * Internal Manager confirmed before the approval deadline". The Worker NEVER confirms: at the deadline (standard:
 * assignment start - 30 min; replacement/standby: assignment end — `confirmationDeadlineSql`) it WITHDRAWS the
 * acceptance through `withdrawUnconfirmedOffer`, the one shared CAS + side effects the API's lazy path also uses.
 *
 * History of this job: Phase 7 auto-rejected after a configurable timeout; Phase 7.1 replaced that with a SYSTEM
 * AUTO-CONFIRM via `applyOfferConfirmation`. Both are superseded. The `MANAGER_CONFIRMATION_TIMEOUT_MINUTES` variable is
 * gone (Q12); this file no longer imports `applyOfferConfirmation` at all (pinned by a static spec).
 *
 * Discovery, three ways, all ending in `withdrawDeadlineCandidate` under one `core.worker_event` key
 * `manager-confirmation-deadline:{offerId}:{deadlineIso}` (a NEW prefix: it never collides with the old
 * `manager-confirmation-timeout:` rows), so they can never double-fire:
 *  1. the due-work pointer (`core.worker_due_work`, job_type 'manager_confirmation_timeout' reused — it now means
 *     "manager-confirmation deadline"), armed by the API at accept with the database-computed deadline. A pointer that is
 *     early (e.g. armed before this change with due = staff_accepted_at) is simply re-aimed at the real deadline;
 *  2. the backstop scan (`runConfirmationDeadlineBackstopScan`): every workspace, staff_accepted offers already past
 *     their deadline — catches offers that never had a pointer (standby acceptances before this change, legacy rows);
 *  3. the optional D-Q4b timer trigger, which only WAKES (1).
 *
 * A Worker that runs late still applies the ORIGINAL deadline (recomputed from the assignment, never from the processing
 * time); meanwhile the API has already been refusing manual confirms. A cancelled shift is left to the
 * shift-cancellation follow-up (truthful reason). A database error reschedules the pointer with bounded backoff
 * (60 s x 2^attempt, at most 15 min) — the old fixed-60 s-forever retry loop is gone with the auto-confirm it served.
 */
export interface ManagerConfirmationDeadlineResult {
  withdrawn: number;
}

export interface ConfirmationDeadlineCandidate {
  offer_id: string;
  organisation_id: string;
  workspace_id: string | null;
}

/** Pointers claimed per tick and the lease each claim holds. A crashed worker's lease expires and the pointer becomes claimable again. */
const DEADLINE_BATCH = 100;
const DEADLINE_LEASE_SECONDS = 120;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;

/** Bounded retry delay for a pointer whose processing failed (attempt_count as returned by the claim). */
export function deadlineRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount, 10));
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_MAX_MS);
}

type DeadlineState = { status: string; shift_status: string; deadline_at: Date; db_now: Date };

async function readDeadlineState(manager: EntityManager, offerId: string): Promise<DeadlineState | undefined> {
  const [row] = await manager.query<DeadlineState[]>(
    // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
    `SELECT o.status, s.status AS shift_status, ${confirmationDeadlineSql('o', 'sa', 's')} AS deadline_at, clock_timestamp() AS db_now
       FROM job_offer o JOIN shift_assignment sa ON sa.id = o.shift_assignment_id JOIN shift s ON s.id = sa.shift_id
      WHERE o.id = $1`,
    [offerId],
  );
  return row;
}

/**
 * The per-candidate body shared by the pointer cycle, the backstop scan and the timer trigger's wake. Runs in the
 * caller's `runScopedForOrg` transaction for the candidate's organisation/workspace (SET LOCAL + FORCE RLS): a forged or
 * cross-tenant id simply reads nothing. Returns 'withdrawn', 'not-due' (with the deadline) or 'done' (nothing to do).
 */
export async function withdrawDeadlineCandidate(
  manager: EntityManager,
  deps: OfferExpiryDeps,
  candidate: ConfirmationDeadlineCandidate,
  source: WithdrawalSource,
): Promise<{ outcome: 'withdrawn' | 'done' } | { outcome: 'not-due'; deadlineAt: Date }> {
  const state = await readDeadlineState(manager, candidate.offer_id);
  if (!state || state.status !== OfferStatus.STAFF_ACCEPTED || state.shift_status === ShiftStatus.CANCELLED) return { outcome: 'done' };
  const deadlineAt = new Date(state.deadline_at);
  if (new Date(state.db_now).getTime() < deadlineAt.getTime()) return { outcome: 'not-due', deadlineAt };

  const eventId = await claimWorkerEvent(manager, {
    organisationId: candidate.organisation_id,
    workspaceId: candidate.workspace_id,
    eventKey: `manager-confirmation-deadline:${candidate.offer_id}:${deadlineAt.toISOString()}`,
    eventType: 'manager_confirmation_deadline',
    entityType: 'offer',
    entityId: candidate.offer_id,
  });
  if (!eventId) return { outcome: 'done' }; // another replica / path already holds or finished this occurrence

  const withdrawn = await withdrawUnconfirmedOffer(manager, deps, candidate.organisation_id, candidate.offer_id, source);
  if (!withdrawn) {
    // Lost the CAS: confirmed / rejected / cancelled / withdrawn by someone else in the meantime. No side effects ran.
    await cancelWorkerEvent(manager, eventId, 'condition_no_longer_true');
    return { outcome: 'done' };
  }
  await completeWorkerEvent(manager, eventId);
  return { outcome: 'withdrawn' };
}

export async function runManagerConfirmationDeadlineCycle(
  runtimeDataSource: DataSource,
  tenantContext: TenantContextService,
  notificationService: NotificationService,
  auditService: AuditService,
  realtimeEventService: RealtimeEventService,
  source: WithdrawalSource = 'worker_pointer',
): Promise<ManagerConfirmationDeadlineResult> {
  // Discovery is the due-work pointer, not a workspace scan. Only offers whose pointer is due are visited (see the WorkerDueWork migration).
  const pointers = await claimDueWork(runtimeDataSource, 'manager_confirmation_timeout', {
    batch: DEADLINE_BATCH,
    leaseSeconds: DEADLINE_LEASE_SECONDS,
  });
  const deps: OfferExpiryDeps = { notificationService, auditService, realtimeEventService };

  let withdrawn = 0;
  for (const pointer of pointers) {
    const candidate: ConfirmationDeadlineCandidate = {
      offer_id: pointer.subject_id,
      organisation_id: pointer.organisation_id,
      workspace_id: pointer.workspace_id,
    };
    let result: Awaited<ReturnType<typeof withdrawDeadlineCandidate>> | null = null;
    try {
      result = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, (manager) =>
        withdrawDeadlineCandidate(manager, deps, candidate, source),
      );
    } catch {
      // A database error: this candidate's whole transaction (worker_event claim included) rolled back. One failing
      // pointer never blocks the batch; it is retried with bounded backoff, never dropped.
      result = null;
    }
    // Finish the pointer. A stale lease holder (its lease expired and was reclaimed) gets false from these functions and does nothing else.
    if (result === null) {
      await rescheduleDueWork(runtimeDataSource, pointer.pointer_id, pointer.lease_token, new Date(Date.now() + deadlineRetryDelayMs(pointer.attempt_count)));
    } else if (result.outcome === 'not-due') {
      await rescheduleDueWork(runtimeDataSource, pointer.pointer_id, pointer.lease_token, result.deadlineAt);
    } else {
      await completeDueWork(runtimeDataSource, pointer.pointer_id, pointer.lease_token);
      if (result.outcome === 'withdrawn') withdrawn += 1;
    }
  }
  return { withdrawn };
}

/**
 * Backstop for offers WITHOUT a pointer (standby acceptances made before this change, offers whose pointer was lost, or
 * any future path that forgets to arm one): every workspace, every staff_accepted offer already past its deadline on a
 * live shift. Uses `job_offer_staff_accepted_timeout_idx (… WHERE status = 'staff_accepted')`. Each candidate runs the
 * SAME `withdrawDeadlineCandidate` under the SAME worker_event key as the pointer path, so the two never double-fire.
 */
export async function runConfirmationDeadlineBackstopScan(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  notificationService: NotificationService,
  auditService: AuditService,
  realtimeEventService: RealtimeEventService,
): Promise<ManagerConfirmationDeadlineResult> {
  const candidates = await discoverInWorkspaces(ownerDataSource, tenantContext, async (manager) =>
    manager.query<ConfirmationDeadlineCandidate[]>(
      // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
      `SELECT o.id AS offer_id, o.organisation_id, o.workspace_id
         FROM job_offer o JOIN shift_assignment sa ON sa.id = o.shift_assignment_id JOIN shift s ON s.id = sa.shift_id
        WHERE o.status = 'staff_accepted' AND sa.status = 'staff_accepted' AND s.status <> 'cancelled'
          AND ${confirmationDeadlineSql('o', 'sa', 's')} <= now()
        ORDER BY o.id
        LIMIT 500`,
    ),
  );
  const deps: OfferExpiryDeps = { notificationService, auditService, realtimeEventService };
  let withdrawn = 0;
  for (const candidate of candidates) {
    try {
      const result = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, (manager) =>
        withdrawDeadlineCandidate(manager, deps, candidate, 'worker_scan'),
      );
      if (result.outcome === 'withdrawn') withdrawn += 1;
    } catch {
      // Rolled back; the next scan (or the pointer) retries it.
    }
  }
  return { withdrawn };
}
