import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { PermissionFlag } from '@rab/shared';
import { ForbiddenException } from '@nestjs/common';
import { assertVenueTeamSelection } from '../../staff/services/venue-team-scope';
import { assertTransition, ManagerType, NotificationType, SHIFT_TRANSITIONS, ShiftStatus, UserStatus } from '@rab/shared';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { toIlikePattern } from '../../../engine/utils/ilike-pattern.util';
import { User } from '../../identity/entities';
import { ManagerProfile } from '../../manager/entities/manager-profile.entity';
import { NotificationService } from '../../notification/services/notification.service';
import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { Venue } from '../../venue/entities/venue.entity';
import { CreateJobRoleDto } from '../dto/create-job-role.dto';
import { CreateShiftDto } from '../dto/create-shift.dto';
import { DeclineShiftRequestDto } from '../dto/decline-shift-request.dto';
import { ListShiftsDto } from '../dto/list-shifts.dto';
import { ListVenueOffersDto } from '../dto/list-venue-offers.dto';
import { SubmitShiftRequestDto } from '../dto/submit-shift-request.dto';
import { JobRole } from '../entities/job-role.entity';
import { Shift } from '../entities/shift.entity';
import { ShiftRequestStaff } from '../entities/shift-request-staff.entity';
import { VenueRoleRate } from '../entities/venue-role-rate.entity';
import { VenueService } from '../../venue/services/venue.service';
import { AvailabilityService } from './availability.service';

/** Same allowlist-via-lookup-map pattern as `StaffService`'s `STAFF_SORT_COLUMNS` — see that file's comment. Shift has no ORM relations to venue/job_role (plain FK columns, joined manually below), so these reference the join aliases, not `shift.` properties. */
const SHIFT_SORT_COLUMNS: Record<string, string> = {
  startsAt: 'shift.startsAt',
  venue: 'v.name',
  jobRole: 'jr.name',
  status: 'shift.status',
  createdAt: 'shift.createdAt',
};

@Injectable()
export class SchedulingService {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
    private readonly venueService: VenueService,
    private readonly auditService: AuditService,
    private readonly notificationService: NotificationService,
    private readonly availabilityService: AvailabilityService,
  ) {}

  /** Every Internal Manager/CEO in the org — the eligible approver set for a shift request (`STAFFING_REQUEST_APPROVE`, held by both roles; see `ManagerService.ROLE_DEFS`). Queried by manager type directly rather than a generic permission lookup — no such generic utility exists elsewhere, and these are the only two roles that hold it today. */
  private async listApprovers(manager: EntityManager, organisationId: string): Promise<string[]> {
    const rows = await manager
      .createQueryBuilder(ManagerProfile, 'mp')
      .where('mp.organisationId = :organisationId', { organisationId })
      .andWhere('mp.type IN (:...types)', { types: [ManagerType.INTERNAL, ManagerType.CEO] })
      .select('mp.userId', 'userId')
      .getRawMany<{ userId: string }>();
    return rows.map((r) => r.userId);
  }

  /**
   * A normal manager's private scope is "shifts I created"; a Venue
   * Manager's is "shifts at venues I'm assigned to" (they never create
   * shifts themselves — `SCHEDULE_CREATE` isn't in their permission set —
   * so a plain creator check always came back empty for them, a real bug
   * this fixes). Stage 2A Phase 2 retired the platform-admin org-wide
   * bypass this used to have — cross-Manager visibility is available only
   * through the audited Admin Inspect mechanism, which rebinds
   * `ctx.userId` to the inspected target so this same check naturally
   * resolves against the target's own scope. Unlike StaffProfile/JobOffer,
   * `shift.created_by` has been NOT NULL since the table's original
   * migration, so there is no legacy-ambiguous-owner case to handle here —
   * every shift has always had a real creator.
   */
  private async assertShiftOwned(manager: EntityManager, ctx: AuthContext, shift: Shift): Promise<void> {
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (scope.kind === 'owner' && shift.createdBy === ctx.userId) return;
    if (scope.kind === 'venue' && scope.venueIds.includes(shift.venueId)) return;
    throw new NotFoundException('Shift not found.');
  }

  /**
   * Read-only widening of `assertShiftOwned`, for `get()` only — an
   * org-wide Internal Manager needs to open a `pending_manager_approval`
   * request's detail (the Shift Approval drawer) before they "own" it via
   * `createdBy`, same reasoning as `list()`'s OR-widened WHERE above and
   * `listPendingApprovals`'s org-wide scope. Deliberately NOT used by
   * `publish()`/`cancel()`: those stay on the strict `assertShiftOwned`
   * check so `PENDING_MANAGER_APPROVAL → OPEN` can only happen through the
   * dedicated `approveShiftRequest` action (which does the offer-sending
   * and audit trail), never as a side effect of a generic publish call
   * that only holds `SCHEDULE_PUBLISH`, not `STAFFING_REQUEST_APPROVE`.
   */
  private async assertShiftViewable(manager: EntityManager, ctx: AuthContext, shift: Shift): Promise<void> {
    if (shift.status === ShiftStatus.PENDING_MANAGER_APPROVAL) {
      // `scope.kind === 'owner'` only describes the CALLER's own shape (an
      // Internal Manager who owns a ManagerWorkspace) — it says nothing
      // about which organisation the shift belongs to, so it must never be
      // the only check here. RLS already scopes `manager.findOne` above to
      // the caller's own org in the real `rab_app` runtime role, but per
      // this repo's five-layers rule (CLAUDE.md §"Five enforcement
      // layers") a control that exists at only one layer — relying purely
      // on RLS with no service-level check — is not implemented. This
      // explicit match is layer 2, defense-in-depth alongside RLS, not a
      // replacement for it.
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'owner' && shift.organisationId === ctx.organisationId) return;
    }
    await this.assertShiftOwned(manager, ctx, shift);
  }

  /**
   * `JobRole` has no venue-assignment concept of its own (it's a name +
   * default rate, not tied to one venue), so unlike Shift/Venue a Venue
   * Manager (`scope.kind === 'venue'`) can't be scoped to "job roles at my
   * assigned venues" without a much heavier join through `VenueRoleRate`/
   * `Shift`. Rather than leave them unable to see role names on shifts they
   * can otherwise view (a real regression — the web console resolves job
   * role names via a separate `GET /job-roles` call), Venue Managers see
   * every org job role — role names/default rates are org reference data,
   * not privacy-sensitive the way Staff/Shift/Offer/Venue are.
   */
  private async assertJobRoleOwned(manager: EntityManager, ctx: AuthContext, jobRole: JobRole): Promise<void> {
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (scope.kind === 'venue') return;
    if (scope.kind === 'owner' && jobRole.createdBy === ctx.userId) return;
    throw new NotFoundException('Job role not found.');
  }

  listJobRoles(ctx: AuthContext): Promise<JobRole[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue') {
        return manager.find(JobRole, { order: { name: 'ASC' } });
      }
      return manager.find(JobRole, { where: { createdBy: ctx.userId }, order: { name: 'ASC' } });
    });
  }

  createJobRole(ctx: AuthContext, dto: CreateJobRoleDto): Promise<JobRole> {
    this.resourceScope.assertHasWorkspace(ctx);
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const role = manager.create(JobRole, {
        organisationId: ctx.organisationId!,
        name: dto.name,
        defaultRatePence: dto.defaultRatePence ?? 0,
        createdBy: ctx.userId,
        workspaceId: ctx.workspaceId ?? undefined,
      });
      return manager.save(role);
    });
  }

  list(ctx: AuthContext, dto: ListShiftsDto = {}): Promise<{ data: Shift[]; total: number }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue' && scope.venueIds.length === 0) return { data: [], total: 0 };

      const qb = manager
        .createQueryBuilder(Shift, 'shift')
        .leftJoin(Venue, 'v', 'v.id = shift.venueId')
        .leftJoin(JobRole, 'jr', 'jr.id = shift.jobRoleId')
        // TypeORM wraps any paginated (`skip`/`take`) query with joins in an
        // outer DISTINCT selector to paginate root entities correctly rather
        // than join-multiplied rows — that wrapper can only reference
        // columns this query explicitly selects, so ordering by `v.name`/
        // `jr.name` (never otherwise selected, only joined for filtering)
        // fails with "column distinctAlias.v_name does not exist" without
        // these two. Confirmed live before adding them.
        .addSelect('v.name', 'v_name')
        .addSelect('jr.name', 'jr_name');

      // Existing ownership/venue-assignment scoping — every filter below is
      // ANDed onto this, never OR'd or replacing it (a caller can only ever
      // narrow within their own already-authorized scope, never escape it).
      if (scope.kind === 'venue') {
        qb.where('shift.venueId IN (:...venueIds)', { venueIds: scope.venueIds });
      } else {
        // A `pending_manager_approval` request is deliberately unowned in
        // the `createdBy` sense until an Internal Manager approves it (see
        // `SubmitShiftRequestDto`'s own doc comment — `createdBy` is
        // stamped as the *submitting Venue Manager*, not any Internal
        // Manager) — a plain `createdBy = ctx.userId` here would make every
        // pending request invisible to every possible approver, since none
        // of them "own" it yet. Widened to org-wide visibility for this one
        // status only, the same scope `listPendingApprovals` already grants
        // — everything else stays strictly creator-owned.
        qb.where(
          '(shift.createdBy = :createdBy OR shift.status = :pendingApproval)',
          { createdBy: ctx.userId, pendingApproval: ShiftStatus.PENDING_MANAGER_APPROVAL },
        );
      }

      if (dto.from && dto.to) {
        qb.andWhere('shift.startsAt BETWEEN :from AND :to', { from: new Date(dto.from), to: new Date(dto.to) });
      }
      if (dto.q) {
        qb.andWhere('(v.name ILIKE :q OR jr.name ILIKE :q)', { q: toIlikePattern(dto.q) });
      }
      if (dto.status) qb.andWhere('shift.status = :status', { status: dto.status });
      if (dto.venueId) qb.andWhere('shift.venueId = :venueId', { venueId: dto.venueId });
      if (dto.jobRoleId) qb.andWhere('shift.jobRoleId = :jobRoleId', { jobRoleId: dto.jobRoleId });

      // `getManyAndCount()` wraps the query in an outer DISTINCT-count
      // subquery whenever joins are present, which fails when ordering by a
      // plain `leftJoin` alias's column (never `addSelect`ed, so it isn't in
      // that subquery's own select list) — confirmed live: "column
      // distinctAlias.v_name does not exist". Counting and fetching
      // separately sidesteps that TypeORM edge case entirely, and is the
      // correct choice anyway: each shift joins to at most one venue and one
      // job role (both many-to-one), so there's no row-multiplication for a
      // DISTINCT count to guard against here in the first place.
      const total = await qb.getCount();

      const sortColumn = SHIFT_SORT_COLUMNS[dto.sort ?? 'startsAt'] ?? SHIFT_SORT_COLUMNS.startsAt;
      qb.orderBy(sortColumn, (dto.direction ?? 'asc').toUpperCase() as 'ASC' | 'DESC');

      const { skip, take } = paginationSkipTake(dto);
      qb.skip(skip).take(take);

      const data = await qb.getMany();
      return { data, total };
    });
  }

  async get(ctx: AuthContext, id: string): Promise<Shift> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftViewable(manager, ctx, shift);
      return shift;
    });
  }

  /**
   * Rate resolution, `assignment → staff role rate → venue role rate → org
   * default` (rab-workforce-architecture.md §1 A6) — staff-specific
   * overrides don't exist yet (no per-staff rate table built), so this
   * resolves venue role rate → job role default. An explicit `payRatePence`
   * always wins over both. Public (not private) and takes an already-open,
   * transaction-participating `manager` — `OfferService.createShiftAndSend`
   * reuses this rather than duplicating the lookup for its own shift-creation
   * path.
   */
  async resolvePayRate(
    manager: EntityManager,
    params: { venueId: string; jobRoleId: string; startsAt: string; payRatePence?: number },
  ): Promise<number> {
    if (params.payRatePence !== undefined) return params.payRatePence;

    const rate = await manager
      .createQueryBuilder(VenueRoleRate, 'r')
      .where('r.venue_id = :venueId', { venueId: params.venueId })
      .andWhere('r.job_role_id = :jobRoleId', { jobRoleId: params.jobRoleId })
      .andWhere('r.effective_from <= :start', { start: params.startsAt })
      .andWhere('(r.effective_to IS NULL OR r.effective_to >= :start)', { start: params.startsAt })
      .orderBy('r.effective_from', 'DESC')
      .getOne();
    if (rate) return rate.payRatePence;

    const jobRole = await manager.findOne(JobRole, { where: { id: params.jobRoleId } });
    return jobRole?.defaultRatePence ?? 0;
  }

  async create(ctx: AuthContext, dto: CreateShiftDto): Promise<Shift> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // Closes an IDOR that Venue/JobRole ownership scoping would otherwise
      // open: without this, a Manager could still create a shift against
      // another Manager's private venue/job-role by reusing a known id, even
      // though they can no longer see it in a list.
      const venue = await this.venueService.assertVenueAccessibleTx(manager, ctx, dto.venueId);
      const jobRole = await manager.findOne(JobRole, { where: { id: dto.jobRoleId } });
      if (!jobRole) throw new NotFoundException('Job role not found.');
      await this.assertJobRoleOwned(manager, ctx, jobRole);

      const payRatePence = await this.resolvePayRate(manager, dto);

      const shift = manager.create(Shift, {
        organisationId: ctx.organisationId!,
        // Inherited from the Venue, not ctx.workspaceId directly — keeps
        // Shift.workspaceId = Venue.workspaceId true by construction (the
        // cross-boundary integrity invariant), covering the Venue-Manager
        // case where the caller's own ctx.workspaceId can differ from the
        // Venue's owning workspace.
        workspaceId: venue.workspaceId,
        venueId: dto.venueId,
        jobRoleId: dto.jobRoleId,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        breakMinutes: dto.breakMinutes ?? 0,
        requiredCount: dto.requiredCount,
        payRatePence,
        chargeRatePence: dto.chargeRatePence ?? 0,
        notes: dto.notes,
        status: ShiftStatus.DRAFT,
        createdBy: ctx.userId,
      });
      return manager.save(shift);
    });
  }

  async publish(ctx: AuthContext, id: string): Promise<Shift> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftOwned(manager, ctx, shift);
      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.OPEN);
      await manager.update(Shift, id, { status: ShiftStatus.OPEN, publishedAt: new Date() });
      return manager.findOneByOrFail(Shift, { id });
    });
  }

  async cancel(ctx: AuthContext, id: string, reason?: string): Promise<Shift> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftOwned(manager, ctx, shift);
      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.CANCELLED);
      await manager.update(Shift, id, { status: ShiftStatus.CANCELLED, cancelledReason: reason });
      return manager.findOneByOrFail(Shift, { id });
    });
  }

  /**
   * A Venue Manager's shift request — `PermissionGuard(STAFFING_REQUEST_CREATE)`
   * on the route is the first gate, but the real tenant boundary is here:
   * `assertVenueAccessibleTx` re-validates `dto.venueId` against the
   * caller's own assigned-venue scope (`ManagerVenue`) exactly the way
   * `create()` above already does for a directly-created shift — a Venue
   * Manager cannot request a shift at a venue they aren't assigned to just
   * by knowing its id.
   *
   * `createdBy` is stamped as the *submitting* Venue Manager for now (the
   * column is NOT NULL and someone has to own the row until approval), but
   * it is reassigned to the approving Internal Manager at approval time
   * (see `OfferService.approveShiftRequest`) — from that point on this
   * behaves exactly like any other Internal-Manager-owned shift for every
   * existing `assertShiftOwned`-gated action. `requestedBy` stays permanent
   * regardless, as the one honest "who originally asked for this" field.
   */
  /**
   * Same eligibility rule as `StaffService.venueStaffPool`'s ("All Users")
   * own doc comment — real StaffProfile, ACTIVE account, within the target
   * venue's own workspace — re-checked here because a client-supplied id
   * list is never trusted as authorization on its own. Every id must
   * resolve; this is the Venue Manager's own explicit selection (not a
   * best-effort bulk send), so an ineligible id is a 400, not a silent drop.
   */
  private async assertStaffSelectable(
    manager: EntityManager,
    ctx: AuthContext,
    staffProfileIds: string[],
    venueWorkspaceId: string | undefined,
  ): Promise<void> {
    if (!venueWorkspaceId) {
      throw new BadRequestException('This venue has no assigned workspace yet — staff cannot be selected.');
    }
    const rows = await manager
      .createQueryBuilder(StaffProfile, 'sp')
      .innerJoin(User, 'u', 'u.id = sp.userId')
      .where('sp.id IN (:...ids)', { ids: staffProfileIds })
      .andWhere('sp.organisationId = :organisationId', { organisationId: ctx.organisationId })
      .andWhere('sp.workspaceId = :workspaceId', { workspaceId: venueWorkspaceId })
      .andWhere('u.status = :active', { active: UserStatus.ACTIVE })
      .select('sp.id', 'id')
      .getRawMany<{ id: string }>();
    const found = new Set(rows.map((r) => r.id));
    if (staffProfileIds.some((id) => !found.has(id))) {
      throw new BadRequestException('One or more selected staff are not available to select.');
    }
  }

  /**
   * Server-side revalidation of availability at the moment of commitment —
   * never trusts whatever an "available" flag the client last fetched said,
   * since another manager could have confirmed the same staff member
   * elsewhere in the meantime (§9/§10 of the availability spec this backs).
   * Same `AvailabilityService.findBusyStaffIds` the directory/pool list
   * endpoints use to render the badge in the first place — one
   * authoritative definition of "busy," checked again here rather than
   * re-trusted from an earlier read.
   */
  private async assertStaffAvailable(
    manager: EntityManager,
    staffProfileIds: string[],
    startsAt: Date,
    endsAt: Date,
    excludeShiftId?: string,
  ): Promise<void> {
    const busy = await this.availabilityService.findBusyStaffIds(manager, staffProfileIds, startsAt, endsAt, excludeShiftId);
    if (busy.size === 0) return;
    const names = await manager
      .createQueryBuilder(StaffProfile, 'sp')
      .innerJoin(User, 'u', 'u.id = sp.userId')
      .where('sp.id IN (:...ids)', { ids: Array.from(busy) })
      .select('u.firstName', 'firstName')
      .addSelect('u.lastName', 'lastName')
      .getRawMany<{ firstName: string; lastName: string }>();
    const label = names.map((n) => `${n.firstName} ${n.lastName}`).join(', ') || 'One or more selected staff';
    throw new ConflictException(`${label} ${names.length === 1 ? 'is' : 'are'} no longer available for this time — they may already be confirmed on another shift.`);
  }

  async submitRequest(ctx: AuthContext, dto: SubmitShiftRequestDto): Promise<Shift> {
    if (!await this.permissions.userHasPermission(ctx, PermissionFlag.STAFFING_REQUEST_CREATE)) throw new ForbiddenException('You cannot submit shift requests.');
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const venue = await this.venueService.assertVenueAccessibleTx(manager, ctx, dto.venueId);
      const jobRole = await manager.findOne(JobRole, { where: { id: dto.jobRoleId } });
      if (!jobRole) throw new NotFoundException('Job role not found.');
      await this.assertJobRoleOwned(manager, ctx, jobRole);
      await assertVenueTeamSelection(manager, ctx, dto.staffProfileIds, venue.workspaceId);
      await this.assertStaffSelectable(manager, ctx, dto.staffProfileIds, venue.workspaceId);
      await this.assertStaffAvailable(manager, dto.staffProfileIds, new Date(dto.startsAt), new Date(dto.endsAt));

      const payRatePence = await this.resolvePayRate(manager, {
        venueId: dto.venueId,
        jobRoleId: dto.jobRoleId,
        startsAt: dto.startsAt,
        payRatePence: dto.payRatePence,
      });

      const shift = manager.create(Shift, {
        organisationId: ctx.organisationId!,
        workspaceId: venue.workspaceId,
        venueId: dto.venueId,
        jobRoleId: dto.jobRoleId,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        // Priority: explicit submitter override -> this Venue's configured
        // default -> a 30-minute fallback only when the Venue has none
        // configured at all (never silently 0, which would understate a
        // real unpaid-break deduction the submitter never chose).
        breakMinutes: dto.breakMinutes ?? venue.defaultBreakMinutes ?? 30,
        requiredCount: dto.staffRequired,
        payRatePence,
        notes: dto.note,
        status: ShiftStatus.PENDING_MANAGER_APPROVAL,
        createdBy: ctx.userId,
        requestedBy: ctx.userId,
      });
      const saved = await manager.save(shift);

      await manager.insert(
        ShiftRequestStaff,
        dto.staffProfileIds.map((staffProfileId) => ({
          organisationId: ctx.organisationId!,
          workspaceId: venue.workspaceId,
          shiftId: saved.id,
          staffProfileId,
        })),
      );

      await this.auditService.record(manager, ctx, AuditAction.SHIFT_REQUEST_SUBMITTED, {
        entityType: 'shift',
        entityId: saved.id,
        metadata: { venueId: dto.venueId, jobRoleId: dto.jobRoleId, staffRequired: dto.staffRequired, staffProfileIds: dto.staffProfileIds },
      });

      const approvers = await this.listApprovers(manager, ctx.organisationId!);
      for (const userId of approvers) {
        await this.notificationService.notify(manager, {
          organisationId: ctx.organisationId!,
          userId,
          type: NotificationType.SHIFT_REQUEST_SUBMITTED,
          title: 'New shift request awaiting approval',
          message: `${venue.name} · ${jobRole.name} — ${dto.staffRequired} staff needed.`,
          relatedEntityType: 'shift',
          relatedEntityId: saved.id,
        });
      }

      return saved;
    });
  }

  /**
   * The Venue Manager's staff selection for a request — read by the Shift
   * Approval drawer so the Internal Manager reviews the SAME list rather
   * than picking fresh (see mega-prompt's "Internal Manager reviews
   * details/staff → Approve or Decline"). `stillActive` lets the UI flag
   * anyone who's gone inactive since the request was submitted, before the
   * manager even clicks Approve — `OfferService.approveShiftRequest` re-runs
   * this exact same check server-side regardless of what the UI shows.
   */
  async getRequestedStaff(ctx: AuthContext, shiftId: string): Promise<{ staffProfileId: string; firstName: string; lastName: string; email: string; stillActive: boolean }[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id: shiftId } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftViewable(manager, ctx, shift);
      return manager
        .createQueryBuilder(ShiftRequestStaff, 'rs')
        .innerJoin(StaffProfile, 'sp', 'sp.id = rs.staffProfileId')
        .innerJoin(User, 'u', 'u.id = sp.userId')
        .where('rs.shiftId = :shiftId', { shiftId })
        .orderBy('u.firstName', 'ASC')
        .select('sp.id', 'staffProfileId')
        .addSelect('u.firstName', 'firstName')
        .addSelect('u.lastName', 'lastName')
        .addSelect('u.email', 'email')
        .addSelect('(u.status = :activeStatus)', 'stillActive')
        .setParameter('activeStatus', UserStatus.ACTIVE)
        .getRawMany();
    });
  }

  /**
   * Removes one Staff member from a still-pending request's recipient list
   * (`shift_request_staff` is insert/delete-only by design — see its own
   * migration comment — so this is a plain DELETE, never an UPDATE). Only
   * legal while the request is still `PENDING_MANAGER_APPROVAL`: once
   * approved, the real offers already exist and this is no longer "editing
   * an unsent list," it's a live assignment — `OfferService.withdraw`/
   * `decline` are the correct actions post-approval, not this one. The
   * removed Staff member never received an offer, so nothing is sent to
   * them — only the Venue Manager who submitted the request is told,
   * since their selection just changed underneath them.
   */
  async removeRequestedStaff(ctx: AuthContext, shiftId: string, staffProfileId: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id: shiftId } });
      // Explicit org check alongside RLS — see `assertShiftViewable`'s own
      // comment on why a single enforcement layer isn't enough here.
      if (!shift || shift.organisationId !== ctx.organisationId) throw new NotFoundException('Shift not found.');
      if (shift.status !== ShiftStatus.PENDING_MANAGER_APPROVAL) {
        throw new ConflictException('This request has already been actioned and can no longer be edited.');
      }

      const result = await manager.delete(ShiftRequestStaff, { shiftId, staffProfileId });
      if (!result.affected) throw new NotFoundException('This staff member is not on the request.');

      const [staffUser, remainingCount] = await Promise.all([
        manager
          .createQueryBuilder(StaffProfile, 'sp')
          .innerJoin(User, 'u', 'u.id = sp.userId')
          .where('sp.id = :staffProfileId', { staffProfileId })
          .select('u.firstName', 'firstName')
          .addSelect('u.lastName', 'lastName')
          .getRawOne<{ firstName: string; lastName: string }>(),
        manager.count(ShiftRequestStaff, { where: { shiftId } }),
      ]);
      const staffName = staffUser ? `${staffUser.firstName} ${staffUser.lastName}` : 'A staff member';

      await this.auditService.record(manager, ctx, AuditAction.SHIFT_REQUEST_STAFF_REMOVED, {
        entityType: 'shift',
        entityId: shiftId,
        metadata: { staffProfileId, remainingCount },
      });

      if (shift.requestedBy) {
        const [venue, jobRole] = await Promise.all([
          manager.findOne(Venue, { where: { id: shift.venueId } }),
          manager.findOne(JobRole, { where: { id: shift.jobRoleId } }),
        ]);
        const when = shift.startsAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        await this.notificationService.notify(manager, {
          organisationId: ctx.organisationId!,
          userId: shift.requestedBy,
          type: NotificationType.SHIFT_REQUEST_STAFF_REMOVED,
          title: 'Staff removed from your shift request',
          message: `${staffName} was removed from your request for ${venue?.name ?? 'the venue'}, ${jobRole?.name ?? 'the role'}, ${when} — ${remainingCount} of ${shift.requiredCount} required staff now selected.`,
          relatedEntityType: 'shift',
          relatedEntityId: shiftId,
          // This is the ONLY signal the Venue Manager gets that their
          // submitted selection changed before approval — never gated
          // behind an opt-in email preference the way routine notifications
          // are (see NotifyParams.forceEmail's own doc comment).
          forceEmail: true,
        });
      }
    });
  }

  /**
   * Adds one Staff member to a still-pending request — the Internal
   * Manager's own replacement/addition, reusing the exact same eligibility
   * rule `submitRequest` enforces for the Venue Manager's original
   * selection (`assertStaffSelectable`: real StaffProfile, ACTIVE account,
   * within the shift's own workspace). Deliberately NOT gated by
   * `assertVenueTeamSelection` — that check only ever applies to the
   * `venue_manager` role (a no-op for anyone else, see that function's own
   * doc comment), and an Internal Manager reviewing a request isn't
   * confined to any one Venue Manager's saved team.
   */
  async addRequestedStaff(ctx: AuthContext, shiftId: string, staffProfileId: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id: shiftId } });
      // Explicit org check alongside RLS — see `assertShiftViewable`'s own
      // comment on why a single enforcement layer isn't enough here.
      if (!shift || shift.organisationId !== ctx.organisationId) throw new NotFoundException('Shift not found.');
      if (shift.status !== ShiftStatus.PENDING_MANAGER_APPROVAL) {
        throw new ConflictException('This request has already been actioned and can no longer be edited.');
      }
      await this.assertStaffSelectable(manager, ctx, [staffProfileId], shift.workspaceId);
      await this.assertStaffAvailable(manager, [staffProfileId], shift.startsAt, shift.endsAt, shiftId);

      const existing = await manager.findOne(ShiftRequestStaff, { where: { shiftId, staffProfileId } });
      if (existing) throw new ConflictException('This staff member is already on the request.');

      await manager.insert(ShiftRequestStaff, {
        organisationId: ctx.organisationId!,
        workspaceId: shift.workspaceId,
        shiftId,
        staffProfileId,
      });

      await this.auditService.record(manager, ctx, AuditAction.SHIFT_REQUEST_STAFF_ADDED, {
        entityType: 'shift',
        entityId: shiftId,
        metadata: { staffProfileId },
      });
    });
  }

  /**
   * "Venue Offers" — the Internal Manager's dedicated review queue for
   * Venue-Manager-submitted requests (`requestedBy IS NOT NULL`), across
   * every lifecycle stage, not just the still-pending ones
   * `listPendingApprovals` covers. Distinct from the general `list()`
   * (every shift, however created) — this exists specifically to separate
   * "things a Venue Manager asked for" from "shifts I created myself,"
   * matching the product's own separate "Venue Offers" navigation item.
   * Org-wide for any Internal Manager/CEO, same as `listPendingApprovals` —
   * a request has no real `createdBy` owner until approved, so this can
   * never be `assertShiftOwned`-scoped the way `list()` is.
   */
  async listVenueOffers(ctx: AuthContext, dto: ListVenueOffersDto = {}): Promise<{ data: Record<string, unknown>[]; total: number }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const qb = manager
        .createQueryBuilder(Shift, 'shift')
        .innerJoin(Venue, 'v', 'v.id = shift.venueId')
        .innerJoin(JobRole, 'jr', 'jr.id = shift.jobRoleId')
        .innerJoin(User, 'vm', 'vm.id = shift.requestedBy')
        .where('shift.organisationId = :organisationId', { organisationId: ctx.organisationId })
        .andWhere('shift.requestedBy IS NOT NULL');

      if (dto.status === 'pending') {
        qb.andWhere('shift.status = :pending', { pending: ShiftStatus.PENDING_MANAGER_APPROVAL });
      } else if (dto.status === 'declined') {
        qb.andWhere('shift.status = :declined', { declined: ShiftStatus.DECLINED });
      } else if (dto.status === 'approved') {
        // "Approved" spans every real status a request-originated shift can
        // reach once it leaves the pending queue without being declined —
        // never a new status of its own (Part T: reuse the real enum).
        qb.andWhere('shift.status NOT IN (:...excluded)', {
          excluded: [ShiftStatus.PENDING_MANAGER_APPROVAL, ShiftStatus.DECLINED],
        });
      }
      if (dto.q?.trim()) {
        qb.andWhere(
          "(v.name ILIKE :q OR jr.name ILIKE :q OR CONCAT(vm.firstName, ' ', vm.lastName) ILIKE :q)",
          { q: toIlikePattern(dto.q.trim()) },
        );
      }

      const total = await qb.getCount();
      const { skip, take } = paginationSkipTake(dto);
      const data = await qb
        .select('shift.id', 'id')
        .addSelect('shift.status', 'status')
        .addSelect('shift.startsAt', 'startsAt')
        .addSelect('shift.endsAt', 'endsAt')
        .addSelect('shift.requiredCount', 'requiredCount')
        .addSelect('shift.payRatePence', 'payRatePence')
        .addSelect('shift.notes', 'notes')
        .addSelect('shift.createdAt', 'submittedAt')
        .addSelect('v.name', 'venueName')
        .addSelect('jr.name', 'roleName')
        .addSelect("CONCAT(vm.firstName, ' ', vm.lastName)", 'venueManagerName')
        .addSelect(
          '(SELECT COUNT(*) FROM core.shift_request_staff rs WHERE rs.shift_id = shift.id)',
          'selectedCount',
        )
        .orderBy('shift.createdAt', 'DESC')
        .offset(skip)
        .limit(take)
        .getRawMany();
      return { data, total };
    });
  }

  /**
   * The approval queue — visible to any Internal Manager/CEO org-wide (the
   * eligible approver set from `listApprovers`), NOT scoped by
   * `assertShiftOwned`/`createdBy` the way every other shift list is. A
   * request has no real "owner" yet in that sense — it belongs to whichever
   * Internal Manager acts on it first, mirroring how `STAFFING_REQUEST_APPROVE`
   * itself isn't scoped any narrower than "any Internal Manager in this org."
   */
  async listPendingApprovals(ctx: AuthContext): Promise<Shift[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      return manager.find(Shift, {
        where: { organisationId: ctx.organisationId!, status: ShiftStatus.PENDING_MANAGER_APPROVAL },
        order: { createdAt: 'ASC' },
      });
    });
  }

  /**
   * Declining never sends offers — nothing in `OfferService` runs. Kept
   * here rather than `OfferService` because, unlike approve, decline is a
   * pure Shift-status action (see `OfferService.approveShiftRequest` for
   * why approve lives there instead).
   */
  async declineRequest(ctx: AuthContext, id: string, dto: DeclineShiftRequestDto): Promise<Shift> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id } });
      // Explicit org check alongside RLS — see `assertShiftViewable`'s own
      // comment on why a single enforcement layer isn't enough here.
      if (!shift || shift.organisationId !== ctx.organisationId) throw new NotFoundException('Shift not found.');
      if (shift.status !== ShiftStatus.PENDING_MANAGER_APPROVAL) {
        throw new NotFoundException('Shift not found.');
      }
      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.DECLINED);
      await manager.update(Shift, id, {
        status: ShiftStatus.DECLINED,
        declinedAt: new Date(),
        declinedBy: ctx.userId,
        declinedReason: dto.reason,
      });

      await this.auditService.record(manager, ctx, AuditAction.SHIFT_REQUEST_DECLINED, {
        entityType: 'shift',
        entityId: id,
        metadata: { reason: dto.reason },
      });

      if (shift.requestedBy) {
        const venue = await manager.findOne(Venue, { where: { id: shift.venueId } });
        await this.notificationService.notify(manager, {
          organisationId: ctx.organisationId!,
          userId: shift.requestedBy,
          type: NotificationType.SHIFT_REQUEST_DECLINED,
          title: 'Shift request declined',
          message: dto.reason
            ? `Your request for ${venue?.name ?? 'the venue'} was declined: ${dto.reason}`
            : `Your request for ${venue?.name ?? 'the venue'} was declined.`,
          relatedEntityType: 'shift',
          relatedEntityId: id,
        });
      }

      return manager.findOneByOrFail(Shift, { id });
    });
  }
}
