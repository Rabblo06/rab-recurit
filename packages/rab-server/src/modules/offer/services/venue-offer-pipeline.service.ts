import { defaultAssignmentTime, effectiveAssignmentTime } from '../../scheduling/utils/assignment-time';
import {
  PermissionFlag,
  PermissionFlagType,
  EmploymentStatus,
  UserStatus,
} from '@rab/shared';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { AvailabilityAcknowledgement, assertStaffAvailabilityAcknowledged } from '../../staff/services/staff-availability';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { Shift } from '../../scheduling/entities/shift.entity';
import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { User } from '../../identity/entities';
import { AvailabilityService } from '../../scheduling/services/availability.service';
import { ShiftReportService } from '../../attendance/services/shift-report.service';
import { OfferService } from './offer.service';
import { ReplacementRequestService } from './replacement-request.service';
import { loadShiftVacancy } from './shift-vacancy';
import { OfferKind } from '../constants/offer-kind';
import {
  canCancelVenueOffer,
  PIPELINE_STAGE_GROUPS,
  PIPELINE_STAGES,
  resolveVenueOfferKanbanStage,
  resolveVenueOfferStatus,
} from './venue-offer-presentation';

@Injectable()
export class VenueOfferPipelineService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly env: EnvironmentService,
    private readonly offers: OfferService,
    private readonly replacements: ReplacementRequestService,
    private readonly availability: AvailabilityService,
    private readonly reports: ShiftReportService,
  ) {}

  private async owned(
    manager: EntityManager,
    ctx: AuthContext,
    id: string,
    permission: PermissionFlagType,
    lock = false,
  ) {
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, permission)))
      throw new ForbiddenException('Permission required.');
    const shift = await manager.findOne(Shift, {
      where: { id },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (
      !shift ||
      shift.organisationId !== ctx.organisationId ||
      !ctx.workspaceId ||
      shift.workspaceId !== ctx.workspaceId ||
      shift.createdBy !== ctx.userId ||
      !shift.requestedBy
    )
      throw new NotFoundException('Shift not found.');
    if (['pending_manager_approval', 'declined'].includes(shift.status))
      throw new ConflictException('This request has not been approved.');
    return shift;
  }

  async get(ctx: AuthContext, id: string) {
    return this.tenant.runInWorkspaceContext(ctx, async (manager) => {
      const shift = await this.owned(
        manager,
        ctx,
        id,
        PermissionFlag.SCHEDULE_VIEW,
      );
      const [clock] = await manager.query('SELECT clock_timestamp() AS now');
      const serverNow = new Date(clock.now);
      const [details] = await manager.query(
        'SELECT v.name AS "venueName", jr.name AS "roleName" FROM venue v, job_role jr WHERE v.id=$1 AND jr.id=$2',
        [shift.venueId, shift.jobRoleId],
      );
      const rows = await manager.query(
        `SELECT sa.period AS "period", o.id AS "offerId", sp.id AS "staffProfileId", u.first_name || ' ' || u.last_name AS name,
        u.avatar_file_id AS "avatarFileId", o.status AS "offerStatus", sa.status AS "assignmentStatus", a.status AS "attendanceStatus",
        o.sent_at AS "sentAt", o.responded_at AS "respondedAt", o.staff_accepted_at AS "acceptedAt", o.decline_reason AS "declineReason",
        o.rejection_reason AS "rejectionReason", o.offer_kind AS "offerKind", a.id AS "attendanceId", a.clock_in_at AS "clockInAt", a.clock_out_at AS "clockOutAt",
        a.break_minutes AS "breakMinutes", a.worked_minutes AS "workedMinutes", a.clock_out_method AS "clockOutMethod",
        sa.attendance_reviewed_at AS "attendanceReviewedAt",
        sa.checked_in_at AS "checkedInAt", sa.check_in_source AS "checkInSource", a.clock_in_method AS "clockInMethod",
        (SELECT max(n.read_at) FROM core.notification n WHERE n.organisation_id=o.organisation_id AND n.user_id=sp.user_id AND n.type='offer_sent' AND n.related_entity_id=o.id) AS "notificationReadAt",
        cancellation.metadata->>'reason' AS "withdrawnReason", cancellation.created_at AS "cancelledAt"
        FROM shift_assignment sa JOIN job_offer o ON o.shift_assignment_id=sa.id
        JOIN staff_profile sp ON sp.id=sa.staff_profile_id JOIN core."user" u ON u.id=sp.user_id
        LEFT JOIN attendance a ON a.shift_assignment_id=sa.id
        LEFT JOIN LATERAL (SELECT metadata, created_at FROM core.audit_log al WHERE al.entity_id=o.id AND al.organisation_id=o.organisation_id AND al.action='offer.withdrawn' AND al.metadata->>'source'='manager_pipeline_cancellation' ORDER BY created_at DESC LIMIT 1) cancellation ON true
        WHERE sa.shift_id=$1 AND sa.organisation_id=$2 AND sa.workspace_id=$3 ORDER BY o.sent_at, o.id`,
        [id, ctx.organisationId, ctx.workspaceId],
      );
      const mayCancel = await this.permissions.userHasPermissionTx(
        manager,
        ctx,
        PermissionFlag.OFFER_WITHDRAW,
      );
      // One card per staff member: their LATEST offer on this shift decides the lane (a re-offer after an expiry is not
      // a second person). Earlier offers stay untouched in the database; the card only reports how many there were.
      const latest = new Map<string, any>();
      const earlier = new Map<string, number>();
      for (const row of rows) {
        if (latest.has(row.staffProfileId)) earlier.set(row.staffProfileId, (earlier.get(row.staffProfileId) ?? 0) + 1);
        latest.set(row.staffProfileId, row);
      }
      const staff = [...latest.values()].map((row: any) => {
        const input = {
          ...row,
          shiftStatus: shift.status,
          startsAt: shift.startsAt,
          serverNow,
          graceMinutes: this.env.get('LATE_CLOCK_IN_GRACE_MINUTES'),
          hasAttendance: !!row.attendanceId,
        };
        return {
          ...row,
          earlierOffers: earlier.get(row.staffProfileId) ?? 0,
          attendanceReviewed: !!row.attendanceReviewedAt,
          stage: resolveVenueOfferKanbanStage({ ...input, ...effectiveAssignmentTime(row, shift) }),
          canManagerCancel: mayCancel && canCancelVenueOffer(input),
          terminalSource: row.cancelledAt
            ? 'Cancelled by Internal Manager'
            : row.offerStatus === 'declined'
              ? 'Declined by staff'
              : row.offerStatus === 'expired'
                ? 'Offer expired'
                : row.offerStatus === 'manager_rejected'
                  ? 'Rejected by manager'
                  : shift.status === 'cancelled'
                    ? 'Shift cancelled'
                    : row.assignmentStatus === 'cancelled'
                      ? 'Booking cancelled'
                      : row.offerStatus === 'withdrawn'
                        ? 'Offer withdrawn'
                        : null,
        };
      });
      const stageCounts = Object.fromEntries(
        PIPELINE_STAGES.map((stage) => [stage, staff.filter((r: any) => r.stage === stage).length]),
      ) as Record<(typeof PIPELINE_STAGES)[number], number>;
      const count = (stage: (typeof PIPELINE_STAGES)[number]) => stageCounts[stage];
      // Seats (summary-only, never lanes): a filled seat is a confirmed/completed booking, whatever lane it is in now.
      // A provisional (unreviewed) no-show is still a booked seat: missing punches never unfill it (owner rule
      // 2026-10-21). A manager-confirmed no-show frees the seat (see shift-vacancy.ts).
      const filled = staff.filter((r: any) =>
        ['confirmed', 'completed'].includes(r.assignmentStatus) || (r.assignmentStatus === 'no_show' && !r.attendanceReviewedAt),
      ).length;
      const reserved = staff.filter(
        (r: any) =>
          ['offered', 'staff_accepted', 'confirmed', 'completed'].includes(
            r.assignmentStatus,
          ) &&
          !['withdrawn', 'declined', 'expired', 'manager_rejected'].includes(
            r.offerStatus,
          ),
      ).length;
      const mayReadReport = await this.permissions.userHasPermissionTx(
        manager,
        ctx,
        PermissionFlag.REPORT_VIEW,
      );
      const report = mayReadReport
        ? await this.reports.getReportWithManager(manager, ctx, id)
        : null;
      // Live seat state for the "+ Send offer" (replacement form) entry point. A manager-CONFIRMED no-show frees its
      // seat; a provisional one does not (see shift-vacancy.ts). Sending is possible until the original shift's end.
      const vacancy = await loadShiftVacancy(manager, id);
      const maySend = await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.OFFER_SEND);
      const originalEnd = defaultAssignmentTime(shift).endsAt;
      return {
        shift: {
          id,
          ...details,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          status: shift.status,
          requiredCount: shift.requiredCount,
        },
        serverNow,
        tableStatus: resolveVenueOfferStatus({
          status: shift.status,
          required: shift.requiredCount,
          confirmed: filled,
          accepted: count('staff_accepted'),
          rejected: count('rejected'),
        }),
        // Every staff counter IS its lane's card count (one lane per person), so the header always reconciles with the
        // board; required / filled / open are seat metrics.
        summary: {
          required: shift.requiredCount,
          filled,
          open: Math.max(0, shift.requiredCount - filled),
          offered: count('offered'),
          waiting: count('waiting'),
          accepted: count('staff_accepted'),
          confirmed: count('confirmed'),
          late: count('late'),
          clockedIn: count('clocked_in'),
          pendingReview: count('pending_review'),
          clockedOut: count('clocked_out'),
          // NO SHOW is manager-confirmed only; the worker's provisional mark is ATTENDANCE MISSING.
          noShow: count('no_show'),
          confirmedNoShow: count('no_show'),
          checkedIn: count('checked_in'),
          attendanceMissing: count('attendance_missing'),
          rejected: count('rejected'),
          cancelled: count('cancelled'),
          deleted: count('deleted'),
        },
        stageCounts,
        stages: PIPELINE_STAGES,
        stageGroups: PIPELINE_STAGE_GROUPS,
        staff,
        report,
        replacement: {
          vacancy: vacancy.vacancy,
          confirmedNoShows: vacancy.confirmedNoShows,
          provisionalNoShows: vacancy.provisionalNoShows,
          nextOfferKind: vacancy.vacancy > 0 ? OfferKind.REPLACEMENT : OfferKind.STANDBY,
          canSend: maySend && !['cancelled', 'completed'].includes(shift.status) && serverNow < originalEnd,
        },
        replacementPlaces:
          !['cancelled', 'completed'].includes(shift.status) &&
          serverNow < shift.startsAt &&
          (await this.permissions.userHasPermissionTx(
            manager,
            ctx,
            PermissionFlag.OFFER_SEND,
          ))
            ? Math.max(0, shift.requiredCount - reserved)
            : 0,
      };
    });
  }

  async cancel(ctx: AuthContext, id: string, offerId: string, reason?: string) {
    return this.tenant.runInWorkspaceContext(ctx, async (manager) => {
      const shift = await this.owned(
        manager,
        ctx,
        id,
        PermissionFlag.OFFER_WITHDRAW,
        true,
      );
      await this.offers.cancelBookingWithManager(
        manager,
        ctx,
        shift,
        offerId,
        reason,
      );
    });
  }

  async replace(ctx: AuthContext, id: string, ids: string[], availabilityAcknowledgements: readonly AvailabilityAcknowledgement[] = []) {
    return this.tenant.runInWorkspaceContext(ctx, async (manager) => {
      const shift = await this.owned(
        manager,
        ctx,
        id,
        PermissionFlag.OFFER_SEND,
        true,
      );
      const [state] = await manager.query(
        `SELECT clock_timestamp() AS now, count(*)::int AS reserved FROM shift_assignment sa JOIN job_offer o ON o.shift_assignment_id=sa.id WHERE sa.shift_id=$1 AND sa.status IN ('offered','staff_accepted','confirmed','completed') AND o.status IN ('pending','staff_accepted','manager_confirmed')`,
        [id],
      );
      if (
        ['cancelled', 'completed'].includes(shift.status) ||
        new Date(state.now) >= shift.startsAt ||
        new Set(ids).size !== ids.length ||
        ids.length > shift.requiredCount - state.reserved
      )
        throw new ConflictException(
          'The available places have changed. Reload the pipeline.',
        );
      const profiles = await manager.find(StaffProfile, {
        where: {
          id: In(ids),
          organisationId: ctx.organisationId!,
          workspaceId: ctx.workspaceId!,
          createdBy: ctx.userId,
          employmentStatus: EmploymentStatus.ACTIVE,
        },
      });
      if (profiles.length !== ids.length)
        throw new NotFoundException('Staff not found.');
      const users = await manager.count(User, {
        where: {
          id: In(profiles.map((p) => p.userId)),
          status: UserStatus.ACTIVE,
        },
      });
      if (
        users !== ids.length ||
        (
          await this.availability.findBusyStaffIds(
            manager,
            ids,
            shift.startsAt,
            shift.endsAt,
            id,
          )
        ).size
      )
        throw new ConflictException('Selected staff are no longer available.');
      // All-or-nothing path (no per-recipient savepoint): pre-check every recipient so one 409 lists them all.
      await assertStaffAvailabilityAcknowledged(manager, ids.map((staffProfileId) => ({ staffProfileId, ...defaultAssignmentTime(shift) })), availabilityAcknowledgements);
      const offers = [];
      for (const staffId of ids)
        offers.push(
          await this.replacements.sendSelectedWithManager(
            manager,
            ctx,
            shift,
            staffId,
            availabilityAcknowledgements,
          ),
        );
      return { offerIds: offers.map((o) => o.id) };
    });
  }
}
