import { ReplacementRequestStatus, ShiftStatus } from '@rab/shared';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { Shift } from '../../scheduling/entities/shift.entity';
import { ApproveReplacementRequestDto } from '../dto/approve-replacement-request.dto';
import { ReplacementRequest } from '../entities/replacement-request.entity';
import { OfferService } from './offer.service';

/**
 * PHASE 17/18 of the rab-worker migration: the manager-approval half of
 * replacement-staff automation lives here, in the API, as an authenticated,
 * synchronous action — never in the worker (`replacement-staff.job.ts` only
 * ever creates rows and notifies; see that file's own doc comment). This is
 * also the ONLY place that ever calls `OfferService.send()` for a
 * replacement — its existing offer-creation SQL/business rules are reused
 * verbatim, never duplicated.
 *
 * PHASE 5.5 — `ReplacementRequest`'s own RLS policy only enforces the OUTER
 * tenant boundary (organisation + workspace, or an EXISTS-based venue-
 * manager carve-out — see the policy's own definition); it does NOT, and
 * structurally cannot cheaply, distinguish Manager A from Manager B when
 * both share an organisation/workspace. Before this phase, every method
 * below trusted RLS alone — a same-org, same-workspace Manager B (holding
 * only the ordinary `SCHEDULE_VIEW`/`OFFER_SEND` permission every manager
 * has, no special grant) could list, view, approve, or reject Manager A's
 * replacement requests outright. Fixed the same way every other manager-
 * facing service in this codebase already gates its own resources
 * (`SchedulingService.assertShiftOwned`, `ShiftReportService.
 * assertShiftOwned`/`canReadShift` — this file's `assertShiftOwned` below
 * is the SAME 4-line shape, deliberately duplicated rather than shared
 * cross-service per this codebase's own existing precedent for this exact
 * check, not a new abstraction): a `ReplacementRequest`'s canonical owner is
 * derived by walking `shiftId -> Shift`, exactly the chain this phase's own
 * brief specifies (`declined assignment -> shift -> manager owner` — the
 * shift IS the canonical owner once resolved, `declinedShiftAssignmentId`
 * is never itself consulted for ownership, only for eligibility elsewhere).
 */
@Injectable()
export class ReplacementRequestService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly offerService: OfferService,
    private readonly resourceScope: ResourceScopeService,
    private readonly auditService: AuditService,
  ) {}

  /** Same shape as `SchedulingService.assertShiftOwned`/`ShiftReportService.assertShiftOwned` — a normal Manager only shifts they created, a Venue Manager only their assigned venues' shifts. 404, not 403, when out of scope. */
  private async assertShiftOwned(manager: EntityManager, ctx: AuthContext, shift: Shift): Promise<void> {
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (scope.kind === 'owner' && shift.createdBy === ctx.userId) return;
    if (scope.kind === 'venue' && scope.venueIds.includes(shift.venueId)) return;
    throw new NotFoundException('Replacement request not found.');
  }

  /** Loads the owning Shift and asserts ownership — the one chain every method below re-derives from, never trusting a request row's own columns as authorization. */
  private async assertRequestOwned(manager: EntityManager, ctx: AuthContext, request: ReplacementRequest): Promise<void> {
    const shift = await manager.findOne(Shift, { where: { id: request.shiftId } });
    if (!shift) throw new NotFoundException('Replacement request not found.');
    await this.assertShiftOwned(manager, ctx, shift);
  }

  async list(ctx: AuthContext): Promise<ReplacementRequest[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue' && scope.venueIds.length === 0) return [];

      const qb = manager
        .createQueryBuilder(ReplacementRequest, 'rr')
        .innerJoin(Shift, 's', 's.id = rr.shiftId')
        .orderBy('rr.createdAt', 'DESC')
        .take(100);
      // Same ownership predicate as every list() above — never widened,
      // never OR'd with a broader tenant-only condition.
      if (scope.kind === 'venue') {
        qb.where('s.venueId IN (:...venueIds)', { venueIds: scope.venueIds });
      } else {
        qb.where('s.createdBy = :createdBy', { createdBy: ctx.userId });
      }
      return qb.getMany();
    });
  }

  async get(ctx: AuthContext, id: string): Promise<ReplacementRequest> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const request = await manager.findOne(ReplacementRequest, { where: { id } });
      // 404, not 403 — RLS already made a cross-tenant row invisible; a
      // real row this manager's own scope can't see must look identical to
      // one that doesn't exist (CLAUDE.md's disclosure rule). Same rule now
      // extends to a same-org, same-workspace Manager B: `assertRequestOwned`
      // below throws the identical NotFoundException either way.
      if (!request) throw new NotFoundException('Replacement request not found.');
      await this.assertRequestOwned(manager, ctx, request);
      return request;
    });
  }

  /**
   * PHASE 4 — one single transaction, replacing the previous three-
   * transaction split (which was safe against a genuine crash mid-sequence,
   * per its own former doc comment, but NOT against two concurrent
   * `approve()` calls: both could pass the old plain `findOne`-then-check
   * before either committed, both call `OfferService.send()` for their own
   * candidate, and both would then unconditionally overwrite the request's
   * final columns — two offers sent, only the last writer remembered).
   *
   * The fix is an atomic claim as the FIRST statement:
   *   UPDATE ... SET status = 'approving' WHERE status IN (awaiting, no_candidates) RETURNING id
   * Exactly one concurrent caller's UPDATE can affect the row (Postgres
   * serialises concurrent UPDATEs to the same row); every other caller's
   * UPDATE affects zero rows and is treated as "already resolved," never a
   * blind retry. `OfferService.sendOneWithManager` is called INSIDE this
   * same transaction — no nested `runInTenantContext`, no second pooled
   * connection, no window between "offer created" and "request advanced."
   *
   * Two distinct failure shapes, handled deliberately differently:
   *  - RETRYABLE (the selected candidate specifically is no longer
   *    eligible, or isn't in the snapshot): thrown as an exception, which
   *    rolls back the WHOLE transaction — including the claim above — so
   *    the row reverts to exactly its pre-claim status. The manager can
   *    immediately retry with a different candidate from the same
   *    shortlist. This is "release the APPROVING claim," achieved for free
   *    by rollback, not a separate revert-write.
   *  - PERMANENT (the vacancy itself is gone — shift cancelled/completed/
   *    already fully staffed): written as a real `cancelled` terminal
   *    state and returned (not thrown) so the transaction COMMITS it, then
   *    the caller throws a 409 from OUTSIDE the transaction once it's
   *    durably persisted — a manager must never be invited to "just try a
   *    different candidate" for a vacancy that no longer exists.
   */
  async approve(ctx: AuthContext, id: string, dto: ApproveReplacementRequestDto): Promise<ReplacementRequest> {
    const outcome = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // PHASE 5.5 — ownership checked BEFORE the atomic claim below, never
      // after. An unauthorised same-org/workspace Manager B must never be
      // able to WIN the claim (even transiently, even if they'd fail a
      // later check) — that would flip status to APPROVING and make
      // Manager A's own concurrent, legitimate approval spuriously fail as
      // "already resolved." The ownership gate has to be the very first
      // thing that can observe/touch this row.
      const preCheck = await manager.findOne(ReplacementRequest, { where: { id } });
      if (!preCheck) throw new NotFoundException('Replacement request not found.');
      await this.assertRequestOwned(manager, ctx, preCheck);
      await manager.findOne(Shift, { where: { id: preCheck.shiftId }, lock: { mode: 'pessimistic_write' } });

      // TypeORM's manager.query() returns [rows, rowCount] for UPDATE/DELETE
      // statements (unlike SELECT/INSERT, which return the rows array
      // directly) — see offer.service.ts's own confirmAssignment for the
      // established pattern. Destructuring `[claimedRows]` and checking
      // `claimedRows.length`, never the outer tuple's `.length` (which is
      // always 2 regardless of how many rows actually matched), is the only
      // correct way to read this — the earlier `claim.length === 0` form was
      // dead code that let every concurrent caller believe it had won the
      // claim.
      const [claimedRows] = (await manager.query(
        `UPDATE core.replacement_request
           SET status = $2, updated_at = now()
           WHERE id = $1 AND status IN ($3, $4)
           RETURNING id`,
        [id, ReplacementRequestStatus.APPROVING, ReplacementRequestStatus.AWAITING_APPROVAL, ReplacementRequestStatus.NO_CANDIDATES],
      )) as [Array<{ id: string }>, number];
      if (claimedRows.length === 0) {
        const existing = await manager.findOne(ReplacementRequest, { where: { id } });
        if (!existing) throw new NotFoundException('Replacement request not found.');
        throw new ConflictException(`This replacement request has already been resolved (${existing.status}).`);
      }

      const request = await manager.findOneByOrFail(ReplacementRequest, { id });

      // The shortlist is a point-in-time SNAPSHOT — the manager may only
      // approve a candidate the worker actually shortlisted (never an
      // arbitrary id smuggled into the request body). Not in the snapshot
      // is treated as retryable (throw -> rollback -> claim released):
      // this is a malformed/stale request from the caller, not evidence
      // the vacancy itself is gone.
      const inSnapshot = request.candidatesSnapshot.some((c) => c.staffProfileId === dto.staffProfileId);
      if (!inSnapshot) {
        throw new ConflictException("That candidate is not part of this request's shortlist.");
      }

      // Row lock — serialises this transaction against a concurrent
      // cancellation (SchedulingService.cancel() / shift-cancellation-
      // followup.job.ts) reaching the SAME shift row: whichever commits
      // first, the other sees the fresh, post-commit state, never a stale
      // read. Lock order here is always replacement_request (the UPDATE
      // above) then shift — never the reverse anywhere else in this flow.
      const shift = await manager.findOne(Shift, { where: { id: request.shiftId }, lock: { mode: 'pessimistic_write' } });
      const vacancyGone = !shift || shift.status === ShiftStatus.CANCELLED || shift.status === ShiftStatus.COMPLETED || shift.filledCount >= shift.requiredCount;
      if (vacancyGone) {
        await manager.update(ReplacementRequest, id, { status: ReplacementRequestStatus.CANCELLED, updatedAt: new Date() });
        await this.auditService.record(manager, ctx, AuditAction.REPLACEMENT_REQUEST_CANCELLED_AT_APPROVAL, {
          entityType: 'replacement_request',
          entityId: id,
          metadata: {
            reason: !shift ? 'shift_missing' : shift.status === ShiftStatus.CANCELLED ? 'shift_cancelled' : shift.status === ShiftStatus.COMPLETED ? 'shift_completed' : 'fully_staffed',
          },
        });
        const cancelledRequest = await manager.findOneByOrFail(ReplacementRequest, { id });
        return { ok: false as const, request: cancelledRequest };
      }

      // Retryable: if the CANDIDATE specifically is no longer eligible (took
      // another shift, was deactivated, suspended, etc.), `sendOneWithManager`
      // below throws before creating anything (DOM-01's canonical
      // `assertStaffEligibleForOffer`, via `sendOne`) — the vacancy itself
      // still exists, so that throw rolls back the whole transaction
      // (releasing the claim above) and lets the manager pick someone else
      // from the same shortlist immediately. No separate pre-check needed
      // here now that `sendOne` is the one place this is ever decided.
      //
      // Reuses OfferService's canonical offer-creation path verbatim, in
      // THIS transaction — no duplicated business logic, no second
      // connection.
      const offer = await this.offerService.sendOneWithManager(manager, ctx, shift, dto.staffProfileId);

      await manager.update(ReplacementRequest, id, {
        status: ReplacementRequestStatus.OFFER_SENT,
        selectedStaffProfileId: dto.staffProfileId,
        resultingOfferId: offer.id,
        approvedBy: ctx.userId,
        approvedAt: new Date(),
      });
      await this.auditService.record(manager, ctx, AuditAction.REPLACEMENT_REQUEST_APPROVED, {
        entityType: 'replacement_request',
        entityId: id,
        metadata: { staffProfileId: dto.staffProfileId, offerId: offer.id },
      });
      const finalRequest = await manager.findOneByOrFail(ReplacementRequest, { id });
      return { ok: true as const, request: finalRequest };
    });

    if (!outcome.ok) {
      // The cancelled state above already committed — this throw only
      // shapes THIS caller's HTTP response, it changes nothing in the DB.
      throw new ConflictException('This shift no longer needs a replacement — it has been cancelled, completed, or is already fully staffed.');
    }
    return outcome.request;
  }

  /**
   * PHASE 4 — same atomic-CAS shape as `approve()`, closing the identical
   * race between two concurrent rejects, or a reject racing an approve:
   * whichever transaction's UPDATE lands first wins the row; the other's
   * UPDATE affects zero rows and is reported as "already resolved," never
   * silently double-applied (which would otherwise fire the audit action
   * twice, or overwrite an `OFFER_SENT` row back to `REJECTED` after an
   * offer had already gone out).
   */
  async reject(ctx: AuthContext, id: string): Promise<ReplacementRequest> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // PHASE 5.5 — same reasoning as approve()'s own pre-claim ownership
      // check: must happen before the atomic claim, never after.
      const preCheck = await manager.findOne(ReplacementRequest, { where: { id } });
      if (!preCheck) throw new NotFoundException('Replacement request not found.');
      await this.assertRequestOwned(manager, ctx, preCheck);

      // See approve()'s own doc comment: manager.query() returns
      // [rows, rowCount] for UPDATE, not the rows array directly.
      const [claimedRows] = (await manager.query(
        `UPDATE core.replacement_request
           SET status = $2, rejected_by = $3, rejected_at = now(), updated_at = now()
           WHERE id = $1 AND status IN ($4, $5)
           RETURNING id`,
        [id, ReplacementRequestStatus.REJECTED, ctx.userId, ReplacementRequestStatus.AWAITING_APPROVAL, ReplacementRequestStatus.NO_CANDIDATES],
      )) as [Array<{ id: string }>, number];
      if (claimedRows.length === 0) {
        const existing = await manager.findOne(ReplacementRequest, { where: { id } });
        if (!existing) throw new NotFoundException('Replacement request not found.');
        throw new ConflictException(`This replacement request has already been resolved (${existing.status}).`);
      }

      await this.auditService.record(manager, ctx, AuditAction.REPLACEMENT_REQUEST_REJECTED, {
        entityType: 'replacement_request',
        entityId: id,
        metadata: {},
      });

      return manager.findOneByOrFail(ReplacementRequest, { id });
    });
  }

  /**
   * Manual selection uses the same eligibility/send path and resolves an
   * existing vacancy proposal when present. Parent shift is locked by
   * caller. DOM-01 — no separate eligibility pre-check here: `sendOneWithManager`
   * (via `sendOne`) runs the one canonical `assertStaffEligibleForOffer`
   * check and throws before creating anything if the candidate isn't
   * eligible, exactly as `approve()` above relies on it.
   */
  async sendSelectedWithManager(manager: EntityManager, ctx: AuthContext, shift: Shift, staffProfileId: string) {
    const request = await manager.createQueryBuilder(ReplacementRequest, 'r').where('r.shiftId = :id', { id: shift.id })
      .andWhere('r.status IN (:...states)', { states: [ReplacementRequestStatus.AWAITING_APPROVAL, ReplacementRequestStatus.NO_CANDIDATES] }).orderBy('r.createdAt', 'ASC').setLock('pessimistic_write').getOne();
    const offer = await this.offerService.sendOneWithManager(manager, ctx, shift, staffProfileId);
    if (request) {
      await manager.update(ReplacementRequest, request.id, { status: ReplacementRequestStatus.OFFER_SENT, selectedStaffProfileId: staffProfileId, resultingOfferId: offer.id, approvedBy: ctx.userId, approvedAt: new Date() });
      await this.auditService.record(manager, ctx, AuditAction.REPLACEMENT_REQUEST_APPROVED, { entityType: 'replacement_request', entityId: request.id, metadata: { staffProfileId, offerId: offer.id, source: 'pipeline_selection' } });
    }
    return offer;
  }
}
