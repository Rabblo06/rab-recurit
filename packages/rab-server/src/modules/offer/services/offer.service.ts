import { assignmentTimeSql, validateAssignmentTime, ScheduledWindow, effectiveAssignmentBreakMinutes, defaultAssignmentTime, assignmentEnvelope } from '../../scheduling/utils/assignment-time';
import { UserNoteService } from '../../identity/services/user-note.service';
import { canCancelVenueOffer } from './venue-offer-presentation';
import { assertVenueTeamSelection } from '../../staff/services/venue-team-scope';
import {
  assertTransition,
  computeWorkedMinutes,
  OFFER_TRANSITIONS,
  OfferStatus,
  payForMinutes,
  SHIFT_ASSIGNMENT_TRANSITIONS,
  SHIFT_TRANSITIONS,
  ShiftAssignmentStatus,
  ShiftStatus,
  ShiftStatusType,
} from '@rab/shared';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { assertStaffEligibleForOffer } from './assert-staff-eligible-for-offer';
import { SchedulingService } from '../../scheduling/services/scheduling.service';
import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { ShiftRequestStaff } from '../../scheduling/entities/shift-request-staff.entity';
import { toTstzRange } from '../../scheduling/utils/tstzrange';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { toIlikePattern } from '../../../engine/utils/ilike-pattern.util';
import { NotificationService } from '../../notification/services/notification.service';
import { VenueService } from '../../venue/services/venue.service';
import { ApproveShiftRequestDto } from '../dto/approve-shift-request.dto';
import { CreateShiftAndSendDto } from '../dto/create-shift-and-send.dto';
import { DeclineOfferDto } from '../dto/decline-offer.dto';
import { ListOffersDto } from '../dto/list-offers.dto';
import { RejectOfferDto } from '../dto/reject-offer.dto';
import { SendBulkOfferDto } from '../dto/send-bulk-offer.dto';
import { SendOfferDto } from '../dto/send-offer.dto';
import { JobOffer } from '../entities/job-offer.entity';
import { applyOfferConfirmation } from './apply-offer-confirmation';
import { claimExpiredOffer } from './claim-expired-offer';
import { resolveStaffShiftPresentation } from './staff-shift-presentation';

/** Same allowlist-via-lookup-map pattern as `StaffService`'s `STAFF_SORT_COLUMNS` — see that file's comment. Raw SQL column expressions, never a client-supplied string. */
const OFFER_SORT_COLUMNS: Record<string, string> = {
  sentAt: 'o.sent_at',
  shiftDate: assignmentTimeSql().start,
  staff: 'u.first_name',
  venue: 'v.name',
  status: 'o.status',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export interface OfferSummary {
  id: string;
  status: string;
  sentAt: Date;
  expiresAt: Date;
  respondedAt: Date | null;
  declineReason: string | null;
  staffAcceptedAt: Date | null;
  managerConfirmedAt: Date | null;
  managerRejectedAt: Date | null;
  rejectionReason: string | null;
  estimatedPayPence: number;
  offerBatchId: string | null;
  shiftId: string;
  startsAt: Date;
  endsAt: Date;
  venueName: string;
  roleName: string;
  staffProfileId: string;
  staffName: string;
  payRatePence: number;
  venueAddress: string | null;
  shiftNotes: string | null;
  presentation: ReturnType<typeof resolveStaffShiftPresentation>;
}

export interface BulkOfferResult {
  batchId: string;
  results: Array<{ staffProfileId: string; ok: boolean; offerId?: string; message?: string }>;
}

export interface OfferBatchSummary {
  batchId: string;
  shift: { id: string; startsAt: Date; endsAt: Date; venueName: string; roleName: string } | null;
  counts: Record<string, number>;
  recipients: OfferSummary[];
}

const OFFER_SUMMARY_SELECT = `
  SELECT
    o.id, o.status, o.sent_at, o.expires_at, o.responded_at, o.decline_reason, o.estimated_pay_pence,
    o.staff_accepted_at, o.manager_confirmed_at, o.manager_rejected_at, o.rejection_reason, o.offer_batch_id,
    s.id AS shift_id, ${assignmentTimeSql().start} AS starts_at, ${assignmentTimeSql().end} AS ends_at, s.pay_rate_pence, s.address AS shift_address, s.notes AS shift_notes,
    v.name AS venue_name, jr.name AS role_name,
    sp.id AS staff_profile_id, u.first_name, u.last_name,
    sa.status AS assignment_status, s.status AS shift_status,
    a.status AS attendance_status, a.clock_in_at, a.clock_out_at, a.post_shift_completed_at, a.post_shift_expired_at,
    org.timezone, now() AS presentation_now
  FROM core.job_offer o
  JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id
  JOIN core.shift s ON s.id = sa.shift_id
  JOIN core.venue v ON v.id = s.venue_id
  JOIN core.job_role jr ON jr.id = s.job_role_id
  JOIN core.staff_profile sp ON sp.id = o.staff_profile_id
  JOIN core."user" u ON u.id = sp.user_id
  JOIN core.organisation org ON org.id = o.organisation_id
  LEFT JOIN core.attendance a ON a.shift_assignment_id = sa.id
    AND a.staff_profile_id = sp.id AND a.organisation_id = o.organisation_id
`;

function toOfferSummary(r: Record<string, unknown>): OfferSummary {
  return {
    id: r.id as string,
    status: r.status as string,
    sentAt: r.sent_at as Date,
    expiresAt: r.expires_at as Date,
    respondedAt: (r.responded_at as Date) ?? null,
    declineReason: (r.decline_reason as string) ?? null,
    staffAcceptedAt: (r.staff_accepted_at as Date) ?? null,
    managerConfirmedAt: (r.manager_confirmed_at as Date) ?? null,
    managerRejectedAt: (r.manager_rejected_at as Date) ?? null,
    rejectionReason: (r.rejection_reason as string) ?? null,
    estimatedPayPence: Number(r.estimated_pay_pence),
    offerBatchId: (r.offer_batch_id as string) ?? null,
    shiftId: r.shift_id as string,
    startsAt: r.starts_at as Date,
    endsAt: r.ends_at as Date,
    venueName: r.venue_name as string,
    roleName: r.role_name as string,
    staffProfileId: r.staff_profile_id as string,
    staffName: `${r.first_name} ${r.last_name}`,
    payRatePence: Number(r.pay_rate_pence),
    venueAddress: (r.shift_address as string) ?? null,
    shiftNotes: (r.shift_notes as string) ?? null,
    presentation: resolveStaffShiftPresentation({
      offerStatus: r.status as string, assignmentStatus: r.assignment_status as string,
      shiftStatus: r.shift_status as string, attendanceStatus: r.attendance_status as string,
      clockInAt: r.clock_in_at as Date, clockOutAt: r.clock_out_at as Date,
      completedAt: r.post_shift_completed_at as Date, expiredAt: r.post_shift_expired_at as Date,
      startsAt: r.starts_at as Date, endsAt: r.ends_at as Date,
      serverNow: r.presentation_now as Date, timezone: r.timezone as string,
    }),
  };
}

@Injectable()
export class OfferService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly notificationService: NotificationService,
    private readonly schedulingService: SchedulingService,
    private readonly resourceScope: ResourceScopeService,
    private readonly venueService: VenueService,
    private readonly userNotes: UserNoteService,
  ) {}

  /**
   * A normal manager's private scope is "offers I sent" (see
   * `StaffService.assertOwned`'s identical reasoning). Stage 2A Phase 2
   * retired the platform-admin org-wide bypass this used to have — cross-
   * Manager visibility is available only through the audited Admin Inspect
   * mechanism, which rebinds `ctx.userId` to the inspected target so this
   * same check naturally resolves against the target's own scope. An offer
   * with no recorded sender (predates ownership tracking and wasn't
   * recoverable from the audit trail — see
   * ResourceOwnershipSchema1786666700000) stays invisible to everyone,
   * never guessed into a manager's scope.
   */
  private assertOfferOwned(ctx: AuthContext, offer: JobOffer): void {
    if (offer.createdBy === ctx.userId) return;
    throw new NotFoundException('Offer not found.');
  }

  /**
   * Manager-facing: offers this manager sent, or offers at a Venue
   * Manager's assigned venues (they never send offers themselves —
   * `OFFER_SEND` isn't in their permission set — so a plain sender check
   * always came back empty for them, a real bug fixed alongside the
   * identical one in SchedulingService.list).
   */
  list(ctx: AuthContext, dto: ListOffersDto = {}): Promise<{ data: OfferSummary[]; total: number }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue' && scope.venueIds.length === 0) return { data: [], total: 0 };

      // Existing ownership/venue-assignment scoping is the FIRST condition,
      // never replaced — every filter below is ANDed onto it, so a caller
      // can only ever narrow within their own already-authorized scope.
      const conditions: string[] = [];
      const params: unknown[] = [];
      const nextParam = (value: unknown) => { params.push(value); return `$${params.length}`; };

      if (scope.kind === 'venue') {
        conditions.push(`s.venue_id = ANY(${nextParam(scope.venueIds)}::uuid[])`);
      } else {
        conditions.push(`o.created_by = ${nextParam(ctx.userId)}`);
      }
      if (dto.q) {
        const q = nextParam(toIlikePattern(dto.q));
        conditions.push(`(u.first_name ILIKE ${q} OR u.last_name ILIKE ${q} OR v.name ILIKE ${q} OR jr.name ILIKE ${q})`);
      }
      if (dto.status) conditions.push(`o.status = ${nextParam(dto.status)}`);
      if (dto.staffProfileId) conditions.push(`o.staff_profile_id = ${nextParam(dto.staffProfileId)}`);
      if (dto.venueId) conditions.push(`s.venue_id = ${nextParam(dto.venueId)}`);
      if (dto.jobRoleId) conditions.push(`s.job_role_id = ${nextParam(dto.jobRoleId)}`);
      if (dto.shiftDateFrom) conditions.push(`${assignmentTimeSql().start} >= ${nextParam(new Date(dto.shiftDateFrom))}`);
      if (dto.shiftDateTo) {
        const exclusive = new Date(dto.shiftDateTo);
        exclusive.setUTCDate(exclusive.getUTCDate() + 1);
        conditions.push(`${assignmentTimeSql().start} < ${nextParam(exclusive)}`);
      }
      if (dto.sentAtFrom) conditions.push(`o.sent_at >= ${nextParam(new Date(dto.sentAtFrom))}`);
      if (dto.sentAtTo) {
        const exclusive = new Date(dto.sentAtTo);
        exclusive.setUTCDate(exclusive.getUTCDate() + 1);
        conditions.push(`o.sent_at < ${nextParam(exclusive)}`);
      }

      const where = `WHERE ${conditions.join(' AND ')}`;
      const sortColumn = OFFER_SORT_COLUMNS[dto.sort ?? 'sentAt'] ?? OFFER_SORT_COLUMNS.sentAt;
      const direction = (dto.direction ?? 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      const [{ count }] = await manager.query(
        `SELECT count(*)::int AS count FROM core.job_offer o
           JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id
           JOIN core.shift s ON s.id = sa.shift_id
           JOIN core.venue v ON v.id = s.venue_id
           JOIN core.job_role jr ON jr.id = s.job_role_id
           JOIN core.staff_profile sp ON sp.id = o.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
         ${where}`,
        params,
      );

      const { skip, take } = paginationSkipTake(dto);
      const takeIdx = nextParam(take);
      const skipIdx = nextParam(skip);
      const rows = await manager.query(`${OFFER_SUMMARY_SELECT} ${where} ORDER BY ${sortColumn} ${direction} LIMIT ${takeIdx} OFFSET ${skipIdx}`, params);
      return { data: rows.map(toOfferSummary), total: count };
    });
  }

  /** Staff-facing: only the caller's own offers (mobile "my offers"). */
  listMine(ctx: AuthContext, pagination: PaginationDto = {}): Promise<OfferSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
      if (!staffProfile) return [];
      const { skip, take } = paginationSkipTake(pagination);
      const rows = await manager.query(
        `${OFFER_SUMMARY_SELECT} WHERE o.staff_profile_id = $1 ORDER BY o.sent_at DESC LIMIT $2 OFFSET $3`,
        [staffProfile.id, take, skip],
      );
      return rows.map(toOfferSummary);
    });
  }

  private async loadSendableShift(manager: EntityManager, ctx: AuthContext, shiftId: string): Promise<Shift> {
    const shift = await manager.findOne(Shift, { where: { id: shiftId }, lock: { mode: 'pessimistic_write' } });
    if (!shift) throw new NotFoundException('Shift not found.');
    // A manager may only send offers against a shift they own — otherwise a
    // guessed/enumerated shiftId for another manager's shift would let
    // Manager B reach into Manager A's private scheduling scope even though
    // Manager B can't list or GET Shift A directly (SchedulingService).
    if (shift.createdBy !== ctx.userId) {
      throw new NotFoundException('Shift not found.');
    }
    const acceptableStatuses: ShiftStatusType[] = [ShiftStatus.OPEN, ShiftStatus.OFFERED, ShiftStatus.PARTIALLY_FILLED];
    if (!acceptableStatuses.includes(shift.status)) {
      throw new ConflictException('Offers can only be sent for a published, unfilled shift.');
    }
    if (shift.filledCount >= shift.requiredCount) {
      throw new ConflictException('This shift is already fully staffed.');
    }
    return shift;
  }

  private async getShiftLabel(manager: EntityManager, shiftId: string): Promise<string | undefined> {
    const rows = await manager.query(
      `SELECT v.name AS venue_name, jr.name AS role_name FROM core.shift s
       JOIN core.venue v ON v.id = s.venue_id JOIN core.job_role jr ON jr.id = s.job_role_id
       WHERE s.id = $1`,
      [shiftId],
    );
    const row = rows[0] as { venue_name: string; role_name: string } | undefined;
    return row ? `${row.venue_name} · ${row.role_name}` : undefined;
  }

  /**
   * The per-recipient core shared by `send()` and `sendBulk()` — "batch of
   * 1" and "batch of 12" are the same code path, differing only in how many
   * times this is called and whether a shared transaction needs per-item
   * SAVEPOINTs around it (see `sendBulk`). Creates the seat (`shift_assignment`,
   * status `offered`) and the offer together — the assignment is what the
   * GiST "no double-booking" constraint and the race-safe confirm in
   * `confirmOne()` both key off, so it has to exist before anyone can respond.
   */
  private async sendOne(
    manager: EntityManager,
    ctx: AuthContext,
    shift: Shift,
    shiftLabel: string | undefined,
    staffProfileId: string,
    expiresInHours: number | undefined,
    batchId: string,
    proposedTime?: ScheduledWindow & { breakMinutes?: number | null },
  ): Promise<JobOffer> {
    const scheduledBreak = effectiveAssignmentBreakMinutes(proposedTime ?? null, shift);
    const time = validateAssignmentTime(shift, proposedTime ?? defaultAssignmentTime(shift), scheduledBreak);
    await assertVenueTeamSelection(manager, ctx, [staffProfileId], shift.workspaceId);
    // DOM-01 — the single canonical eligibility check (active employment,
    // active account, no duplicate offer, no overlapping confirmed shift),
    // shared by every offer-creation path via this one function. Per-recipient
    // failures here are tolerated by the batch loops that call `sendOne`,
    // same as before.
    const staffProfile = await assertStaffEligibleForOffer(manager, staffProfileId, shift.id, time);

    const assignment = manager.create(ShiftAssignment, {
      organisationId: ctx.organisationId!,
      // Inherited from the parent Shift — keeps ShiftAssignment.workspaceId
      // = Shift.workspaceId true by construction.
      workspaceId: shift.workspaceId,
      shiftId: shift.id,
      staffProfileId,
      status: ShiftAssignmentStatus.OFFERED,
      payRateSnapshotPence: shift.payRatePence,
      assignedBy: ctx.userId,
      period: toTstzRange(time.startsAt, time.endsAt),
      breakMinutes: proposedTime?.breakMinutes ?? null,
    });
    await manager.save(assignment);
    // Caller holds the shift lock. Expand only after a valid assignment exists.
    const envelope = assignmentEnvelope(shift, [time]);
    await manager.query(`UPDATE core.shift SET starts_at=LEAST(starts_at,$2), ends_at=GREATEST(ends_at,$3),
      default_starts_at=COALESCE(default_starts_at,$4), default_ends_at=COALESCE(default_ends_at,$5) WHERE id=$1`,
      [shift.id, envelope.startsAt, envelope.endsAt, shift.defaultStartsAt ?? shift.startsAt, shift.defaultEndsAt ?? shift.endsAt]);

    const { workedMinutes } = computeWorkedMinutes({
      clockInAt: time.startsAt,
      clockOutAt: time.endsAt,
      scheduledBreakMinutes: scheduledBreak,
    });
    const estimatedPayPence = payForMinutes(shift.payRatePence, workedMinutes);
    const expiresAt = new Date(Date.now() + (expiresInHours ?? 48) * 60 * 60 * 1000);

    const offer = manager.create(JobOffer, {
      organisationId: ctx.organisationId!,
      // Inherited from the ShiftAssignment (itself inherited from Shift) —
      // keeps JobOffer.workspaceId = ShiftAssignment.workspaceId true by
      // construction.
      workspaceId: assignment.workspaceId,
      shiftAssignmentId: assignment.id,
      staffProfileId,
      offerBatchId: batchId,
      status: OfferStatus.PENDING,
      sentAt: new Date(),
      expiresAt,
      estimatedPayPence,
      createdBy: ctx.userId,
    });
    await manager.save(offer);

    await this.auditService.record(manager, ctx, AuditAction.OFFER_SENT, {
      entityType: 'offer',
      entityId: offer.id,
      metadata: { name: shiftLabel, shiftId: shift.id, staffProfileId, offerBatchId: batchId },
    });
    await this.notificationService.notify(manager, {
      organisationId: ctx.organisationId!,
      userId: staffProfile.userId,
      type: 'offer_sent',
      title: 'New shift offer',
      message: shiftLabel ?? 'You have a new shift offer.',
      relatedEntityType: 'offer',
      relatedEntityId: offer.id,
    });

    return offer;
  }

  /**
   * PHASE 4 (replacement-staff workflow) — the manager-accepting entry
   * point for a caller that ALREADY has its own open transaction and must
   * create the offer inside it, not a new one. `ReplacementRequestService.
   * approve()` uses this instead of the public `send()` so the whole
   * "claim → revalidate → create offer → advance request → audit" sequence
   * is one atomic unit, never split across separate `runInTenantContext`
   * calls (which would each acquire an independent pooled connection — see
   * `TenantContextService.runInTenantContext`'s own doc comment on why a
   * nested call is unsafe).
   *
   * Reuses `sendOne()` — the exact same assignment/offer creation, overlap
   * check, audit, and notification every other send path uses — verbatim,
   * never duplicated. The one thing it deliberately DOESN'T reuse is
   * `loadSendableShift()`'s `shift.createdBy !== ctx.userId` ownership gate:
   * that gate encodes "a manager may only send offers for a shift they
   * personally created," which is the right rule for the direct send
   * endpoints but not for replacement approval, where any manager with
   * `OFFER_SEND` and legitimate visibility of the request (enforced by
   * `ReplacementRequest`'s own RLS policy plus the caller's service-level
   * checks) may approve a candidate for a shift someone else created. The
   * caller is responsible for its own equivalent authorization and for
   * passing an already-validated, already-loaded `shift`.
   */
  async sendOneWithManager(manager: EntityManager, ctx: AuthContext, shift: Shift, staffProfileId: string, expiresInHours?: number): Promise<JobOffer> {
    const shiftLabel = await this.getShiftLabel(manager, shift.id);
    const batchId = randomUUID();
    const offer = await this.sendOne(manager, ctx, shift, shiftLabel, staffProfileId, expiresInHours, batchId);
    if (shift.status === ShiftStatus.OPEN) {
      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.OFFERED);
      await manager.update(Shift, shift.id, { status: ShiftStatus.OFFERED });
    }
    return offer;
  }

  /**
   * `sendBulk` is the same underlying flow as this, just N times in one
   * batch — see `sendOne`'s doc comment. Kept as a thin wrapper so the
   * single-recipient endpoint's behaviour/return type is unchanged.
   */
  async send(ctx: AuthContext, shiftId: string, dto: SendOfferDto): Promise<JobOffer> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await this.loadSendableShift(manager, ctx, shiftId);
      const shiftLabel = await this.getShiftLabel(manager, shiftId);
      const batchId = randomUUID();

      const offer = await this.sendOne(manager, ctx, shift, shiftLabel, dto.staffProfileId, dto.expiresInHours, batchId);

      if (shift.status === ShiftStatus.OPEN) {
        assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.OFFERED);
        await manager.update(Shift, shiftId, { status: ShiftStatus.OFFERED });
      }

      return offer;
    });
  }

  /**
   * One send action, 1 or 100 recipients — see `sendOne`. All recipients
   * share one transaction (so `offer_batch_id` genuinely groups one atomic
   * "send" action), but each recipient's own failure (already offered,
   * etc.) must not abort the others' — every iteration runs inside its own
   * SAVEPOINT, rolled back only on that recipient's failure, so a bad
   * recipient can't poison a batch-mate's successful insert.
   */
  async sendBulk(ctx: AuthContext, shiftId: string, dto: SendBulkOfferDto): Promise<BulkOfferResult> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await this.loadSendableShift(manager, ctx, shiftId);
      const shiftLabel = await this.getShiftLabel(manager, shiftId);
      const batchId = randomUUID();

      const windows = new Map<string, ScheduledWindow & { breakMinutes?: number | null }>();
      for (const row of dto.staffAssignments ?? []) {
        if (!dto.staffProfileIds.includes(row.staffProfileId) || windows.has(row.staffProfileId)) throw new BadRequestException('Invalid or duplicate staff assignment.');
        windows.set(row.staffProfileId, { ...validateAssignmentTime(shift, { startsAt: new Date(row.startsAt), endsAt: new Date(row.endsAt) }, effectiveAssignmentBreakMinutes(row, shift)), breakMinutes: row.breakMinutes });
      }
      const results: BulkOfferResult['results'] = [];
      for (const staffProfileId of dto.staffProfileIds) {
        await manager.query('SAVEPOINT sp_bulk_send');
        try {
          const offer = await this.sendOne(manager, ctx, shift, shiftLabel, staffProfileId, dto.expiresInHours, batchId, windows.get(staffProfileId));
          results.push({ staffProfileId, ok: true, offerId: offer.id });
        } catch (error) {
          await manager.query('ROLLBACK TO SAVEPOINT sp_bulk_send');
          results.push({ staffProfileId, ok: false, message: errorMessage(error) });
        }
      }

      if (shift.status === ShiftStatus.OPEN && results.some((r) => r.ok)) {
        assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.OFFERED);
        await manager.update(Shift, shiftId, { status: ShiftStatus.OFFERED });
      }

      return { batchId, results };
    });
  }

  /**
   * The unified "New Shift" drawer's single action: creates the shift and
   * sends every selected staff member their offer in one transaction, no
   * separate create → publish → send-offer round trip. Reuses `resolvePayRate`
   * (SchedulingService) and `sendOne` (this file) verbatim rather than
   * duplicating either — this is genuinely the same shift-creation and
   * per-recipient-send logic those already have, just composed together.
   *
   * The shift is created directly in OPEN status, skipping DRAFT — `assertTransition`
   * only guards explicit status *changes* on existing rows, never an initial
   * INSERT value, so there's nothing to satisfy here (see SchedulingService.create,
   * which does the same for DRAFT). `requiredCount` is set to the number of
   * staff *successfully* sent an offer, corrected down after the send loop if
   * any recipient failed eligibility — never inflated by an attempt that never
   * became a real offer. If every recipient fails, the whole transaction
   * (including the shift row) rolls back rather than leaving a dangling
   * empty shift.
   */
  async createShiftAndSend(
    ctx: AuthContext,
    dto: CreateShiftAndSendDto,
  ): Promise<BulkOfferResult & { shiftId: string }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // Also closes the same IDOR SchedulingService.create() already
      // closes: without this, a Manager could create a shift against
      // another Manager's private venue by reusing a known venue id, even
      // though they can no longer see it in a list.
      const venue = await this.venueService.assertVenueAccessibleTx(manager, ctx, dto.venueId);
      const payRatePence = await this.schedulingService.resolvePayRate(manager, dto);

      const shift = manager.create(Shift, {
        organisationId: ctx.organisationId!,
        venueId: dto.venueId,
        jobRoleId: dto.jobRoleId,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        breakMinutes: dto.breakMinutes ?? 0,
        requiredCount: dto.requiredCount ?? dto.staffProfileIds.length,
        payRatePence,
        notes: dto.notes,
        address: dto.address,
        status: ShiftStatus.OPEN,
        createdBy: ctx.userId,
        // Inherited from the parent Venue — keeps Shift.workspaceId =
        // Venue.workspaceId true by construction, matching every other
        // Shift-creation path (SchedulingService.create).
        workspaceId: venue.workspaceId,
      });
      await manager.save(shift);

      const shiftLabel = await this.getShiftLabel(manager, shift.id);
      const batchId = randomUUID();

      const results: BulkOfferResult['results'] = [];
      for (const staffProfileId of dto.staffProfileIds) {
        await manager.query('SAVEPOINT sp_create_and_send');
        try {
          const offer = await this.sendOne(manager, ctx, shift, shiftLabel, staffProfileId, dto.expiresInHours, batchId);
          results.push({ staffProfileId, ok: true, offerId: offer.id });
        } catch (error) {
          await manager.query('ROLLBACK TO SAVEPOINT sp_create_and_send');
          results.push({ staffProfileId, ok: false, message: errorMessage(error) });
        }
      }

      const successCount = results.filter((r) => r.ok).length;
      if (successCount === 0) {
        throw new ConflictException('No offer could be sent to any of the selected staff — see the errors above.');
      }

      // OPEN → OFFERED, same transition sendBulk already makes when sending
      // to a pre-existing OPEN shift — same reasoning, see sendBulk above.
      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.OFFERED);
      // Explicit staffing requirements are independent of recipient count.
      // Preserve the web drawer's legacy default when it omits this field.
      const nextStatus = dto.requiredCount === undefined && successCount < dto.staffProfileIds.length ? { requiredCount: successCount } : {};
      await manager.update(Shift, shift.id, { status: ShiftStatus.OFFERED, ...nextStatus });

      return { batchId, shiftId: shift.id, results };
    });
  }

  /**
   * The other half of the Venue-Manager-request workflow —
   * `SchedulingService.submitRequest`/`listPendingApprovals`/`declineRequest`
   * handle everything that never touches an offer; this lives here instead
   * because approving *is* "make the shift OPEN, then send offers to the
   * selected staff," the same combined shape `createShiftAndSend` already
   * has for a brand-new shift, just against an existing, already-priced/
   * scheduled one. `requiredCount` is never adjusted down here (unlike
   * `createShiftAndSend`'s legacy-default case above) — it's always the
   * Venue Manager's own explicit `staffRequired` from submission, and
   * sending fewer offers than that now is exactly the "open positions"
   * shortfall Part H's staffing view is supposed to show, not an error to
   * silently paper over.
   *
   * `createdBy` is reassigned to the approving Internal Manager here
   * (`createdBy: ctx.userId`) — from this point on the shift is a normal
   * Internal-Manager-owned shift for every existing `assertShiftOwned`-
   * gated action (cancel, further `send`/`sendBulk` for replacement staff,
   * etc.); `requestedBy` is untouched, staying the permanent record of who
   * originally asked for this.
   */
  async approveShiftRequest(
    ctx: AuthContext,
    shiftId: string,
    dto: ApproveShiftRequestDto,
  ): Promise<BulkOfferResult & { shiftId: string }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id: shiftId }, lock: { mode: 'pessimistic_write' } });
      // Explicit org check alongside RLS — see SchedulingService
      // .assertShiftViewable's own comment on why a single enforcement
      // layer (RLS alone) isn't enough for this cross-user (Venue Manager
      // submits, Internal Manager approves) action.
      if (!shift || shift.organisationId !== ctx.organisationId) throw new NotFoundException('Shift not found.');
      if (shift.status !== ShiftStatus.PENDING_MANAGER_APPROVAL) {
        throw new NotFoundException('Shift not found.');
      }

      // The recipient list is re-derived from `shift_request_staff` here,
      // never taken from `dto.staffProfileIds` — the Venue Offers detail
      // drawer lets an Internal Manager add/remove staff on the pending
      // request BEFORE approving (`SchedulingService.addRequestedStaff`/
      // `removeRequestedStaff`), each persisted immediately as its own
      // action. Trusting a client-supplied list here would let a stale or
      // manipulated array re-include someone already removed (who was
      // explicitly told they were removed) or exclude someone added after
      // the client last fetched the page — the persisted table is the only
      // honest source of "who is actually still selected right now."
      const recipientRows = await manager.find(ShiftRequestStaff, { where: { shiftId } });
      const staffProfileIds = recipientRows.map((r) => r.staffProfileId);
      if (staffProfileIds.length === 0) {
        throw new ConflictException('No staff are selected on this request — add at least one before approving.');
      }

      const shiftLabel = await this.getShiftLabel(manager, shift.id);
      const batchId = randomUUID();

      const results: BulkOfferResult['results'] = [];
      for (const staffProfileId of staffProfileIds) {
        await manager.query('SAVEPOINT sp_approve_and_send');
        try {
          // DOM-01 — employment-status/account-active/duplicate/overlap
          // eligibility is now the single canonical check inside `sendOne`
          // (`assertStaffEligibleForOffer`); this used to duplicate the
          // employment-status half of it here, separately, which is exactly
          // how it drifted out of sync with send()/sendBulk()/
          // createShiftAndSend() (which never had this check at all).
          const offer = await this.sendOne(manager, ctx, shift, shiftLabel, staffProfileId, dto.expiresInHours, batchId,
            (() => { const row = recipientRows.find(r => r.staffProfileId === staffProfileId)!; return { startsAt: row.startsAt ?? defaultAssignmentTime(shift).startsAt, endsAt: row.endsAt ?? defaultAssignmentTime(shift).endsAt, breakMinutes: row.breakMinutes }; })());
          results.push({ staffProfileId, ok: true, offerId: offer.id });
        } catch (error) {
          await manager.query('ROLLBACK TO SAVEPOINT sp_approve_and_send');
          results.push({ staffProfileId, ok: false, message: errorMessage(error) });
        }
      }

      const successCount = results.filter((r) => r.ok).length;
      if (successCount === 0) {
        throw new ConflictException('No offer could be sent to any of the selected staff — see the errors above.');
      }

      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.OPEN);
      await manager.update(Shift, shift.id, {
        status: ShiftStatus.OPEN,
        approvedAt: new Date(),
        approvedBy: ctx.userId,
        createdBy: ctx.userId,
      });
      assertTransition(SHIFT_TRANSITIONS, ShiftStatus.OPEN, ShiftStatus.OFFERED);
      await manager.update(Shift, shift.id, { status: ShiftStatus.OFFERED });

      await this.auditService.record(manager, ctx, AuditAction.SHIFT_REQUEST_APPROVED, {
        entityType: 'shift',
        entityId: shift.id,
        metadata: { offerBatchId: batchId, sentTo: successCount, requested: staffProfileIds.length },
      });

      if (shift.requestedBy) {
        await this.notificationService.notify(manager, {
          organisationId: ctx.organisationId!,
          userId: shift.requestedBy,
          type: 'shift_request_approved',
          title: 'Shift request approved',
          message: shiftLabel ? `Your request for ${shiftLabel} was approved and offers are being sent.` : 'Your shift request was approved.',
          relatedEntityType: 'shift',
          relatedEntityId: shift.id,
        });
      }

      return { batchId, shiftId: shift.id, results };
    });
  }

  /** Transactional individual booking cancellation. Caller owns and locks the shift. */
  async cancelBookingWithManager(manager: EntityManager, ctx: AuthContext, shift: Shift, offerId: string, reason?: string): Promise<void> {
    const offer = await manager.findOne(JobOffer, { where: { id: offerId }, lock: { mode: 'pessimistic_write' } });
    if (!offer) throw new NotFoundException('Offer not found.');
    this.assertOfferOwned(ctx, offer);
    const assignment = await manager.findOne(ShiftAssignment, { where: { id: offer.shiftAssignmentId }, lock: { mode: 'pessimistic_write' } });
    if (!assignment || assignment.shiftId !== shift.id) throw new NotFoundException('Offer not found.');
    const [clock] = await manager.query('SELECT clock_timestamp() AS now');
    const attendance = await manager.query('SELECT 1 FROM core.attendance WHERE shift_assignment_id=$1', [assignment.id]);
    if (!canCancelVenueOffer({ startsAt: shift.startsAt, serverNow: new Date(clock.now), shiftStatus: shift.status, assignmentStatus: assignment.status, offerStatus: offer.status, hasAttendance: attendance.length > 0 })) {
      throw new ConflictException('This booking cannot be cancelled. Cancellation closes 15 minutes before the shift starts.');
    }
    const staff = await manager.findOne(StaffProfile, { where: { id: offer.staffProfileId } });
    if (!staff || staff.createdBy !== ctx.userId || staff.workspaceId !== ctx.workspaceId) throw new NotFoundException('Staff not found.');
    const nextAssignment = offer.status === OfferStatus.PENDING ? ShiftAssignmentStatus.WITHDRAWN : ShiftAssignmentStatus.CANCELLED;
    assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, nextAssignment);
    if (offer.status === OfferStatus.PENDING) {
      assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.WITHDRAWN);
      await manager.update(JobOffer, offer.id, { status: OfferStatus.WITHDRAWN, respondedAt: new Date(clock.now) });
    } else if (offer.status === OfferStatus.STAFF_ACCEPTED) {
      assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.MANAGER_REJECTED);
      await manager.update(JobOffer, offer.id, { status: OfferStatus.MANAGER_REJECTED, managerRejectedAt: new Date(clock.now), rejectedBy: ctx.userId, rejectionReason: reason });
    }
    await manager.update(ShiftAssignment, assignment.id, { status: nextAssignment });
    if (assignment.status === ShiftAssignmentStatus.CONFIRMED) {
      const filledCount = Math.max(0, shift.filledCount - 1);
      const next = filledCount ? ShiftStatus.PARTIALLY_FILLED : ShiftStatus.OFFERED;
      if (next !== shift.status) assertTransition(SHIFT_TRANSITIONS, shift.status, next);
      await manager.update(Shift, shift.id, { filledCount, status: next });
    }
    if (reason?.trim()) {
      const label = await this.getShiftLabel(manager, shift.id);
      await this.userNotes.add(manager, ctx, staff.userId, `Offer cancelled - ${label ?? 'Venue shift'}\n${shift.startsAt.toISOString()}\n\n${reason.trim()}`);
    }
    await this.auditService.record(manager, ctx, AuditAction.OFFER_WITHDRAWN, {
      entityType: 'offer', entityId: offer.id,
      metadata: { source: 'manager_pipeline_cancellation', shiftId: shift.id, reason: reason?.trim() || null, assignmentStatus: nextAssignment },
    });
    await this.notificationService.notify(manager, { organisationId: ctx.organisationId!, userId: staff.userId,
      type: 'shift_cancelled', title: 'Offer cancelled', message: reason?.trim() || 'Your booking has been cancelled by your manager.', relatedEntityType: 'offer', relatedEntityId: offer.id });
  }

  async withdraw(ctx: AuthContext, offerId: string): Promise<JobOffer> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const offer = await manager.findOne(JobOffer, { where: { id: offerId } });
      if (!offer) throw new NotFoundException('Offer not found.');
      this.assertOfferOwned(ctx, offer);
      assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.WITHDRAWN);

      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.WITHDRAWN);

      // WHERE status = :priorStatus (the status we just read and validated
      // via assertTransition) — a concurrent duplicate request (double-tap,
      // network retry) gets zero affected rows and a clean 409 instead of
      // silently re-applying the same transition twice.
      const [, withdrawnCount] = (await manager.query(
        `UPDATE core.job_offer SET status = $1, responded_at = $2 WHERE id = $3 AND status = $4`,
        [OfferStatus.WITHDRAWN, new Date(), offer.id, offer.status],
      )) as [unknown, number];
      if (withdrawnCount === 0) {
        throw new ConflictException('This offer was already responded to — please refresh and try again.');
      }
      await manager.update(ShiftAssignment, assignment.id, { status: ShiftAssignmentStatus.WITHDRAWN });

      await this.auditService.record(manager, ctx, AuditAction.OFFER_WITHDRAWN, {
        entityType: 'offer',
        entityId: offer.id,
        metadata: { offerBatchId: offer.offerBatchId },
      });

      return manager.findOneByOrFail(JobOffer, { id: offer.id });
    });
  }

  /**
   * Step 1 of 2 (CLAUDE.md two-step confirmation flow): staff accepting an
   * offer only reserves it for manager review. It does NOT claim a shift
   * seat, does NOT touch `shift.filled_count`, and does NOT satisfy the
   * GiST no-double-booking constraint (that only fires on `confirmed`).
   * The only way to reach `MANAGER_CONFIRMED` is `confirmOne()` below —
   * there is no transition from PENDING or STAFF_ACCEPTED straight to
   * MANAGER_CONFIRMED in `OFFER_TRANSITIONS`, so this is enforced by the
   * state machine itself, not just by which endpoints exist.
   */
  async staffAccept(ctx: AuthContext, offerId: string): Promise<JobOffer> {
    const claim = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
      if (!staffProfile) throw new NotFoundException('Offer not found.');

      const offer = await manager.findOne(JobOffer, {
        where: { id: offerId, staffProfileId: staffProfile.id },
      });
      if (!offer) throw new NotFoundException('Offer not found.');

      // Fails fast, with the existing clean error, for a status that could
      // never legitimately reach STAFF_ACCEPTED regardless of timing
      // (declined/withdrawn/already-accepted/etc). Deliberately NOT the
      // authority on whether a PENDING offer has expired — this is a
      // possibly-stale in-memory read; PHASE 6's atomic claim below, against
      // real DB time, is what actually decides that.
      assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.STAFF_ACCEPTED);

      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.STAFF_ACCEPTED);

      // PHASE 5 (§4) — lock + reload the shift BEFORE claiming the offer.
      // Without this, a shift cancelled between send and accept let the
      // accept through anyway on the common (non-auto-confirm) path below:
      // this method never previously re-checked `shift.status` at all, only
      // `offer.status`/`assignment.status`. `pessimistic_write` serialises
      // this against `SchedulingService.cancel()`'s own row-level UPDATE on
      // the exact same shift row — whichever commits first, the other sees
      // the fresh, post-commit state.
      const shift = await manager.findOne(Shift, { where: { id: assignment.shiftId }, lock: { mode: 'pessimistic_write' } });
      if (!shift || shift.status === ShiftStatus.CANCELLED) {
        throw new ConflictException('This shift has been cancelled and can no longer be accepted.');
      }

      // A shift born from the Venue-Manager-request-and-Internal-Manager-
      // approve flow (`requestedBy IS NOT NULL`) skips the old second
      // manager-confirm step entirely (§G1) — that Internal Manager already
      // made their one decision when they approved the request and chose
      // who to send offers to; requiring a second click here would just be
      // the same person confirming their own send. A directly-created shift
      // (`requestedBy IS NULL`, e.g. via `createShiftAndSend`) keeps the
      // original two-step flow untouched.
      const autoConfirm = shift.requestedBy != null;

      // PHASE 6 — ONE atomic claim: still PENDING AND not yet past its
      // deadline, by REAL DB time (`now()`), never Node's `Date.now()` or
      // any client-supplied time — this is the actual accept-vs-expire
      // mutual-exclusion boundary. Whichever of this UPDATE or the worker's
      // own `claimExpiredOffer` (offer-expiry.job.ts) reaches this row's
      // lock first wins; the other's WHERE clause simply no longer matches
      // once it re-evaluates against the post-commit row. A concurrent
      // double-accept (double-tap, retry, a second device) hits the exact
      // same guard — zero affected rows, clean 409, never a silently
      // duplicated acceptance.
      const now = new Date();
      const [claimedRows] = (await manager.query(
        `UPDATE core.job_offer
           SET status = $1, responded_at = $2, staff_accepted_at = $2
           WHERE id = $3 AND status = $4 AND expires_at > now()
           RETURNING id`,
        [OfferStatus.STAFF_ACCEPTED, now, offer.id, OfferStatus.PENDING],
      )) as [Array<{ id: string }>, number];

      if (claimedRows.length === 0) {
        // Deliberately does NOT attempt the expiry claim here. This whole
        // callback runs inside `runInTenantContext`'s `dataSource.transaction()`
        // — if it throws (as every branch below eventually does, to report
        // the failed accept to the caller), TypeORM rolls back EVERYTHING
        // this transaction wrote, including a `claimExpiredOffer` call made
        // moments earlier in the same transaction. An earlier version of this
        // method claimed the expiry, audited it, and then threw — which
        // silently discarded that exact claim and audit row every time,
        // leaving the offer stuck at PENDING in the database even though the
        // caller correctly saw "this offer has expired." The real claim
        // happens below, AFTER this transaction has returned (committed),
        // in its own separate transaction that does not end in a throw.
        return { outcome: 'not-claimed' as const, assignmentAssignedBy: assignment.assignedBy };
      }
      await manager.update(ShiftAssignment, assignment.id, { status: ShiftAssignmentStatus.STAFF_ACCEPTED });

      await this.auditService.record(manager, ctx, AuditAction.OFFER_ACCEPTED, {
        entityType: 'offer',
        entityId: offer.id,
        metadata: { offerBatchId: offer.offerBatchId },
      });
      // "…awaiting your confirmation" would be false for the auto-confirm
      // path below — that manager already made their one decision at
      // approval time, so there's nothing left for them to be told is
      // pending. They still learn the seat filled via `offer_confirmed`
      // (sent to the staff member) reflecting on the same Shift they can
      // already see filled_count update on.
      if (assignment.assignedBy && !autoConfirm) {
        await this.notificationService.notify(manager, {
          organisationId: ctx.organisationId!,
          userId: assignment.assignedBy,
          type: 'offer_accepted',
          title: 'Offer accepted',
          message: 'A staff member accepted a shift offer and is awaiting your confirmation.',
          relatedEntityType: 'offer',
          relatedEntityId: offer.id,
        });
      }

      if (autoConfirm) {
        const acceptedOffer = await manager.findOneByOrFail(JobOffer, { id: offer.id });
        const acceptedAssignment = await manager.findOneByOrFail(ShiftAssignment, { id: assignment.id });
        // `confirmedBy: null` — no Internal Manager clicked confirm; the
        // audit entry's actor stays this method's own ctx (the staff
        // member), accurately reflecting who actually triggered it —
        // `actorUserId` omitted so `applyOfferConfirmation` keeps that
        // existing default, unlike the system-timeout caller.
        const confirmed = await applyOfferConfirmation(manager, this.auditService, this.notificationService, ctx, acceptedOffer, acceptedAssignment, null);
        return { outcome: 'accepted' as const, offer: confirmed };
      }

      return { outcome: 'accepted' as const, offer: await manager.findOneByOrFail(JobOffer, { id: offer.id }) };
    });

    if (claim.outcome === 'accepted') return claim.offer;

    // Not claimed as accepted — resolve WHY in a fresh transaction. Either
    // this is genuinely expired by real DB time and nobody has claimed that
    // transition yet (claim it ourselves via the SAME shared, canonical
    // function the worker uses — never a second, diverging expiry
    // implementation, per Phase 6's "one canonical transition layer"
    // requirement), or something else already resolved this offer (another
    // device's accept, a decline, a manager's withdraw). This transaction
    // does not throw on a successful claim, so a genuine expiry here
    // actually commits.
    const expiredOffer = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const offer = await claimExpiredOffer(manager, offerId);
      if (offer) {
        await this.auditService.record(manager, ctx, AuditAction.OFFER_EXPIRED, {
          entityType: 'offer',
          entityId: offer.id,
          metadata: { offerBatchId: offer.offerBatchId },
        });
        if (claim.assignmentAssignedBy) {
          await this.notificationService.notify(manager, {
            organisationId: ctx.organisationId!,
            userId: claim.assignmentAssignedBy,
            type: 'offer_expired',
            title: 'Offer expired',
            message: 'A shift offer expired before the staff member responded.',
            relatedEntityType: 'offer',
            relatedEntityId: offer.id,
          });
        }
      }
      return offer;
    });
    if (expiredOffer) {
      throw new ConflictException('This offer has expired.');
    }
    const current = await this.tenantContext.runInTenantContext(ctx, (manager) => manager.findOneByOrFail(JobOffer, { id: offerId }));
    if (current.status === OfferStatus.EXPIRED) {
      throw new ConflictException('This offer has expired.');
    }
    throw new ConflictException('This offer was already responded to — please refresh and try again.');
  }

  async decline(ctx: AuthContext, offerId: string, dto: DeclineOfferDto): Promise<JobOffer> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
      if (!staffProfile) throw new NotFoundException('Offer not found.');

      const offer = await manager.findOne(JobOffer, {
        where: { id: offerId, staffProfileId: staffProfile.id },
      });
      if (!offer) throw new NotFoundException('Offer not found.');
      assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.DECLINED);

      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.DECLINED);

      // WHERE status = :priorStatus — see staffAccept's identical guard.
      const [, declinedCount] = (await manager.query(
        `UPDATE core.job_offer SET status = $1, responded_at = $2, decline_reason = $3 WHERE id = $4 AND status = $5`,
        [OfferStatus.DECLINED, new Date(), dto.reason, offer.id, offer.status],
      )) as [unknown, number];
      if (declinedCount === 0) {
        throw new ConflictException('This offer was already responded to — please refresh and try again.');
      }
      await manager.update(ShiftAssignment, assignment.id, { status: ShiftAssignmentStatus.DECLINED });

      await this.auditService.record(manager, ctx, AuditAction.OFFER_DECLINED, {
        entityType: 'offer',
        entityId: offer.id,
        metadata: { offerBatchId: offer.offerBatchId, reason: dto.reason },
      });
      if (assignment.assignedBy) {
        await this.notificationService.notify(manager, {
          organisationId: ctx.organisationId!,
          userId: assignment.assignedBy,
          type: 'offer_declined',
          title: 'Offer declined',
          message: 'A staff member declined a shift offer.',
          relatedEntityType: 'offer',
          relatedEntityId: offer.id,
        });
      }

      return manager.findOneByOrFail(JobOffer, { id: offer.id });
    });
  }

  /**
   * Step 2 of 2: only a manager can reach this, only from STAFF_ACCEPTED
   * (enforced by `assertTransition`, not just by who can call the
   * endpoint — see `OfferController`'s `OFFER_CONFIRM` guard for the
   * authorisation half). This is where the last-seat race
   * (rab-workforce-architecture.md §8.4) actually resolves: the atomic
   * `UPDATE ... WHERE filled_count < required_count` is the lock. Whoever's
   * UPDATE returns a row wins the seat; everyone else gets zero rows back
   * and a clean `SHIFT_FULL`, never a duplicate booking. `confirmAll` calls
   * this once per batch recipient inside its own SAVEPOINT, so one
   * recipient losing the race doesn't abort a batch-mate's successful
   * confirm.
   *
   * The offer's own status is claimed atomically FIRST (`WHERE status =
   * :priorStatus`), before the filled_count claim below — without this, two
   * concurrent confirms of the SAME offer (double-click, network retry)
   * both pass the in-memory `assertTransition` check (neither has committed
   * yet), then both reach the filled_count UPDATE: the first's row lock
   * blocks the second until it commits, and under READ COMMITTED the
   * second's UPDATE then re-evaluates against the now-committed row and
   * can ALSO succeed if capacity allows — incrementing filled_count twice
   * for one real confirmation. Claiming the offer's status first closes
   * that window: only one caller can ever win the `WHERE status =
   * STAFF_ACCEPTED` guard, so only one caller ever reaches the capacity
   * claim for this offer.
   */
  private async confirmOne(manager: EntityManager, ctx: AuthContext, offerId: string): Promise<JobOffer> {
    const offer = await manager.findOne(JobOffer, { where: { id: offerId } });
    if (!offer) throw new NotFoundException('Offer not found.');
    this.assertOfferOwned(ctx, offer);
    const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
    return applyOfferConfirmation(manager, this.auditService, this.notificationService, ctx, offer, assignment, ctx.userId);
  }

  async managerConfirm(ctx: AuthContext, offerId: string): Promise<JobOffer> {
    return this.tenantContext.runInTenantContext(ctx, (manager) => this.confirmOne(manager, ctx, offerId));
  }

  /**
   * "Confirm All Accepted" — every `STAFF_ACCEPTED` offer in one batch,
   * one manager action. Each recipient runs inside its own SAVEPOINT (see
   * `confirmOne`'s doc comment) so one recipient losing the last-seat race
   * doesn't roll back a batch-mate's already-successful confirm.
   */
  async confirmAll(ctx: AuthContext, batchId: string): Promise<BulkOfferResult> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const offers = await manager.find(JobOffer, { where: { offerBatchId: batchId } });
      if (offers.length === 0) throw new NotFoundException('Offer batch not found.');

      const toConfirm = offers.filter((o) => o.status === OfferStatus.STAFF_ACCEPTED);
      const results: BulkOfferResult['results'] = [];
      for (const offer of toConfirm) {
        await manager.query('SAVEPOINT sp_bulk_confirm');
        try {
          const confirmed = await this.confirmOne(manager, ctx, offer.id);
          results.push({ staffProfileId: offer.staffProfileId, ok: true, offerId: confirmed.id });
        } catch (error) {
          await manager.query('ROLLBACK TO SAVEPOINT sp_bulk_confirm');
          results.push({ staffProfileId: offer.staffProfileId, ok: false, message: errorMessage(error) });
        }
      }

      return { batchId, results };
    });
  }

  /** Batch summary for `BatchOfferDrawer` — one shift, N recipients, counted by status. RLS scopes the org filter. */
  async getBatch(ctx: AuthContext, batchId: string): Promise<OfferBatchSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const rows = await manager.query(`${OFFER_SUMMARY_SELECT} WHERE o.offer_batch_id = $1 ORDER BY u.first_name`, [
        batchId,
      ]);
      if (rows.length === 0) throw new NotFoundException('Offer batch not found.');

      // A batch shares one sender — every row was stamped with the same
      // ctx.userId in the same send() call — so checking one row's
      // ownership speaks for the whole batch.
      const [sample] = await manager.query(`SELECT created_by FROM core.job_offer WHERE offer_batch_id = $1 LIMIT 1`, [
        batchId,
      ]);
      const isOwner = sample?.created_by === ctx.userId;
      if (!isOwner) {
        throw new NotFoundException('Offer batch not found.');
      }

      const recipients = rows.map(toOfferSummary);
      const counts: Record<string, number> = {};
      for (const r of recipients) counts[r.status] = (counts[r.status] ?? 0) + 1;

      const first = recipients[0]!;
      return {
        batchId,
        shift: {
          id: first.shiftId,
          startsAt: first.startsAt,
          endsAt: first.endsAt,
          venueName: first.venueName,
          roleName: first.roleName,
        },
        counts,
        recipients,
      };
    });
  }

  /** The manager's alternative to confirming: decline the staff member's acceptance. Never claims a seat, so no capacity bookkeeping to undo. */
  async managerReject(ctx: AuthContext, offerId: string, dto: RejectOfferDto): Promise<JobOffer> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const offer = await manager.findOne(JobOffer, { where: { id: offerId } });
      if (!offer) throw new NotFoundException('Offer not found.');
      this.assertOfferOwned(ctx, offer);
      assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.MANAGER_REJECTED);

      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.REJECTED);

      const now = new Date();
      // WHERE status = :priorStatus — see staffAccept's identical guard
      // (double-tap "reject" must not double-fire the staff notification).
      const [, rejectedCount] = (await manager.query(
        `UPDATE core.job_offer SET status = $1, manager_rejected_at = $2, rejected_by = $3, rejection_reason = $4
           WHERE id = $5 AND status = $6`,
        [OfferStatus.MANAGER_REJECTED, now, ctx.userId, dto.reason, offer.id, offer.status],
      )) as [unknown, number];
      if (rejectedCount === 0) {
        throw new ConflictException('This offer was already responded to — please refresh and try again.');
      }
      await manager.update(ShiftAssignment, assignment.id, { status: ShiftAssignmentStatus.REJECTED });

      await this.auditService.record(manager, ctx, AuditAction.OFFER_REJECTED, {
        entityType: 'offer',
        entityId: offer.id,
        metadata: { offerBatchId: offer.offerBatchId, reason: dto.reason },
      });
      const staffProfile = await manager.findOne(StaffProfile, { where: { id: offer.staffProfileId } });
      if (staffProfile) {
        await this.notificationService.notify(manager, {
          organisationId: ctx.organisationId!,
          userId: staffProfile.userId,
          type: 'offer_rejected',
          title: 'Offer not confirmed',
          message: dto.reason ?? 'Your accepted offer was not confirmed by the manager.',
          relatedEntityType: 'offer',
          relatedEntityId: offer.id,
        });
      }

      return manager.findOneByOrFail(JobOffer, { id: offer.id });
    });
  }
}
