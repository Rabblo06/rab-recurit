import { NotificationType, OfferStatus, ShiftStatus } from '@rab/shared';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { JobOffer } from '@rab/server/modules/offer/entities/job-offer.entity';
import { applyOfferConfirmation } from '@rab/server/modules/offer/services/apply-offer-confirmation';
import { claimExpiredOffer } from '@rab/server/modules/offer/services/claim-expired-offer';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '@rab/server/modules/staff/entities/staff-profile.entity';
import { User } from '@rab/server/modules/identity/entities/index';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { claimWorkerEvent, cancelWorkerEvent, completeWorkerEvent } from '../../core/database/worker-event';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';
import { resolveResponsibleManager } from '../../core/domain/resolve-responsible-manager';

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
 * Same owner-scan + `rab_app`-scoped-mutation two-phase shape as the other
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
): Promise<OfferExpiryResult> {
  const candidates = await discoverInWorkspaces(ownerDataSource, tenantContext, async (manager) => {
      return await manager.query<ScanCandidate[]>(`
        SELECT id AS offer_id, organisation_id, workspace_id
        FROM core.job_offer
        WHERE status = 'pending' AND expires_at < now()
        ORDER BY expires_at ASC
        LIMIT 500
      `);
  });

  let expired = 0;
  for (const candidate of candidates) {
    const didExpire = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, async (manager) => {
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
      return true;
    });
    if (didExpire) expired += 1;
  }

  return { expired };
}

/**
 * Manager-confirmation timeout — the SEPARATE half of the two-step
 * confirmation flow: `runOfferExpiryCycle` above covers "staff never
 * responded" (reusing `expiresAt`/`OFFER_EXPIRED`). This covers "staff DID
 * respond (STAFF_ACCEPTED) but the manager never confirmed or rejected it
 * within the configured window."
 *
 * PHASE 7.1 — CORRECTED product rule: a timeout is a SYSTEM AUTO-CONFIRM
 * (`STAFF_ACCEPTED -> MANAGER_CONFIRMED`), not an auto-reject. Phase 7's own
 * first implementation auto-rejected on timeout — that was the wrong
 * business rule (confirmed by this phase's brief) and has been replaced.
 * Before Phase 7, this job never mutated `offer.status` at all (notify-only,
 * forever). Neither prior behaviour is current; this is the third and
 * (per the brief) correct rule.
 *
 * Auto-confirm reuses `applyOfferConfirmation` — the EXACT SAME seat-
 * claiming core a real Manager's confirm click and the Venue-Manager-
 * request auto-confirm-on-accept path already use (`@rab/server/modules/
 * offer/services/apply-offer-confirmation`) — never a bespoke blind
 * `UPDATE ... SET status = 'manager_confirmed'`. This is what makes the
 * timeout capacity-safe: it goes through the SAME atomic offer-status CAS,
 * the SAME atomic `filled_count < required_count` claim, and the SAME
 * double-booking exclusion-constraint handling as every other confirmation
 * path — Phase 6's capacity/last-seat safety is never bypassed. `confirmed_
 * by` stays NULL and the audit's `actorUserId` is explicitly `null` — a
 * system timeout never impersonates a Manager. No new `OfferStatus` value
 * was introduced; `STAFF_ACCEPTED -> MANAGER_CONFIRMED`/`CONFIRMED` were
 * already valid edges.
 *
 * `applyOfferConfirmation` THROWS `ConflictException` on any safety failure
 * — the offer/assignment already resolved by something else (a manager's
 * own manual confirm/reject won the race first), the shift is cancelled,
 * the shift is now full, or a double-booking exclusion violation. Every one
 * of those is deliberately allowed to propagate out of this candidate's own
 * `runScopedForOrg` transaction, rolling back EVERYTHING it touched
 * (including the `claimWorkerEvent` INSERT moments earlier) — never a fake
 * `MANAGER_CONFIRMED`, never a silent fallback to `MANAGER_REJECTED` (no
 * existing product rule asks for that, and Phase 7.1's own brief explicitly
 * forbids inventing one). The offer is left exactly as it was
 * (`STAFF_ACCEPTED`), genuinely retryable on a later tick — a transient
 * "shift full right now" may no longer hold by then. The outer per-
 * candidate `try`/`catch` in the loop below exists so ONE candidate hitting
 * this is never allowed to abort the rest of this tick's batch — no prior
 * job in this file needed that, because none of them call a function that
 * can throw for a legitimate, expected business reason; this is the first.
 *
 * Idempotency is a `core.worker_event` claim, keyed on
 * `manager-confirmation-timeout:{offerId}:{staffAcceptedAt}` — UNCHANGED
 * across Phase 7 and 7.1 (an already-correct Phase 2 event-key convention,
 * never touched). The `staffAcceptedAt` component means a genuinely NEW
 * acceptance (the offer somehow cycles back through `staff_accepted` again
 * with a fresh timestamp) would re-arm the check, while the normal
 * single-accept lifecycle produces the exact same key on every tick and
 * only ever claims once. NOT a `Notification` row's existence — see
 * `worker-event.ts`'s own doc comment on why that would be defeated by
 * notification preferences.
 *
 * PHASE 5 (§10) — Pass A (before claim) checks the underlying shift's
 * status; Pass B (final revalidation, immediately before the irreversible
 * claim/notify/audit) re-checks it fresh — an offer whose shift was
 * cancelled before or during this cycle is never auto-confirmed here (the
 * `shift-cancellation-followup.job.ts` sweep already resolves it, via its
 * own terminal state, with a truthful "shift was cancelled" reason
 * instead). Same Pass A/claim/Pass B shape `late-clock-in.job.ts`
 * established in Phase 3.
 */
export interface ManagerConfirmationTimeoutResult {
  confirmed: number;
}

interface StaffAcceptedCandidate {
  offer_id: string;
  organisation_id: string;
  workspace_id: string | null;
}

/** The SAME core eligibility check used at Pass A and Pass B — one definition, not two near-duplicates. */
function isStillAwaitingConfirmation(offer: JobOffer | null, shift: Shift | null, managerConfirmationTimeoutMinutes: number): boolean {
  if (!offer || offer.status !== OfferStatus.STAFF_ACCEPTED || !offer.staffAcceptedAt) return false;
  if (offer.staffAcceptedAt.getTime() > Date.now() - managerConfirmationTimeoutMinutes * 60_000) return false;
  if (!shift || shift.status === ShiftStatus.CANCELLED || shift.status === ShiftStatus.COMPLETED) return false;
  return true;
}

export async function runManagerConfirmationTimeoutCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  notificationService: NotificationService,
  auditService: AuditService,
  managerConfirmationTimeoutMinutes: number,
): Promise<ManagerConfirmationTimeoutResult> {
  const candidates = await discoverInWorkspaces(ownerDataSource, tenantContext, async (manager) => {
      return await manager.query<StaffAcceptedCandidate[]>(
        `
        SELECT id AS offer_id, organisation_id, workspace_id
        FROM core.job_offer
        WHERE status = 'staff_accepted'
          AND staff_accepted_at < now() - make_interval(mins => $1)
        ORDER BY staff_accepted_at ASC
        LIMIT 500
      `,
        [managerConfirmationTimeoutMinutes],
      );
  });

  let confirmed = 0;
  for (const candidate of candidates) {
    let didConfirm = false;
    try {
      didConfirm = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, async (manager) => {
        // --- Pass A: is this occurrence still genuinely awaiting confirmation? ---
        let offer = await manager.findOne(JobOffer, { where: { id: candidate.offer_id } });
        let assignment = offer ? await manager.findOne(ShiftAssignment, { where: { id: offer.shiftAssignmentId } }) : null;
        let shift = assignment ? await manager.findOne(Shift, { where: { id: assignment.shiftId } }) : null;
        if (!isStillAwaitingConfirmation(offer, shift, managerConfirmationTimeoutMinutes)) return false;

        const eventId = await claimWorkerEvent(manager, {
          organisationId: candidate.organisation_id,
          workspaceId: candidate.workspace_id,
          eventKey: `manager-confirmation-timeout:${offer!.id}:${offer!.staffAcceptedAt!.toISOString()}`,
          eventType: 'manager_confirmation_timeout',
          entityType: 'offer',
          entityId: offer!.id,
        });
        if (!eventId) return false; // another replica/tick already claimed this occurrence

        // --- Pass B: final revalidation, immediately before the irreversible side effects. ---
        offer = await manager.findOne(JobOffer, { where: { id: candidate.offer_id } });
        assignment = offer ? await manager.findOne(ShiftAssignment, { where: { id: offer.shiftAssignmentId } }) : null;
        shift = assignment ? await manager.findOne(Shift, { where: { id: assignment.shiftId } }) : null;
        if (!isStillAwaitingConfirmation(offer, shift, managerConfirmationTimeoutMinutes)) {
          await cancelWorkerEvent(manager, eventId, 'condition_no_longer_true');
          return false;
        }

        // PHASE 7.1 — the SAME canonical seat-claiming core a real Manager's
        // confirm click uses; see this function's own doc comment above for
        // the full reasoning. `confirmedBy: null` (never a fabricated
        // Manager identity), `auditMetadataSource: 'manager_confirmation_
        // timeout'` (OFFER_CONFIRMED + metadata.source, per Phase 7.1 §13),
        // `actorUserId: null` explicit (matching every other worker-driven
        // audit entry's own convention). Throws on any safety failure —
        // deliberately NOT caught here; see the outer try/catch below.
        const confirmedOffer = await applyOfferConfirmation(
          manager,
          auditService,
          notificationService,
          { organisationId: candidate.organisation_id, userId: '' },
          offer!,
          assignment!,
          null,
          'manager_confirmation_timeout',
          null,
        );

        // Staff notification ("Your shift offer has been confirmed") is
        // already sent, exactly once, inside `applyOfferConfirmation` itself
        // — shared by every confirmation path. Only the manager-facing
        // notice is specific to this job: the responsible manager should
        // still learn their staffing pipeline auto-resolved something they
        // didn't act on, truthfully described as a system confirmation,
        // never as a rejection.
        const responsibleManager = await resolveResponsibleManager(manager, candidate.organisation_id, assignment!, shift!);
        if (responsibleManager) {
          const staffProfile = await manager.findOne(StaffProfile, { where: { id: confirmedOffer.staffProfileId } });
          const staffUser = staffProfile ? await manager.findOne(User, { where: { id: staffProfile.userId } }) : null;
          await notificationService.notify(manager, {
            organisationId: candidate.organisation_id,
            userId: responsibleManager.userId,
            type: NotificationType.MANAGER_CONFIRMATION_TIMEOUT,
            title: 'Shift auto-confirmed',
            message: staffUser
              ? `${staffUser.firstName} ${staffUser.lastName}'s accepted shift offer was automatically confirmed by the system after ${managerConfirmationTimeoutMinutes} minutes with no manager action.`
              : `An accepted shift offer was automatically confirmed by the system after ${managerConfirmationTimeoutMinutes} minutes with no manager action.`,
            relatedEntityType: 'offer',
            relatedEntityId: confirmedOffer.id,
          });
        }

        await completeWorkerEvent(manager, eventId);
        return true;
      });
    } catch {
      // A capacity/safety failure inside `applyOfferConfirmation` (shift
      // full, shift cancelled, double-booking, or a race already resolved
      // by something else) — this candidate's entire transaction, including
      // its worker_event claim, already rolled back (see this function's
      // own doc comment). Move on so one stuck offer never blocks the rest
      // of this tick's batch; it is genuinely retryable next tick.
      continue;
    }
    if (didConfirm) confirmed += 1;
  }

  return { confirmed };
}
