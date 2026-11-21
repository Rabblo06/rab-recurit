import { EmploymentStatus, NotificationType, ReplacementCandidateSnapshot, ReplacementRequestStatus, ShiftStatus, UserStatus, isEligibleReplacementCandidate } from '@rab/shared';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { businessTables } from '@rab/server/engine/core-modules/tenant/business-tables';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { toTstzRange } from '@rab/server/modules/scheduling/utils/tstzrange';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';
import { resolveResponsibleManager } from '../../core/domain/resolve-responsible-manager';
import { CandidateFacts, buildReplacementCandidates } from './replacement-candidates';

/**
 * Replacement-staff automation. Fires from EITHER a staff decline
 * (`OfferService.decline()`, `offer.status = 'declined'`) or a proactive
 * expiry (`offer-expiry.job.ts`, `offer.status = 'expired'`) — PHASE 6A's
 * own "optionally start replacement-candidate preparation" hook, reusing
 * the SAME two terminal states rather than adding a third trigger. Neither
 * `OfferService.decline()` nor `offer-expiry.job.ts` was changed to make
 * this happen — this job discovers the already-committed terminal state on
 * its own periodic scan (PHASE 9's event model: durable DB state IS the
 * event, no fire-and-forget signal to lose).
 *
 * THE WORKER NEVER SENDS AN OFFER. It only ever creates a
 * `replacement_request` row, lists the eligible staff (and the not-eligible
 * ones, with the reasons why) into `candidates_snapshot`, and notifies the
 * manager. Only an authenticated
 * manager's `POST /replacement-requests/:id/approve` (rab-server's
 * `ReplacementRequestController`) can move a request to `offer_sent`, and
 * that endpoint re-validates the selected candidate fresh before calling
 * the EXISTING `OfferService.send()` — never a duplicate of its
 * offer-creation SQL.
 *
 * MULTI-REPLICA IDEMPOTENCY: `replacement_request.declined_shift_
 * assignment_id` is UNIQUE (see its migration). The per-candidate `INSERT
 * ... ON CONFLICT (declined_shift_assignment_id) DO NOTHING` below is the
 * real cross-replica guard — two workers (or two overlapping ticks) racing
 * to process the same decline both attempt the insert; the loser gets zero
 * affected rows and simply moves on, never a duplicate request, never a
 * duplicate manager notification. The discovery-phase advisory lock
 * (`rab_replacement_staff`) only serialises the SCAN, exactly like every
 * other operational job's own lock — it is not, by itself, what prevents
 * the duplicate; the UNIQUE constraint is.
 *
 * ELIGIBILITY AND ORDER — owner decision 8 (21 Nov 2026): "eligible staff,
 * with the reasons shown". No score, no ranking, no shortlist cut by rank;
 * the list is in name order and the manager chooses. The rules and their
 * columns are in `replacement-candidates.ts`. This file only loads the
 * population: ACTIVE employment + ACTIVE account in the organisation, never
 * the staff member who just declined/let it expire.
 */
export interface ReplacementStaffResult {
  created: number;
  noCandidates: number;
}

interface ScanCandidate {
  assignment_id: string;
  offer_id: string;
  shift_id: string;
  organisation_id: string;
  workspace_id: string | null;
}

export async function runReplacementStaffCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  notificationService: NotificationService,
  auditService: AuditService,
): Promise<ReplacementStaffResult> {

  const candidates = await discoverInWorkspaces(ownerDataSource, tenantContext, async (manager) => {
      const t = businessTables(manager);
      return await manager.query<ScanCandidate[]>(`
        SELECT sa.id AS assignment_id, o.id AS offer_id, s.id AS shift_id, s.organisation_id, s.workspace_id
        FROM ${t.job_offer} o
        JOIN ${t.shift_assignment} sa ON sa.id = o.shift_assignment_id
        JOIN ${t.shift} s ON s.id = sa.shift_id
        LEFT JOIN ${t.replacement_request} rr ON rr.declined_shift_assignment_id = sa.id
        WHERE o.status IN ('declined', 'expired')
          AND s.status NOT IN ('cancelled', 'completed')
          AND s.filled_count < s.required_count
          AND rr.id IS NULL
        ORDER BY o.responded_at ASC NULLS LAST, o.expires_at ASC
        LIMIT 200
      `);
  });

  let created = 0;
  let noCandidates = 0;
  for (const candidate of candidates) {
    const outcome = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, async (manager) => {
      const t = businessTables(manager);
      // The UNIQUE constraint on declined_shift_assignment_id is the real
      // cross-replica guard (see this file's own doc comment) — this insert
      // racing another worker's identical insert is expected, not an error.
      const inserted = await manager.query(
        `INSERT INTO ${t.replacement_request} (organisation_id, workspace_id, shift_id, declined_shift_assignment_id, declined_offer_id, status)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (declined_shift_assignment_id) DO NOTHING
           RETURNING id`,
        [candidate.organisation_id, candidate.workspace_id, candidate.shift_id, candidate.assignment_id, candidate.offer_id, ReplacementRequestStatus.AWAITING_APPROVAL],
      );
      if (inserted.length === 0) return { created: false, noCandidates: false }; // another worker/tick already claimed this decline
      const requestId = inserted[0].id as string;

      const shift = await manager.findOne(Shift, { where: { id: candidate.shift_id } });
      const declinedAssignment = await manager.findOne(ShiftAssignment, { where: { id: candidate.assignment_id } });
      if (!shift || !declinedAssignment || shift.status === ShiftStatus.CANCELLED || shift.status === ShiftStatus.COMPLETED) {
        await manager.query(`UPDATE ${t.replacement_request} SET status = $1, updated_at = now() WHERE id = $2`, [ReplacementRequestStatus.CANCELLED, requestId]);
        return { created: false, noCandidates: false };
      }

      const roleRows = await manager.query(`SELECT name FROM ${t.job_role} WHERE id = $1`, [shift.jobRoleId]);
      const venueRows = await manager.query(`SELECT name FROM ${t.venue} WHERE id = $1`, [shift.venueId]);
      const jobRoleName: string | null = roleRows[0]?.name ?? null;
      const venueName: string = venueRows[0]?.name ?? 'the venue';

      const eligibilityRows = await manager.query<CandidateFacts[]>(
        `
        SELECT sp.id AS staff_profile_id, u.first_name, u.last_name, sp.job_role_id, sp.available_days,
          NOT EXISTS (
            -- period (a denormalised tstzrange snapshot) lives on
            -- shift_assignment itself, not shift -- matching the identical
            -- overlap check in OfferService.sendOne() (offer.service.ts),
            -- and the GiST exclusion constraint
            -- shift_assignment_no_double_booking it proactively mirrors.
            -- No join to shift is needed for this check at all.
            SELECT 1 FROM ${t.shift_assignment} sa3
            WHERE sa3.staff_profile_id = sp.id AND sa3.status IN ('confirmed', 'completed') AND sa3.period && $2::tstzrange
          ) AS no_overlap,
          NOT EXISTS (
            SELECT 1 FROM ${t.shift_assignment} sa4 WHERE sa4.staff_profile_id = sp.id AND sa4.shift_id = $1
          ) AS not_already_offered
        FROM ${t.staff_profile} sp
        JOIN core."user" u ON u.id = sp.user_id
        WHERE sp.organisation_id = $3
          AND sp.employment_status = $4
          AND u.status = $5
          AND sp.id != $6
        `,
        [candidate.shift_id, toTstzRange(shift.startsAt, shift.endsAt), candidate.organisation_id, EmploymentStatus.ACTIVE, UserStatus.ACTIVE, declinedAssignment.staffProfileId],
      );

      // Decision 8: everyone in the population is listed, eligible first, each group in NAME order. No score, no cut.
      const candidateList: ReplacementCandidateSnapshot[] = buildReplacementCandidates(eligibilityRows, shift, jobRoleName);
      const eligibleCount = candidateList.filter(isEligibleReplacementCandidate).length;

      // Canonical manager-resolution helper (assignedBy -> shift.createdBy
      // fallback, org/ACTIVE/workspace-validated) — the same one
      // late-clock-in.job.ts uses, not a second bespoke algorithm. Replaces
      // the previous raw `declinedAssignment.assignedBy` read, which had no
      // validation and no fallback for legacy rows where it's null.
      const resolvedManager = await resolveResponsibleManager(manager, candidate.organisation_id, declinedAssignment, shift);
      const recipientUserId = resolvedManager?.userId ?? null;

      await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.REPLACEMENT_REQUEST_CREATED, {
        entityType: 'replacement_request',
        entityId: requestId,
        metadata: { shiftId: shift.id, declinedAssignmentId: declinedAssignment.id, candidateCount: eligibleCount, listedCount: candidateList.length },
        actorUserId: null,
      });

      if (eligibleCount === 0) {
        // The not-eligible people (with their reasons) are still stored so the manager can see why nobody fits.
        await manager.query(
          `UPDATE ${t.replacement_request} SET status = $1, candidates_snapshot = $2::jsonb, notified_user_id = $3, updated_at = now() WHERE id = $4`,
          [ReplacementRequestStatus.NO_CANDIDATES, JSON.stringify(candidateList), recipientUserId ?? null, requestId],
        );
        if (recipientUserId) {
          await notificationService.notify(manager, {
            organisationId: candidate.organisation_id,
            userId: recipientUserId,
            type: NotificationType.REPLACEMENT_REQUIRED,
            title: 'Replacement staff needed',
            message: `A staff member declined the ${jobRoleName ?? 'shift'} at ${venueName}. No eligible replacement staff were found automatically — you may need to source one manually.`,
            relatedEntityType: 'shift',
            relatedEntityId: shift.id,
          });
        }
        return { created: true, noCandidates: true };
      }

      await manager.query(
        `UPDATE ${t.replacement_request} SET candidates_snapshot = $1::jsonb, notified_user_id = $2, updated_at = now() WHERE id = $3`,
        [JSON.stringify(candidateList), recipientUserId ?? null, requestId],
      );
      if (recipientUserId) {
        await notificationService.notify(manager, {
          organisationId: candidate.organisation_id,
          userId: recipientUserId,
          type: NotificationType.REPLACEMENT_REQUIRED,
          title: 'Replacement staff needed',
          message: `A staff member declined the ${jobRoleName ?? 'shift'} at ${venueName}. ${eligibleCount} eligible replacement staff ${eligibleCount === 1 ? 'is' : 'are'} available. Review them and choose.`,
          relatedEntityType: 'shift',
          relatedEntityId: shift.id,
        });
      }
      return { created: true, noCandidates: false };
    });
    if (outcome.created) created += 1;
    if (outcome.noCandidates) noCandidates += 1;
  }

  return { created, noCandidates };
}
