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
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '../../scheduling/utils/tstzrange';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { DeclineOfferDto } from '../dto/decline-offer.dto';
import { RejectOfferDto } from '../dto/reject-offer.dto';
import { SendOfferDto } from '../dto/send-offer.dto';
import { JobOffer } from '../entities/job-offer.entity';

/** Postgres SQLSTATE for an exclusion-constraint violation (the GiST "no double-booking" constraint). */
const POSTGRES_EXCLUSION_VIOLATION = '23P01';

function isExclusionViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === POSTGRES_EXCLUSION_VIOLATION;
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
  shiftId: string;
  startsAt: Date;
  endsAt: Date;
  venueName: string;
  roleName: string;
  staffProfileId: string;
  staffName: string;
}

const OFFER_SUMMARY_SELECT = `
  SELECT
    o.id, o.status, o.sent_at, o.expires_at, o.responded_at, o.decline_reason, o.estimated_pay_pence,
    o.staff_accepted_at, o.manager_confirmed_at, o.manager_rejected_at, o.rejection_reason,
    s.id AS shift_id, s.starts_at, s.ends_at,
    v.name AS venue_name, jr.name AS role_name,
    sp.id AS staff_profile_id, u.first_name, u.last_name
  FROM core.job_offer o
  JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id
  JOIN core.shift s ON s.id = sa.shift_id
  JOIN core.venue v ON v.id = s.venue_id
  JOIN core.job_role jr ON jr.id = s.job_role_id
  JOIN core.staff_profile sp ON sp.id = o.staff_profile_id
  JOIN core."user" u ON u.id = sp.user_id
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
    shiftId: r.shift_id as string,
    startsAt: r.starts_at as Date,
    endsAt: r.ends_at as Date,
    venueName: r.venue_name as string,
    roleName: r.role_name as string,
    staffProfileId: r.staff_profile_id as string,
    staffName: `${r.first_name} ${r.last_name}`,
  };
}

@Injectable()
export class OfferService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** Manager-facing: every offer in the org. */
  list(ctx: AuthContext): Promise<OfferSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const rows = await manager.query(`${OFFER_SUMMARY_SELECT} ORDER BY o.sent_at DESC`);
      return rows.map(toOfferSummary);
    });
  }

  /** Staff-facing: only the caller's own offers (mobile "my offers"). */
  listMine(ctx: AuthContext): Promise<OfferSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
      if (!staffProfile) return [];
      const rows = await manager.query(
        `${OFFER_SUMMARY_SELECT} WHERE o.staff_profile_id = $1 ORDER BY o.sent_at DESC`,
        [staffProfile.id],
      );
      return rows.map(toOfferSummary);
    });
  }

  /**
   * Creates the seat (`shift_assignment`, status `offered`) and the offer
   * in the same transaction — the assignment is what the GiST "no
   * double-booking" constraint and the race-safe confirm in
   * `managerConfirm()` both key off, so it has to exist before anyone can
   * respond. Bulk-sending (send to several staff for one shift) is a
   * client-side loop over this single-send call, not a separate endpoint —
   * each send is independently valid/invalid (e.g. one staff member already
   * offered shouldn't block the rest), so per-item results are the correct
   * UX, not an all-or-nothing transaction.
   */
  async send(ctx: AuthContext, shiftId: string, dto: SendOfferDto): Promise<JobOffer> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id: shiftId } });
      if (!shift) throw new NotFoundException('Shift not found.');
      const acceptableStatuses: ShiftStatusType[] = [ShiftStatus.OPEN, ShiftStatus.OFFERED, ShiftStatus.PARTIALLY_FILLED];
      if (!acceptableStatuses.includes(shift.status)) {
        throw new ConflictException('Offers can only be sent for a published, unfilled shift.');
      }
      if (shift.filledCount >= shift.requiredCount) {
        throw new ConflictException('This shift is already fully staffed.');
      }

      const staffProfile = await manager.findOne(StaffProfile, { where: { id: dto.staffProfileId } });
      if (!staffProfile) throw new NotFoundException('Staff member not found.');

      const existing = await manager.findOne(ShiftAssignment, {
        where: { shiftId, staffProfileId: dto.staffProfileId },
      });
      if (existing) throw new ConflictException('This staff member has already been offered this shift.');

      const assignment = manager.create(ShiftAssignment, {
        organisationId: ctx.organisationId!,
        shiftId,
        staffProfileId: dto.staffProfileId,
        status: ShiftAssignmentStatus.OFFERED,
        payRateSnapshotPence: shift.payRatePence,
        assignedBy: ctx.userId,
        period: toTstzRange(shift.startsAt, shift.endsAt),
      });
      await manager.save(assignment);

      const { workedMinutes } = computeWorkedMinutes({
        clockInAt: shift.startsAt,
        clockOutAt: shift.endsAt,
        scheduledBreakMinutes: shift.breakMinutes,
      });
      const estimatedPayPence = payForMinutes(shift.payRatePence, workedMinutes);
      const expiresAt = new Date(Date.now() + (dto.expiresInHours ?? 48) * 60 * 60 * 1000);

      const offer = manager.create(JobOffer, {
        organisationId: ctx.organisationId!,
        shiftAssignmentId: assignment.id,
        staffProfileId: dto.staffProfileId,
        status: OfferStatus.PENDING,
        sentAt: new Date(),
        expiresAt,
        estimatedPayPence,
      });
      await manager.save(offer);

      if (shift.status === ShiftStatus.OPEN) {
        assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.OFFERED);
        await manager.update(Shift, shiftId, { status: ShiftStatus.OFFERED });
      }

      return offer;
    });
  }

  async withdraw(ctx: AuthContext, offerId: string): Promise<JobOffer> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const offer = await manager.findOne(JobOffer, { where: { id: offerId } });
      if (!offer) throw new NotFoundException('Offer not found.');
      assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.WITHDRAWN);

      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.WITHDRAWN);

      await manager.update(ShiftAssignment, assignment.id, { status: ShiftAssignmentStatus.WITHDRAWN });
      await manager.update(JobOffer, offer.id, { status: OfferStatus.WITHDRAWN, respondedAt: new Date() });
      return manager.findOneByOrFail(JobOffer, { id: offer.id });
    });
  }

  /**
   * Step 1 of 2 (CLAUDE.md two-step confirmation flow): staff accepting an
   * offer only reserves it for manager review. It does NOT claim a shift
   * seat, does NOT touch `shift.filled_count`, and does NOT satisfy the
   * GiST no-double-booking constraint (that only fires on `confirmed`).
   * The only way to reach `MANAGER_CONFIRMED` is `managerConfirm()` below —
   * there is no transition from PENDING or STAFF_ACCEPTED straight to
   * MANAGER_CONFIRMED in `OFFER_TRANSITIONS`, so this is enforced by the
   * state machine itself, not just by which endpoints exist.
   */
  async staffAccept(ctx: AuthContext, offerId: string): Promise<JobOffer> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
      if (!staffProfile) throw new NotFoundException('Offer not found.');

      const offer = await manager.findOne(JobOffer, {
        where: { id: offerId, staffProfileId: staffProfile.id },
      });
      if (!offer) throw new NotFoundException('Offer not found.');

      if (offer.status === OfferStatus.PENDING && offer.expiresAt.getTime() < Date.now()) {
        await manager.update(JobOffer, offer.id, { status: OfferStatus.EXPIRED });
        throw new ConflictException('This offer has expired.');
      }
      assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.STAFF_ACCEPTED);

      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.STAFF_ACCEPTED);

      const now = new Date();
      await manager.update(ShiftAssignment, assignment.id, { status: ShiftAssignmentStatus.STAFF_ACCEPTED });
      await manager.update(JobOffer, offer.id, {
        status: OfferStatus.STAFF_ACCEPTED,
        respondedAt: now,
        staffAcceptedAt: now,
      });
      return manager.findOneByOrFail(JobOffer, { id: offer.id });
    });
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

      await manager.update(ShiftAssignment, assignment.id, { status: ShiftAssignmentStatus.DECLINED });
      await manager.update(JobOffer, offer.id, {
        status: OfferStatus.DECLINED,
        respondedAt: new Date(),
        declineReason: dto.reason,
      });
      return manager.findOneByOrFail(JobOffer, { id: offer.id });
    });
  }

  /**
   * Step 2 of 2: only a manager can reach this, only from STAFF_ACCEPTED
   * (enforced by `assertTransition`, not just by who can call the
   * endpoint — see `OfferController`'s `OFFER_CONFIRM` guard for the
   * authorisation half). This is now where the last-seat race
   * (rab-workforce-architecture.md §8.4) actually resolves: the atomic
   * `UPDATE ... WHERE filled_count < required_count` is the lock. Whoever's
   * UPDATE returns a row wins the seat; everyone else gets zero rows back
   * and a clean `SHIFT_FULL`, never a duplicate booking. Two managers
   * racing to confirm the same offer resolve the same way — the second
   * manager's confirm re-reads the (by-then STAFF_ACCEPTED-guarded)
   * offer/assignment via `assertTransition`, so at most one of them can
   * reach MANAGER_CONFIRMED even before the capacity check runs.
   */
  async managerConfirm(ctx: AuthContext, offerId: string): Promise<JobOffer> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const offer = await manager.findOne(JobOffer, { where: { id: offerId } });
      if (!offer) throw new NotFoundException('Offer not found.');
      assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.MANAGER_CONFIRMED);

      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.CONFIRMED);

      // TypeORM's manager.query() returns [rows, rowCount] for UPDATE/DELETE
      // statements (unlike SELECT, which returns rows directly) — not the
      // rows array itself.
      const [claimedRows] = (await manager.query(
        `UPDATE core.shift SET filled_count = filled_count + 1, updated_at = now()
           WHERE id = $1 AND organisation_id = $2 AND filled_count < required_count
           RETURNING filled_count, required_count, pay_rate_pence, status`,
        [assignment.shiftId, ctx.organisationId],
      )) as [Array<Record<string, unknown>>, number];
      if (claimedRows.length === 0) {
        throw new ConflictException('SHIFT_FULL: This shift is now full. Another offer may already be confirmed.');
      }

      const row = claimedRows[0] as {
        filled_count: number;
        required_count: number;
        pay_rate_pence: string;
        status: string;
      };
      const nextShiftStatus =
        row.filled_count >= row.required_count ? ShiftStatus.FULLY_FILLED : ShiftStatus.PARTIALLY_FILLED;
      assertTransition(SHIFT_TRANSITIONS, row.status as typeof ShiftStatus.OPEN, nextShiftStatus);

      try {
        await manager.update(ShiftAssignment, assignment.id, {
          status: ShiftAssignmentStatus.CONFIRMED,
          confirmedAt: new Date(),
          // Snapshotted at confirmation, not at send or staff-accept (§1
          // A6) — re-read from the shift row just locked by the UPDATE
          // above, in case the rate changed since the offer was sent.
          payRateSnapshotPence: Number(row.pay_rate_pence),
        });
      } catch (error) {
        if (isExclusionViolation(error)) {
          throw new ConflictException(
            'This staff member already has a confirmed shift that overlaps this one — this offer cannot be confirmed.',
          );
        }
        throw error;
      }

      const now = new Date();
      await manager.update(JobOffer, offer.id, {
        status: OfferStatus.MANAGER_CONFIRMED,
        managerConfirmedAt: now,
        confirmedBy: ctx.userId,
      });
      await manager.update(Shift, assignment.shiftId, { status: nextShiftStatus });

      return manager.findOneByOrFail(JobOffer, { id: offer.id });
    });
  }

  /** The manager's alternative to confirming: decline the staff member's acceptance. Never claims a seat, so no capacity bookkeeping to undo. */
  async managerReject(ctx: AuthContext, offerId: string, dto: RejectOfferDto): Promise<JobOffer> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const offer = await manager.findOne(JobOffer, { where: { id: offerId } });
      if (!offer) throw new NotFoundException('Offer not found.');
      assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.MANAGER_REJECTED);

      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.REJECTED);

      await manager.update(ShiftAssignment, assignment.id, { status: ShiftAssignmentStatus.REJECTED });

      const now = new Date();
      await manager.update(JobOffer, offer.id, {
        status: OfferStatus.MANAGER_REJECTED,
        managerRejectedAt: now,
        rejectedBy: ctx.userId,
        rejectionReason: dto.reason,
      });
      return manager.findOneByOrFail(JobOffer, { id: offer.id });
    });
  }
}
