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
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { SchedulingService } from '../../scheduling/services/scheduling.service';
import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '../../scheduling/utils/tstzrange';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { NotificationService } from '../../notification/services/notification.service';
import { VenueService } from '../../venue/services/venue.service';
import { CreateShiftAndSendDto } from '../dto/create-shift-and-send.dto';
import { DeclineOfferDto } from '../dto/decline-offer.dto';
import { RejectOfferDto } from '../dto/reject-offer.dto';
import { SendBulkOfferDto } from '../dto/send-bulk-offer.dto';
import { SendOfferDto } from '../dto/send-offer.dto';
import { JobOffer } from '../entities/job-offer.entity';

/** Postgres SQLSTATE for an exclusion-constraint violation (the GiST "no double-booking" constraint). */
const POSTGRES_EXCLUSION_VIOLATION = '23P01';

function isExclusionViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === POSTGRES_EXCLUSION_VIOLATION;
}

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
    offerBatchId: (r.offer_batch_id as string) ?? null,
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
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly notificationService: NotificationService,
    private readonly schedulingService: SchedulingService,
    private readonly resourceScope: ResourceScopeService,
    private readonly venueService: VenueService,
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
  list(ctx: AuthContext, pagination: PaginationDto = {}): Promise<OfferSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      const { skip, take } = paginationSkipTake(pagination);

      if (scope.kind === 'venue') {
        if (scope.venueIds.length === 0) return [];
        const rows = await manager.query(
          `${OFFER_SUMMARY_SELECT} WHERE s.venue_id = ANY($1::uuid[]) ORDER BY o.sent_at DESC LIMIT $2 OFFSET $3`,
          [scope.venueIds, take, skip],
        );
        return rows.map(toOfferSummary);
      }
      const rows = await manager.query(`${OFFER_SUMMARY_SELECT} WHERE o.created_by = $1 ORDER BY o.sent_at DESC LIMIT $2 OFFSET $3`, [
        ctx.userId,
        take,
        skip,
      ]);
      return rows.map(toOfferSummary);
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
    const shift = await manager.findOne(Shift, { where: { id: shiftId } });
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
  ): Promise<JobOffer> {
    const staffProfile = await manager.findOne(StaffProfile, { where: { id: staffProfileId } });
    if (!staffProfile) throw new NotFoundException('Staff member not found.');

    // Proactive read of the same invariant `shift_assignment_no_double_booking`
    // (the GiST exclusion constraint, WHERE status IN ('confirmed','completed'))
    // enforces at INSERT time on confirm — checked here too so a conflicting
    // staff member gets a clear per-recipient message at send time instead of
    // only ever discovering the conflict much later, at confirm time.
    const conflicting = await manager.query(
      `SELECT 1 FROM core.shift_assignment
         WHERE staff_profile_id = $1 AND status IN ('confirmed', 'completed')
           AND period && $2::tstzrange
         LIMIT 1`,
      [staffProfileId, toTstzRange(shift.startsAt, shift.endsAt)],
    );
    if (conflicting.length > 0) {
      throw new ConflictException('This staff member already has a confirmed shift that overlaps this time.');
    }

    const existing = await manager.findOne(ShiftAssignment, {
      where: { shiftId: shift.id, staffProfileId },
    });
    if (existing) throw new ConflictException('This staff member has already been offered this shift.');

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
      period: toTstzRange(shift.startsAt, shift.endsAt),
    });
    await manager.save(assignment);

    const { workedMinutes } = computeWorkedMinutes({
      clockInAt: shift.startsAt,
      clockOutAt: shift.endsAt,
      scheduledBreakMinutes: shift.breakMinutes,
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

      const results: BulkOfferResult['results'] = [];
      for (const staffProfileId of dto.staffProfileIds) {
        await manager.query('SAVEPOINT sp_bulk_send');
        try {
          const offer = await this.sendOne(manager, ctx, shift, shiftLabel, staffProfileId, dto.expiresInHours, batchId);
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
        requiredCount: dto.staffProfileIds.length,
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
      const nextStatus = successCount < dto.staffProfileIds.length ? { requiredCount: successCount } : {};
      await manager.update(Shift, shift.id, { status: ShiftStatus.OFFERED, ...nextStatus });

      return { batchId, shiftId: shift.id, results };
    });
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
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
      if (!staffProfile) throw new NotFoundException('Offer not found.');

      const offer = await manager.findOne(JobOffer, {
        where: { id: offerId, staffProfileId: staffProfile.id },
      });
      if (!offer) throw new NotFoundException('Offer not found.');

      if (offer.status === OfferStatus.PENDING && offer.expiresAt.getTime() < Date.now()) {
        await manager.update(JobOffer, offer.id, { status: OfferStatus.EXPIRED });
        const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
        await this.auditService.record(manager, ctx, AuditAction.OFFER_EXPIRED, {
          entityType: 'offer',
          entityId: offer.id,
          metadata: { offerBatchId: offer.offerBatchId },
        });
        if (assignment.assignedBy) {
          await this.notificationService.notify(manager, {
            organisationId: ctx.organisationId!,
            userId: assignment.assignedBy,
            type: 'offer_expired',
            title: 'Offer expired',
            message: 'A shift offer expired before the staff member responded.',
            relatedEntityType: 'offer',
            relatedEntityId: offer.id,
          });
        }
        throw new ConflictException('This offer has expired.');
      }
      assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.STAFF_ACCEPTED);

      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.STAFF_ACCEPTED);

      const now = new Date();
      // WHERE status = :priorStatus — a concurrent double-accept (double-tap,
      // retry) gets zero affected rows and a clean 409 instead of silently
      // re-recording the same acceptance twice (which would double-fire the
      // manager notification and audit entry).
      const [, acceptedCount] = (await manager.query(
        `UPDATE core.job_offer SET status = $1, responded_at = $2, staff_accepted_at = $2 WHERE id = $3 AND status = $4`,
        [OfferStatus.STAFF_ACCEPTED, now, offer.id, offer.status],
      )) as [unknown, number];
      if (acceptedCount === 0) {
        throw new ConflictException('This offer was already responded to — please refresh and try again.');
      }
      await manager.update(ShiftAssignment, assignment.id, { status: ShiftAssignmentStatus.STAFF_ACCEPTED });

      await this.auditService.record(manager, ctx, AuditAction.OFFER_ACCEPTED, {
        entityType: 'offer',
        entityId: offer.id,
        metadata: { offerBatchId: offer.offerBatchId },
      });
      if (assignment.assignedBy) {
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
    assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.MANAGER_CONFIRMED);

    const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
    assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.CONFIRMED);

    const now = new Date();
    const [, confirmedCount] = (await manager.query(
      `UPDATE core.job_offer SET status = $1, manager_confirmed_at = $2, confirmed_by = $3
         WHERE id = $4 AND status = $5`,
      [OfferStatus.MANAGER_CONFIRMED, now, ctx.userId, offer.id, offer.status],
    )) as [unknown, number];
    if (confirmedCount === 0) {
      throw new ConflictException('This offer was already confirmed or is no longer awaiting confirmation.');
    }

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
    // Only assert a transition when the status is actually changing —
    // SHIFT_TRANSITIONS has no PARTIALLY_FILLED→PARTIALLY_FILLED self-edge
    // (state machines don't define self-loops as "valid transitions"), but
    // confirming the 2nd of 3 required seats on an already-partially-filled
    // shift is a legitimate filled_count increment with no status change at
    // all, not an invalid transition.
    if (row.status !== nextShiftStatus) {
      assertTransition(SHIFT_TRANSITIONS, row.status as typeof ShiftStatus.OPEN, nextShiftStatus);
    }

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

    await manager.update(Shift, assignment.shiftId, { status: nextShiftStatus });

    const confirmed = await manager.findOneByOrFail(JobOffer, { id: offer.id });

    await this.auditService.record(manager, ctx, AuditAction.OFFER_CONFIRMED, {
      entityType: 'offer',
      entityId: offer.id,
      metadata: { offerBatchId: offer.offerBatchId },
    });
    const staffProfile = await manager.findOne(StaffProfile, { where: { id: offer.staffProfileId } });
    if (staffProfile) {
      await this.notificationService.notify(manager, {
        organisationId: ctx.organisationId!,
        userId: staffProfile.userId,
        type: 'offer_confirmed',
        title: 'Shift confirmed',
        message: 'Your shift offer has been confirmed.',
        relatedEntityType: 'offer',
        relatedEntityId: offer.id,
      });
    }

    return confirmed;
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
