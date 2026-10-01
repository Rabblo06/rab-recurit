import { EmploymentStatus, NotificationType, ReplacementCandidateSnapshot, ReplacementRequestStatus, ShiftStatus, UserStatus, getLondonDateParts } from '@rab/shared';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { toTstzRange } from '@rab/server/modules/scheduling/utils/tstzrange';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';
import { resolveResponsibleManager } from '../../core/domain/resolve-responsible-manager';

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
 * `core.replacement_request` row, ranks eligible candidates into
 * `candidates_snapshot`, and notifies the manager. Only an authenticated
 * manager's `POST /replacement-requests/:id/approve` (rab-server's
 * `ReplacementRequestController`) can move a request to `offer_sent`, and
 * that endpoint re-validates the selected candidate fresh before calling
 * the EXISTING `OfferService.send()` — never a duplicate of its
 * offer-creation SQL.
 *
 * MULTI-REPLICA IDEMPOTENCY: `core.replacement_request.declined_shift_
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
 * ELIGIBILITY — every criterion below maps to a real, existing column;
 * nothing here is invented:
 *  - `user.status = 'active'` / `staff_profile.employment_status = 'active'`
 *    — the same "active account" gate `OfferService.sendOne()` itself uses.
 *  - excluded: the staff member who just declined/let it expire.
 *  - excluded: anyone already offered this exact shift (a real row in
 *    `shift_assignment` for this `shift_id`).
 *  - excluded: anyone with a CONFIRMED/COMPLETED assignment whose `period`
 *    overlaps this shift's `period` — the exact GiST-constraint condition
 *    `sendOne()` already checks proactively, reused verbatim here.
 *  - excluded: `staff_profile.available_days` (if the staff member has
 *    ever set it) not containing the shift's weekday.
 *  - NOT used, because no such field/table exists in this schema: "venue
 *    favourites." Flagged explicitly rather than invented — see the
 *    ranking function below.
 *
 * RANKING is a small, deterministic, fully-explainable point score (never
 * an opaque model, never a protected-characteristic input) — see
 * `scoreCandidate()`. A tie or an all-zero field never hides a candidate;
 * it only affects sort order within the eligible set.
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

interface EligibilityRow {
  staff_profile_id: string;
  first_name: string;
  last_name: string;
  job_role_id: string | null;
  available_days: string[] | null;
  other_skills: string | null;
  worked_venue_before: boolean;
  no_overlap: boolean;
  not_already_offered: boolean;
  pending_commitments: string; // bigint comes back as string via pg
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_SHORTLIST_SIZE = 5;

/**
 * PHASE 4 fix: `startsAt.getUTCDay()` gave the wrong weekday for any shift
 * whose UTC-vs-Europe/London date differs from its local one — every shift
 * starting between midnight UTC and 01:00 BST (April–October) rolled to the
 * PREVIOUS UTC calendar day, silently excluding staff who were genuinely
 * available. `getLondonDateParts().weekday` is ISO 1(Mon)-7(Sun); converting
 * to this file's existing `WEEKDAY_NAMES[0..6]` (Sun-Sat, matching
 * `Date.getUTCDay()`'s indexing, kept for backward-compatible column values)
 * via `% 7` maps Sun(7)->0 and Mon(1)->1..Sat(6)->6.
 */
function isAvailableOnDay(availableDays: string[] | null, startsAt: Date): boolean {
  if (!availableDays || availableDays.length === 0) return true; // no preference recorded — never penalise unknown data
  const londonWeekdayIndex = getLondonDateParts(startsAt).weekday % 7;
  return availableDays.includes(WEEKDAY_NAMES[londonWeekdayIndex]!);
}

/**
 * Explainable, deterministic score — every point is traceable to a real
 * field, listed in `reasons` so a manager sees exactly why each name is
 * ranked where it is. Never uses age/sex/nationality/health or any other
 * protected characteristic; none of those fields even exist on
 * `StaffProfile`.
 */
function scoreCandidate(row: EligibilityRow, shift: Shift, jobRoleName: string | null): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (row.job_role_id && row.job_role_id === shift.jobRoleId) {
    score += 50;
    reasons.push('Exact job-role match');
  }
  if (row.worked_venue_before) {
    score += 20;
    reasons.push('Previously worked at this venue');
  }
  if (jobRoleName && row.other_skills && row.other_skills.toLowerCase().includes(jobRoleName.toLowerCase())) {
    score += 10;
    reasons.push('Listed skill mentions this role');
  }
  const pending = Number(row.pending_commitments);
  // Fewer existing commitments is a tie-breaker, not a gate — worth at most
  // 9 points total (never enough to outrank an exact role-match candidate).
  score += Math.max(0, 9 - pending);
  if (pending === 0) reasons.push('No other pending/confirmed commitments');
  return { score, reasons };
}

export async function runReplacementStaffCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  notificationService: NotificationService,
  auditService: AuditService,
): Promise<ReplacementStaffResult> {

  const candidates = await discoverInWorkspaces(ownerDataSource, tenantContext, async (manager) => {
      return await manager.query<ScanCandidate[]>(`
        SELECT sa.id AS assignment_id, o.id AS offer_id, s.id AS shift_id, s.organisation_id, s.workspace_id
        FROM core.job_offer o
        JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id
        JOIN core.shift s ON s.id = sa.shift_id
        LEFT JOIN core.replacement_request rr ON rr.declined_shift_assignment_id = sa.id
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
      // The UNIQUE constraint on declined_shift_assignment_id is the real
      // cross-replica guard (see this file's own doc comment) — this insert
      // racing another worker's identical insert is expected, not an error.
      const inserted = await manager.query(
        `INSERT INTO core.replacement_request (organisation_id, workspace_id, shift_id, declined_shift_assignment_id, declined_offer_id, status)
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
        await manager.query(`UPDATE core.replacement_request SET status = $1, updated_at = now() WHERE id = $2`, [ReplacementRequestStatus.CANCELLED, requestId]);
        return { created: false, noCandidates: false };
      }

      const roleRows = await manager.query(`SELECT name FROM core.job_role WHERE id = $1`, [shift.jobRoleId]);
      const venueRows = await manager.query(`SELECT name FROM core.venue WHERE id = $1`, [shift.venueId]);
      const jobRoleName: string | null = roleRows[0]?.name ?? null;
      const venueName: string = venueRows[0]?.name ?? 'the venue';

      const eligibilityRows = await manager.query<EligibilityRow[]>(
        `
        SELECT sp.id AS staff_profile_id, u.first_name, u.last_name, sp.job_role_id, sp.available_days, sp.other_skills,
          EXISTS (
            SELECT 1 FROM core.shift_assignment sa2
            JOIN core.shift s2 ON s2.id = sa2.shift_id
            WHERE sa2.staff_profile_id = sp.id AND sa2.status IN ('confirmed', 'completed') AND s2.venue_id = $2
          ) AS worked_venue_before,
          NOT EXISTS (
            -- period (a denormalised tstzrange snapshot) lives on
            -- shift_assignment itself, not shift -- matching the identical
            -- overlap check in OfferService.sendOne() (offer.service.ts),
            -- and the GiST exclusion constraint
            -- shift_assignment_no_double_booking it proactively mirrors.
            -- No join to shift is needed for this check at all.
            SELECT 1 FROM core.shift_assignment sa3
            WHERE sa3.staff_profile_id = sp.id AND sa3.status IN ('confirmed', 'completed') AND sa3.period && $3::tstzrange
          ) AS no_overlap,
          NOT EXISTS (
            SELECT 1 FROM core.shift_assignment sa4 WHERE sa4.staff_profile_id = sp.id AND sa4.shift_id = $1
          ) AS not_already_offered,
          (SELECT count(*) FROM core.shift_assignment sa5 WHERE sa5.staff_profile_id = sp.id AND sa5.status IN ('offered', 'staff_accepted', 'confirmed')) AS pending_commitments
        FROM core.staff_profile sp
        JOIN core."user" u ON u.id = sp.user_id
        WHERE sp.organisation_id = $4
          AND sp.employment_status = $5
          AND u.status = $6
          AND sp.id != $7
        `,
        [candidate.shift_id, shift.venueId, toTstzRange(shift.startsAt, shift.endsAt), candidate.organisation_id, EmploymentStatus.ACTIVE, UserStatus.ACTIVE, declinedAssignment.staffProfileId],
      );

      const eligible = eligibilityRows.filter((r) => r.no_overlap && r.not_already_offered);
      const shortlist: ReplacementCandidateSnapshot[] = eligible
        .filter((r) => isAvailableOnDay(r.available_days, shift.startsAt))
        .map((r) => {
          const { score, reasons } = scoreCandidate(r, shift, jobRoleName);
          return { staffProfileId: r.staff_profile_id, firstName: r.first_name, lastName: r.last_name, score, reasons };
        })
        // Deterministic tie-break: score DESC, then staffProfileId ASC — two
        // candidates with identical scores must always sort the same way on
        // every run, never depend on unstable input/insertion order (and
        // never a protected characteristic).
        .sort((a, b) => b.score - a.score || a.staffProfileId.localeCompare(b.staffProfileId))
        .slice(0, MAX_SHORTLIST_SIZE);

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
        metadata: { shiftId: shift.id, declinedAssignmentId: declinedAssignment.id, candidateCount: shortlist.length },
        actorUserId: null,
      });

      if (shortlist.length === 0) {
        await manager.query(
          `UPDATE core.replacement_request SET status = $1, notified_user_id = $2, updated_at = now() WHERE id = $3`,
          [ReplacementRequestStatus.NO_CANDIDATES, recipientUserId ?? null, requestId],
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
        `UPDATE core.replacement_request SET candidates_snapshot = $1::jsonb, notified_user_id = $2, updated_at = now() WHERE id = $3`,
        [JSON.stringify(shortlist), recipientUserId ?? null, requestId],
      );
      if (recipientUserId) {
        await notificationService.notify(manager, {
          organisationId: candidate.organisation_id,
          userId: recipientUserId,
          type: NotificationType.REPLACEMENT_REQUIRED,
          title: 'Replacement staff needed',
          message: `A staff member declined the ${jobRoleName ?? 'shift'} at ${venueName}. ${shortlist.length} eligible replacement staff ${shortlist.length === 1 ? 'is' : 'are'} available. Review replacements.`,
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
