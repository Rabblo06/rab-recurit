import { assertTransition, NotificationType, OFFER_TRANSITIONS, OfferStatus, ReplacementRequestStatus, SHIFT_ASSIGNMENT_TRANSITIONS, ShiftAssignmentStatus, ShiftAssignmentStatusType, ShiftStatus } from '@rab/shared';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { JobOffer } from '@rab/server/modules/offer/entities/job-offer.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '@rab/server/modules/staff/entities/staff-profile.entity';
import { User } from '@rab/server/modules/identity/entities/index';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';

/**
 * Cancellation follow-up. `SchedulingService.cancel()` (unchanged, still
 * fully synchronous) only ever does one thing: flip `Shift.status` to
 * `CANCELLED` and store `cancelledReason`. Every consequence — affected
 * staff notified, still-open offers closed out, is this job's job, run
 * async after that commit, exactly matching PHASE 9's event model: reload
 * canonical state, never trust anything but the DB.
 *
 * The cancellation REASON shown to staff is always reloaded fresh from
 * `Shift.cancelledReason` inside the scoped transaction below, never
 * threaded through as a job payload value — the shift row is the only
 * trusted source for it.
 *
 * FLAGGED ASSUMPTION (CLAUDE.md §"never invent a business rule silently"):
 * neither `ShiftAssignmentStatus` nor `OfferStatus` had an edge into a
 * cancelled-by-shift-cancellation terminal state for an assignment that
 * was still only OFFERED/STAFF_ACCEPTED (only `CONFIRMED → CANCELLED`
 * existed). Two decisions were made explicitly, not silently:
 *  1. `SHIFT_ASSIGNMENT_TRANSITIONS` gained `OFFERED/STAFF_ACCEPTED →
 *     CANCELLED` (shift-transitions.ts) — a shift being cancelled out from
 *     under a still-pending offer is a real, legitimate reason, distinct
 *     from WITHDRAWN (the sender's own choice) or REJECTED (the manager
 *     declining that specific acceptance).
 *  2. `OfferStatus` was NOT given a new CANCELLED value (that ripples into
 *     frontend badge colours/CSS across the whole app) — the existing
 *     `WITHDRAWN` (valid from PENDING) and `MANAGER_REJECTED` (valid from
 *     STAFF_ACCEPTED) states are reused instead. The notification text and
 *     audit metadata always say "the shift was cancelled" explicitly, so
 *     the true reason is never hidden behind a technically-adjacent status
 *     code's literal name.
 *
 * Other jobs ignoring a cancelled shift: `shift-monitor.job.ts`'s reminder/
 * no-show scan and `shift-report-scheduler.job.ts`'s scan already filter
 * `s.status NOT IN ('cancelled', ...)`; `attendance-monitor.job.ts`'s query
 * was given the same filter as part of this migration (it previously had
 * none). `replacement-staff.job.ts` only ever fires from a DECLINED/EXPIRED
 * offer on a still-open shift, so a cancelled shift's declines are simply
 * never discovered by it in the first place — and any `replacement_request`
 * already in flight for a shift that gets cancelled afterwards is closed out
 * by this same job (see the final step below), so a manager can never
 * approve a replacement offer for a shift that no longer exists.
 */
export interface ShiftCancellationFollowupResult {
  assignmentsClosed: number;
  offersClosed: number;
  replacementRequestsCancelled: number;
}

interface AssignmentCandidate {
  assignment_id: string;
  organisation_id: string;
  workspace_id: string | null;
}

interface ReplacementCandidate {
  request_id: string;
  organisation_id: string;
  workspace_id: string | null;
}

const OPEN_ASSIGNMENT_STATUSES: ShiftAssignmentStatusType[] = [ShiftAssignmentStatus.OFFERED, ShiftAssignmentStatus.STAFF_ACCEPTED, ShiftAssignmentStatus.CONFIRMED];
// PHASE 4: was `['awaiting_approval', 'no_candidates', 'approved']` — the
// literal `'approved'` was a dead value never actually written by any code
// path (confirmed by grep before its Phase 4 repurposing as `'approving'`;
// see `ReplacementRequestStatus`'s own doc comment). `APPROVING` itself is
// deliberately NOT added here: it is a transient state held only for the
// duration of a single `ReplacementRequestService.approve()` transaction,
// which resolves it to `OFFER_SENT` or `CANCELLED` and commits — no other
// transaction, including this scan, can ever durably observe a row sitting
// in `APPROVING` (a crash mid-transaction rolls back to whatever it was
// before, never leaves it stuck here).
const OPEN_REPLACEMENT_STATUSES: string[] = [ReplacementRequestStatus.AWAITING_APPROVAL, ReplacementRequestStatus.NO_CANDIDATES];

export async function runShiftCancellationFollowupCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  notificationService: NotificationService,
  auditService: AuditService,
): Promise<ShiftCancellationFollowupResult> {
  const discoveries = await discoverInWorkspaces(ownerDataSource, tenantContext, async (manager) => {
      const assignmentRows = await manager.query<AssignmentCandidate[]>(
        `SELECT sa.id AS assignment_id, sa.organisation_id, sa.workspace_id
           FROM core.shift_assignment sa
           JOIN core.shift s ON s.id = sa.shift_id
          WHERE s.status = 'cancelled' AND sa.status = ANY($1::text[])
          LIMIT 500`,
        [OPEN_ASSIGNMENT_STATUSES],
      );
      const replacementRows = await manager.query<ReplacementCandidate[]>(
        `SELECT rr.id AS request_id, rr.organisation_id, rr.workspace_id
           FROM core.replacement_request rr
           JOIN core.shift s ON s.id = rr.shift_id
          WHERE s.status = 'cancelled' AND rr.status = ANY($1::text[])
          LIMIT 500`,
        [OPEN_REPLACEMENT_STATUSES],
      );
      return [{ assignments: assignmentRows, replacements: replacementRows }];
  });

  const assignments = discoveries.flatMap(d => d.assignments);
  const replacements = discoveries.flatMap(d => d.replacements);
  let assignmentsClosed = 0;
  let offersClosed = 0;
  for (const candidate of assignments) {
    const outcome = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, async (manager) => {
      const assignment = await manager.findOne(ShiftAssignment, { where: { id: candidate.assignment_id } });
      if (!assignment || !OPEN_ASSIGNMENT_STATUSES.includes(assignment.status)) return { closed: false, offerClosed: false };
      // Reload canonical shift state — never trust anything about "cancelled" from the scan/payload.
      const shift = await manager.findOne(Shift, { where: { id: assignment.shiftId } });
      if (!shift || shift.status !== ShiftStatus.CANCELLED) return { closed: false, offerClosed: false };

      const staffProfile = await manager.findOne(StaffProfile, { where: { id: assignment.staffProfileId } });
      const user = staffProfile ? await manager.findOne(User, { where: { id: staffProfile.userId } }) : null;

      // PHASE 7 — the offer is claimed FIRST, the assignment SECOND — same
      // lock-acquisition order as every other offer-lifecycle transition
      // in this codebase (`OfferService.managerReject`, `apply-offer-
      // confirmation.ts` — used by manual confirm, Venue-request auto-
      // confirm, and (Phase 7.1) the manager-confirmation-timeout worker's
      // own auto-confirm — and `claim-expired-offer.ts`: all claim
      // `core.job_offer` before touching `core.shift_assignment`). Ordering
      // this the other way round (as a prior draft of this job did —
      // assignment first, offer second) risks a real Postgres deadlock
      // against the manager-confirmation-timeout worker, which can now race
      // this same offer/assignment pair on every tick: if the two jobs lock
      // the pair in opposite orders concurrently, each can end up waiting on
      // a row the other already holds. Both CAS guards below are new — this
      // file previously ran two BLIND
      // `manager.update()` calls with no prior-status guard at all, safe
      // only because nothing had ever raced these two specific rows
      // concurrently before Phase 7 introduced the first such racer.
      let offerClosed = false;
      const offer = await manager.findOne(JobOffer, { where: { shiftAssignmentId: assignment.id } });
      if (offer) {
        if (offer.status === OfferStatus.PENDING) {
          assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.WITHDRAWN);
          const [, withdrawnCount] = (await manager.query(
            `UPDATE core.job_offer SET status = $1, responded_at = $2 WHERE id = $3 AND status = $4`,
            [OfferStatus.WITHDRAWN, new Date(), offer.id, OfferStatus.PENDING],
          )) as [unknown, number];
          if (withdrawnCount > 0) {
            await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.OFFER_WITHDRAWN_BY_WORKER, {
              entityType: 'offer',
              entityId: offer.id,
              metadata: { reason: 'shift_cancelled', shiftId: shift.id },
              actorUserId: null,
            });
            offerClosed = true;
          }
        } else if (offer.status === OfferStatus.STAFF_ACCEPTED) {
          // See this file's own doc comment (FLAGGED ASSUMPTION #2) — the
          // closest valid existing terminal state; the true reason is
          // always carried explicitly in the audit metadata and the
          // staff-facing notification text below, never left to the
          // "rejected" label alone.
          assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.MANAGER_REJECTED);
          const [, rejectedCount] = (await manager.query(
            `UPDATE core.job_offer SET status = $1, manager_rejected_at = $2, rejected_by = NULL, rejection_reason = $3 WHERE id = $4 AND status = $5`,
            [OfferStatus.MANAGER_REJECTED, new Date(), 'This shift was cancelled.', offer.id, OfferStatus.STAFF_ACCEPTED],
          )) as [unknown, number];
          if (rejectedCount > 0) {
            await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.OFFER_REJECTED_BY_WORKER, {
              entityType: 'offer',
              entityId: offer.id,
              metadata: { reason: 'shift_cancelled', shiftId: shift.id },
              actorUserId: null,
            });
            offerClosed = true;
          }
          // A zero-row result here means Phase 7's manager-confirmation-
          // timeout worker (or a manual reject) already claimed this exact
          // offer moments earlier — its own audit/notification already
          // fired for that winning transition; this job does nothing
          // further for the offer.
        }
      }

      // CAS-guarded — `WHERE status = $3` is the exact status this
      // candidate was just re-read as. A zero-row result means something
      // else (the timeout worker's own claim, which transitions the
      // assignment too) already moved this assignment first; left alone
      // entirely rather than stomping whatever the winner just committed.
      // Safe to still be true even when the offer block above found
      // nothing to close (e.g. the offer was already MANAGER_CONFIRMED —
      // a normal fully-staffed shift being cancelled — or there is no
      // JobOffer row at all).
      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.CANCELLED);
      const [, assignmentCancelledCount] = (await manager.query(
        `UPDATE core.shift_assignment SET status = $1 WHERE id = $2 AND status = $3`,
        [ShiftAssignmentStatus.CANCELLED, assignment.id, assignment.status],
      )) as [unknown, number];
      if (assignmentCancelledCount === 0) return { closed: false, offerClosed };

      await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.SHIFT_ASSIGNMENT_CANCELLED_BY_WORKER, {
        entityType: 'shift_assignment',
        entityId: assignment.id,
        targetUserId: user?.id,
        metadata: { shiftId: shift.id },
        actorUserId: null,
      });

      if (user) {
        await notificationService.notify(manager, {
          organisationId: candidate.organisation_id,
          userId: user.id,
          type: NotificationType.SHIFT_CANCELLED,
          title: 'Shift cancelled',
          message: shift.cancelledReason
            ? `Your shift at ${shift.startsAt.toISOString()} has been cancelled. Reason: ${shift.cancelledReason}`
            : `Your shift at ${shift.startsAt.toISOString()} has been cancelled.`,
          relatedEntityType: 'shift_assignment',
          relatedEntityId: assignment.id,
        });
      }

      return { closed: true, offerClosed };
    });
    if (outcome.closed) assignmentsClosed += 1;
    if (outcome.offerClosed) offersClosed += 1;
  }

  let replacementRequestsCancelled = 0;
  for (const candidate of replacements) {
    const didCancel = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, async (manager) => {
      // PHASE 4 fix (section 30): manager.query() returns [rows, rowCount]
      // for an UPDATE statement, never the rows array directly (see
      // offer.service.ts's confirmAssignment / replacement-request.service.ts's
      // approve() for the same fix applied to the same mistake) — the
      // previous `updateResult.length > 0` read the OUTER tuple's length,
      // which is always 2 regardless of whether the UPDATE matched any row,
      // so `replacementRequestsCancelled` counted every scanned candidate as
      // cancelled even when another tick had already claimed it. The WRITE
      // itself was never unsafe (the WHERE clause is a real, correct guard);
      // only this returned count was wrong.
      const [updatedRows] = (await manager.query(
        `UPDATE core.replacement_request SET status = 'cancelled', updated_at = now()
          WHERE id = $1 AND status = ANY($2::text[]) RETURNING id`,
        [candidate.request_id, OPEN_REPLACEMENT_STATUSES],
      )) as [Array<{ id: string }>, number];
      return updatedRows.length > 0;
    });
    if (didCancel) replacementRequestsCancelled += 1;
  }

  return { assignmentsClosed, offersClosed, replacementRequestsCancelled };
}
