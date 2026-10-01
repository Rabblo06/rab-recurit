import { effectiveAssignmentTime } from '../../scheduling/utils/assignment-time';
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
import {
  canCancelVenueOffer,
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
    return this.tenant.runInTenantContext(ctx, async (manager) => {
      const shift = await this.owned(
        manager,
        ctx,
        id,
        PermissionFlag.SCHEDULE_VIEW,
      );
      const [clock] = await manager.query('SELECT clock_timestamp() AS now');
      const serverNow = new Date(clock.now);
      const [details] = await manager.query(
        'SELECT v.name AS "venueName", jr.name AS "roleName" FROM core.venue v, core.job_role jr WHERE v.id=$1 AND jr.id=$2',
        [shift.venueId, shift.jobRoleId],
      );
      const rows = await manager.query(
        `SELECT sa.period AS "period", o.id AS "offerId", sp.id AS "staffProfileId", u.first_name || ' ' || u.last_name AS name,
        u.avatar_file_id AS "avatarFileId", o.status AS "offerStatus", sa.status AS "assignmentStatus", a.status AS "attendanceStatus",
        o.sent_at AS "sentAt", o.responded_at AS "respondedAt", o.staff_accepted_at AS "acceptedAt", o.decline_reason AS "declineReason",
        o.rejection_reason AS "rejectionReason", a.id AS "attendanceId", a.clock_in_at AS "clockInAt", a.clock_out_at AS "clockOutAt",
        a.break_minutes AS "breakMinutes", a.worked_minutes AS "workedMinutes", a.clock_out_method AS "clockOutMethod",
        (SELECT max(n.read_at) FROM core.notification n WHERE n.organisation_id=o.organisation_id AND n.user_id=sp.user_id AND n.type='offer_sent' AND n.related_entity_id=o.id) AS "notificationReadAt",
        cancellation.metadata->>'reason' AS "withdrawnReason", cancellation.created_at AS "cancelledAt"
        FROM core.shift_assignment sa JOIN core.job_offer o ON o.shift_assignment_id=sa.id
        JOIN core.staff_profile sp ON sp.id=sa.staff_profile_id JOIN core."user" u ON u.id=sp.user_id
        LEFT JOIN core.attendance a ON a.shift_assignment_id=sa.id
        LEFT JOIN LATERAL (SELECT metadata, created_at FROM core.audit_log al WHERE al.entity_id=o.id AND al.organisation_id=o.organisation_id AND al.action='offer.withdrawn' AND al.metadata->>'source'='manager_pipeline_cancellation' ORDER BY created_at DESC LIMIT 1) cancellation ON true
        WHERE sa.shift_id=$1 AND sa.organisation_id=$2 AND sa.workspace_id=$3 ORDER BY o.sent_at, o.id`,
        [id, ctx.organisationId, ctx.workspaceId],
      );
      const mayCancel = await this.permissions.userHasPermissionTx(
        manager,
        ctx,
        PermissionFlag.OFFER_WITHDRAW,
      );
      const staff = rows.map((row: any) => {
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
          stage: resolveVenueOfferKanbanStage({ ...input, startsAt: effectiveAssignmentTime(row, shift).startsAt }),
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
      const count = (stage: string) =>
        staff.filter((r: any) => r.stage === stage).length;
      const confirmed = staff.filter((r: any) =>
        ['confirmed', 'completed'].includes(r.assignmentStatus),
      ).length;
      const accepted = staff.filter(
        (r: any) => r.assignmentStatus === 'staff_accepted',
      ).length;
      const rejected = staff.filter(
        (r: any) => r.offerStatus === 'declined',
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
          confirmed,
          accepted,
          rejected,
        }),
        summary: {
          required: shift.requiredCount,
          confirmed,
          accepted,
          open: Math.max(0, shift.requiredCount - confirmed),
          rejected,
          offered: count('OFFERED'),
          waiting: count('WAITING'),
          late: count('LATE STAFF'),
          clockedIn: count('CLOCKED IN'),
          clockedOut: count('CLOCKED OUT'),
        },
        stages: PIPELINE_STAGES,
        staff,
        report,
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
    return this.tenant.runInTenantContext(ctx, async (manager) => {
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

  async replace(ctx: AuthContext, id: string, ids: string[]) {
    return this.tenant.runInTenantContext(ctx, async (manager) => {
      const shift = await this.owned(
        manager,
        ctx,
        id,
        PermissionFlag.OFFER_SEND,
        true,
      );
      const [state] = await manager.query(
        `SELECT clock_timestamp() AS now, count(*)::int AS reserved FROM core.shift_assignment sa JOIN core.job_offer o ON o.shift_assignment_id=sa.id WHERE sa.shift_id=$1 AND sa.status IN ('offered','staff_accepted','confirmed','completed') AND o.status IN ('pending','staff_accepted','manager_confirmed')`,
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
      const offers = [];
      for (const staffId of ids)
        offers.push(
          await this.replacements.sendSelectedWithManager(
            manager,
            ctx,
            shift,
            staffId,
          ),
        );
      return { offerIds: offers.map((o) => o.id) };
    });
  }
}
