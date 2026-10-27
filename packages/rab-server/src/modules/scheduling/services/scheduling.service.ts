import { sentShiftPresentation } from './sent-shift-presentation';
import { ListSentShiftsDto, SentShiftView } from '../dto/list-sent-shifts.dto';
import { SHIFT_ACTION_WINDOW_HOURS } from '../utils/shift-action-window';
import { validateAssignmentTime, effectiveAssignmentBreakMinutes, assignmentEnvelope, defaultAssignmentTime } from '../utils/assignment-time';
import { resolveVenueOfferStatus } from '../../offer/services/venue-offer-presentation';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { PermissionFlag } from '@rab/shared';
import { ForbiddenException } from '@nestjs/common';
import { assertVenueTeamSelection } from '../../staff/services/venue-team-scope';
import { assertStaffAvailabilityAcknowledged } from '../../staff/services/staff-availability';
import { ARCHIVE_TRANSITIONS, ArchiveState, archiveStateOf, assertTransition, EmploymentStatus, ManagerType, NotificationType, SHIFT_TRANSITIONS, ShiftStatus, UserStatus } from '@rab/shared';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { MemberAccessPolicyService, ObjectAccessPolicy } from '../../identity/member-access/member-access-policy.service';
import { shiftSeatCountsSql, vacancyFromCounts } from '../../offer/services/shift-vacancy';
import { EntityManager, QueryFailedError, SelectQueryBuilder } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { CoreEntityCacheService } from '../../../engine/core-modules/entity-cache/core-entity-cache.service';
import { ResourceScope, ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { beginAssistantRead } from '../../../engine/utils/assistant-read.util';
import { toIlikePattern } from '../../../engine/utils/ilike-pattern.util';
import { User } from '../../identity/entities';
import { ManagerProfile } from '../../manager/entities/manager-profile.entity';
import { NotificationService } from '../../notification/services/notification.service';
import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { Venue } from '../../venue/entities/venue.entity';
import { CreateJobRoleDto } from '../dto/create-job-role.dto';
import { CreateShiftDto } from '../dto/create-shift.dto';
import { UPDATE_DRAFT_SHIFT_FIELDS, UpdateDraftShiftDto } from '../dto/update-draft-shift.dto';
import { DeclineShiftRequestDto } from '../dto/decline-shift-request.dto';
import { ListSelectableStaffDto } from '../dto/list-selectable-staff.dto';
import { ListShiftsDto } from '../dto/list-shifts.dto';
import { ListVenueOffersDto } from '../dto/list-venue-offers.dto';
import { SetRequestedStaffDto } from '../dto/set-requested-staff.dto';
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

/** AI Phase 1: shift statuses that represent a shift that is (or was) to be staffed. */
const ASSISTANT_STAFFABLE_STATUSES = [
  ShiftStatus.OPEN, ShiftStatus.OFFERED, ShiftStatus.PARTIALLY_FILLED, ShiftStatus.FULLY_FILLED, ShiftStatus.CONFIRMED, ShiftStatus.IN_PROGRESS, ShiftStatus.COMPLETED,
];
/** AI Phase 1: hard bound on the shifts one staffing aggregate reads. */
export const ASSISTANT_STAFFING_MAX_SHIFTS = 2000;

/** AI Phase 1 staffing read model — operational fields only (no staff identity, note, address or rate). */
export interface AssistantStaffingShift {
  shiftId: string;
  venueName: string | null;
  jobRoleName: string;
  startsAt: string;
  endsAt: string;
  status: string;
  requiredCount: number;
  confirmedCount: number;
  vacancies: number;
  pendingOffers: number;
  awaitingConfirmation: number;
}

export interface AssistantStaffingSnapshot {
  shiftCount: number;
  fullyStaffedShiftCount: number;
  shiftsWithVacancies: number;
  seatsRequired: number;
  seatsFilled: number;
  seatsVacant: number;
  truncated: boolean;
  unfilledTotal: number;
  unfilled: AssistantStaffingShift[];
}

@Injectable()
export class SchedulingService {
  @Inject(MemberAccessPolicyService)
  private readonly memberAccess!: MemberAccessPolicyService;

  constructor(
    private readonly permissions: PermissionsService,
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
    private readonly venueService: VenueService,
    private readonly auditService: AuditService,
    private readonly notificationService: NotificationService,
    private readonly availabilityService: AvailabilityService,
    private readonly entityCache: CoreEntityCacheService,
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
      // Not for custom workspace-members: they never get the org-wide pending-approval widening.
      if (scope.kind === 'owner' && !scope.delegated && shift.organisationId === ctx.organisationId) return;
    }
    // Read-only: a custom workspace-member may read shifts their workspace OWNER created.
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (scope.kind === 'owner' && scope.delegated && shift.createdBy === scope.ownerUserId) {
      // …and only within their role: object read + record filter. Outside it ⇒ 404, like any other foreign shift.
      const policy = await this.memberAccess.resolveTx(manager, ctx, 'shift');
      if (!policy.canRead) throw new NotFoundException('Shift not found.');
      const recordFilter = this.memberAccess.qbWhere(policy, 'shift');
      const inScope = await manager.createQueryBuilder(Shift, 'shift').where('shift.id = :id', { id: shift.id }).andWhere(recordFilter.sql, recordFilter.named).getExists();
      if (!inScope) throw new NotFoundException('Shift not found.');
      return;
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

  /**
   * Wave 5: GET /job-roles is a REFERENCE read (Calendar / Shifts / the Venue Manager app resolve role NAMES of historical
   * shifts through it), so archived roles are still returned — each carries `archivedAt` and pickers hide them. The
   * write side enforces it: a shift or staff profile can never be created with an archived role (409 JOB_ROLE_ARCHIVED).
   */
  listJobRoles(ctx: AuthContext): Promise<JobRole[]> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue') {
        return manager.find(JobRole, { order: { name: 'ASC' } });
      }
      // The caller's own job roles — or, for a custom workspace-member only, their workspace owner's.
      const roles = await manager.find(JobRole, { where: { createdBy: scope.ownerUserId }, order: { name: 'ASC' } });
      if (!scope.delegated) return roles;
      // Job role names are reference data members need for Staff and Shifts; the default rate is pay data and is
      // returned only when the member's role shows Shift pay rates.
      const policy = await this.memberAccess.resolveTx(manager, ctx, 'shift');
      if (this.memberAccess.isFieldVisible(policy, 'payRate') && policy.canRead) return roles;
      return roles.map(({ defaultRatePence: _rate, ...role }) => role as JobRole);
    });
  }

  async createJobRole(ctx: AuthContext, dto: CreateJobRoleDto): Promise<JobRole> {
    this.resourceScope.assertHasWorkspace(ctx);
    try {
      return await this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
        const role = manager.create(JobRole, {
          organisationId: ctx.organisationId!,
          name: dto.name,
          defaultRatePence: dto.defaultRatePence ?? 0,
          createdBy: ctx.userId,
          workspaceId: ctx.workspaceId ?? undefined,
        });
        return manager.save(role);
      });
    } catch (e) {
      // `job_role_organisation_id_name_key` — a concurrent create (or a
      // retried/double-submitted request, as seen in production: two
      // identical attempts ~10s apart) for the same org+name becomes a
      // controlled 409, matching `StaffService.create`'s own 23505-to-409
      // convention, instead of an unhandled 500.
      if (e instanceof QueryFailedError && (e as unknown as { code?: string }).code === '23505') {
        // Wave 5: the name may be held by an ARCHIVED role (uniques stay total, contract §3) — say so, so the manager
        // restores it instead of guessing. Only the caller's own roles are consulted (no cross-scope disclosure).
        const archived = await this.tenantContext
          .runInWorkspaceContext(ctx, (m) => m.findOne(JobRole, { where: { name: dto.name, createdBy: ctx.userId } }))
          .catch(() => null);
        if (archived?.archivedAt) {
          throw new ConflictException({ code: 'JOB_ROLE_ARCHIVED_NAME', message: 'An archived job role already has this name. Restore it instead.' });
        }
        throw new ConflictException('A job role with this name already exists.');
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ wave 5: archive / restore

  /** 409 when new work would reference an archived job role (the caller already passed the role's scope check). */
  assertJobRoleNotArchived(jobRole: JobRole): void {
    if (jobRole.archivedAt) {
      throw new ConflictException({ code: 'JOB_ROLE_ARCHIVED', message: 'This job role is archived. Restore it before using it.' });
    }
  }

  /** Layer 2: the route's PermissionGuard flag, re-checked here (other services / jobs never pass the guard). */
  private async assertFlagTx(manager: EntityManager, ctx: AuthContext, flag: (typeof PermissionFlag)[keyof typeof PermissionFlag], message: string): Promise<void> {
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, flag))) throw new ForbiddenException(message);
  }

  /**
   * Strict WRITE scope for a job role: only the caller's OWN role (`created_by = ctx.userId`) — never the Venue
   * Manager reference-read widening `assertJobRoleOwned` grants, never a delegated member. 404 otherwise, including
   * another workspace's / organisation's role (RLS hides those first).
   */
  private async loadOwnJobRoleTx(manager: EntityManager, ctx: AuthContext, id: string): Promise<JobRole> {
    const role = await manager.findOne(JobRole, { where: { id } });
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (!role || !(scope.kind === 'owner' && !scope.delegated && role.createdBy === ctx.userId)) throw new NotFoundException('Job role not found.');
    return role;
  }

  /**
   * Named action `archiveJobRole`. The role keeps its name (uniques stay total, contract §3) and stays readable in
   * history (shifts, payslips, GET /job-roles with `archivedAt`); it can no longer be used for new shifts or staff.
   */
  async archiveJobRole(ctx: AuthContext, id: string): Promise<JobRole> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertFlagTx(manager, ctx, PermissionFlag.SCHEDULE_CREATE, 'Managing job roles is not permitted.');
      const role = await this.loadOwnJobRoleTx(manager, ctx, id);
      assertTransition(ARCHIVE_TRANSITIONS, archiveStateOf(role.archivedAt), ArchiveState.ARCHIVED);
      await manager.update(JobRole, id, { archivedAt: () => 'now()', archivedBy: ctx.userId } as never);
      await this.auditService.record(manager, ctx, AuditAction.JOB_ROLE_ARCHIVED, { entityType: 'job_role', entityId: id, metadata: { name: role.name } });
      return manager.findOneByOrFail(JobRole, { id });
    });
  }

  /** Named action `restoreJobRole`. Cannot hit a unique conflict (the archived role kept its name). */
  async restoreJobRole(ctx: AuthContext, id: string): Promise<JobRole> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertFlagTx(manager, ctx, PermissionFlag.SCHEDULE_CREATE, 'Managing job roles is not permitted.');
      const role = await this.loadOwnJobRoleTx(manager, ctx, id);
      assertTransition(ARCHIVE_TRANSITIONS, archiveStateOf(role.archivedAt), ArchiveState.ACTIVE);
      await manager.update(JobRole, id, { archivedAt: null, archivedBy: null });
      await this.auditService.record(manager, ctx, AuditAction.JOB_ROLE_RESTORED, { entityType: 'job_role', entityId: id, metadata: { name: role.name } });
      return manager.findOneByOrFail(JobRole, { id });
    });
  }

  /**
   * Named action `archiveShift` — DRAFT shifts only (a published shift is cancelled, never archived: offers, attendance
   * and payroll hang off it). Layers: PermissionGuard(SCHEDULE_CREATE) → re-checked here → `assertShiftOwned` (404 out of
   * scope) → status must be DRAFT (409) + `ARCHIVE_TRANSITIONS` → workspace RLS → DB CHECK
   * `shift_archived_draft_only_check`. The UPDATE is a compare-and-set on (status, archived_at) so a concurrent publish
   * cannot interleave.
   */
  async archiveShift(ctx: AuthContext, id: string): Promise<Shift> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertFlagTx(manager, ctx, PermissionFlag.SCHEDULE_CREATE, 'Managing shifts is not permitted.');
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftOwned(manager, ctx, shift);
      if (shift.status !== ShiftStatus.DRAFT) {
        throw new ConflictException({ code: 'SHIFT_NOT_DRAFT', message: 'Only draft shifts can be archived. Cancel a published shift instead.' });
      }
      assertTransition(ARCHIVE_TRANSITIONS, archiveStateOf(shift.archivedAt), ArchiveState.ARCHIVED);
      const [claimed] = (await manager.query(
        `UPDATE shift SET archived_at = now(), archived_by = $2, updated_at = now()
          WHERE id = $1 AND status = $3 AND archived_at IS NULL RETURNING id`,
        [id, ctx.userId, ShiftStatus.DRAFT],
      )) as [Array<{ id: string }>, number];
      if (claimed.length === 0) throw new ConflictException('This shift changed while it was being archived — please refresh.');
      await this.auditService.record(manager, ctx, AuditAction.SHIFT_ARCHIVED, { entityType: 'shift', entityId: id, metadata: { status: shift.status } });
      return manager.findOneByOrFail(Shift, { id });
    });
  }

  /** Named action `restoreShift` — back to an ordinary (unarchived) draft. */
  async restoreShift(ctx: AuthContext, id: string): Promise<Shift> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertFlagTx(manager, ctx, PermissionFlag.SCHEDULE_CREATE, 'Managing shifts is not permitted.');
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftOwned(manager, ctx, shift);
      assertTransition(ARCHIVE_TRANSITIONS, archiveStateOf(shift.archivedAt), ArchiveState.ACTIVE);
      const venue = await manager.findOne(Venue, { where: { id: shift.venueId } });
      if (venue) this.venueService.assertVenueNotArchived(venue);
      const [claimed] = (await manager.query(
        `UPDATE shift SET archived_at = NULL, archived_by = NULL, updated_at = now() WHERE id = $1 AND archived_at IS NOT NULL RETURNING id`,
        [id],
      )) as [Array<{ id: string }>, number];
      if (claimed.length === 0) throw new ConflictException('This shift changed while it was being restored — please refresh.');
      await this.auditService.record(manager, ctx, AuditAction.SHIFT_RESTORED, { entityType: 'shift', entityId: id, metadata: { status: shift.status } });
      return manager.findOneByOrFail(Shift, { id });
    });
  }

  list(ctx: AuthContext, dto: ListShiftsDto = {}): Promise<{ data: Shift[]; total: number }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue' && scope.venueIds.length === 0) return { data: [], total: 0 };
      const policy = await this.memberAccess.resolveTx(manager, ctx, 'shift');

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
      this.applyShiftReadScope(qb, ctx, scope, policy, { widenPendingApproval: true });

      if (dto.from && dto.to) {
        qb.andWhere('shift.startsAt BETWEEN :from AND :to', { from: new Date(dto.from), to: new Date(dto.to) });
      }
      if (dto.q) {
        qb.andWhere('(v.name ILIKE :q OR jr.name ILIKE :q)', { q: toIlikePattern(dto.q) });
      }
      if (dto.status) qb.andWhere('shift.status = :status', { status: dto.status });
      // Wave 5: archived (draft) shifts are hidden unless "Show archived".
      if (!dto.includeArchived) qb.andWhere('shift.archivedAt IS NULL');
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
      return { data: data.map((shift) => this.memberAccess.project(policy, shift)), total };
    });
  }

  /**
   * The ONE shift read scope (extracted from `list()` unchanged; AI Phase 1 reuses it). A Venue Manager reads shifts at
   * their assigned venues; a custom workspace-member reads only their workspace owner's shifts within their record
   * filter; everyone else reads the shifts they created. `widenPendingApproval` adds `list()`'s org-wide visibility of
   * `pending_manager_approval` requests (see the comment inside) — a staffing aggregate never wants it, since a pending
   * request is not a staffable shift. Always the FIRST condition (`where`); callers only ever AND filters onto it.
   */
  applyShiftReadScope(
    qb: SelectQueryBuilder<Shift>,
    ctx: AuthContext,
    scope: ResourceScope,
    policy: ObjectAccessPolicy,
    opts: { widenPendingApproval: boolean },
  ): void {
    if (scope.kind === 'venue') {
      qb.where('shift.venueId IN (:...venueIds)', { venueIds: scope.venueIds });
      return;
    }
    // A `pending_manager_approval` request is deliberately unowned in
    // the `createdBy` sense until an Internal Manager approves it (see
    // `SubmitShiftRequestDto`'s own doc comment — `createdBy` is
    // stamped as the *submitting Venue Manager*, not any Internal
    // Manager) — a plain `createdBy = ctx.userId` here would make every
    // pending request invisible to every possible approver, since none
    // of them "own" it yet. Widened to org-wide visibility for this one
    // status only, the same scope `listPendingApprovals` already grants
    // — everything else stays strictly creator-owned.
    if (scope.delegated) {
      // A custom workspace-member reads only their workspace owner's shifts — no org-wide widening — and only
      // those their role's record filter allows.
      qb.where('shift.createdBy = :createdBy', { createdBy: scope.ownerUserId });
      this.memberAccess.assertCanRead(policy);
      const recordFilter = this.memberAccess.qbWhere(policy, 'shift');
      qb.andWhere(recordFilter.sql, recordFilter.named);
    } else if (opts.widenPendingApproval) {
      qb.where(
        '(shift.createdBy = :createdBy OR shift.status = :pendingApproval)',
        { createdBy: ctx.userId, pendingApproval: ShiftStatus.PENDING_MANAGER_APPROVAL },
      );
    } else {
      qb.where('shift.createdBy = :createdBy', { createdBy: ctx.userId });
    }
  }

  /**
   * AI Phase 1 (read-only, aggregate; docs/ai/PHASE1_PLAN.md). Staffing of the caller's shifts STARTING in [from, to):
   * seat counts per shift from the authoritative assignment rows (`shiftSeatCountsSql` + `vacancyFromCounts`, the same
   * rule as `loadShiftVacancy`), the shift read scope of `list()` without the pending-approval widening, and only
   * staffable statuses (draft / pending request / declined / cancelled are not shifts that need staff). No staff
   * identity, note, address or rate is read. Bounded: at most `ASSISTANT_STAFFING_MAX_SHIFTS` shifts are aggregated
   * (`truncated` says so) and `unfilledLimit` are listed. `schedule.view` is re-checked here (layer 2): the AI tool
   * layer checks it too, but a service is callable directly.
   */
  async assistantStaffing(ctx: AuthContext, range: { from: Date; to: Date }, opts: { unfilledLimit: number }): Promise<AssistantStaffingSnapshot> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      // AI Phase 3 (rule 7.3; p3 merge, Agent 3 REQUEST Q4): read only, 5 s per statement, like every other assistant read.
      await beginAssistantRead(manager);
      if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.SCHEDULE_VIEW))) throw new ForbiddenException('Permission required.');
      const empty: AssistantStaffingSnapshot = {
        shiftCount: 0, fullyStaffedShiftCount: 0, shiftsWithVacancies: 0, seatsRequired: 0, seatsFilled: 0, seatsVacant: 0,
        truncated: false, unfilledTotal: 0, unfilled: [],
      };
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue' && scope.venueIds.length === 0) return empty;
      const policy = await this.memberAccess.resolveTx(manager, ctx, 'shift');
      const qb = manager.createQueryBuilder(Shift, 'shift').select('shift.id', 'id');
      this.applyShiftReadScope(qb, ctx, scope, policy, { widenPendingApproval: false });
      qb.andWhere('shift.startsAt >= :from AND shift.startsAt < :to', { from: range.from, to: range.to })
        .andWhere('shift.status IN (:...staffable)', { staffable: ASSISTANT_STAFFABLE_STATUSES })
        .andWhere('shift.archivedAt IS NULL')
        .orderBy('shift.startsAt', 'ASC')
        .addOrderBy('shift.id', 'ASC')
        .limit(ASSISTANT_STAFFING_MAX_SHIFTS + 1);
      const ids = (await qb.getRawMany<{ id: string }>()).map((r) => r.id);
      if (ids.length === 0) return empty;
      const truncated = ids.length > ASSISTANT_STAFFING_MAX_SHIFTS;
      const rows: Array<Record<string, unknown>> = await manager.query(
        `SELECT s.id, s.status, s.starts_at, s.ends_at, s.required_count, s.filled_count, v.name AS venue_name, jr.name AS job_role_name,
                ${shiftSeatCountsSql('sa')}
           FROM shift s
           JOIN venue v ON v.id = s.venue_id
           JOIN job_role jr ON jr.id = s.job_role_id
           LEFT JOIN shift_assignment sa ON sa.shift_id = s.id
          WHERE s.id = ANY($1::uuid[])
          GROUP BY s.id, v.name, jr.name
          ORDER BY s.starts_at, s.id`,
        [ids.slice(0, ASSISTANT_STAFFING_MAX_SHIFTS)],
      );
      // "Venue display name where permitted": the venue name only for a caller who may list venues.
      const venueNames = await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.VENUE_VIEW);
      const snapshot: AssistantStaffingSnapshot = { ...empty, unfilled: [], truncated };
      for (const r of rows) {
        const requiredCount = Number(r.required_count);
        const { effectiveFilled, vacancy } = vacancyFromCounts({
          requiredCount, filledCount: Number(r.filled_count), occupied: Number(r.occupied), confirmedNoShows: Number(r.confirmed_no_shows),
        });
        const filled = Math.min(requiredCount, effectiveFilled);
        snapshot.shiftCount += 1;
        snapshot.seatsRequired += requiredCount;
        snapshot.seatsFilled += filled;
        snapshot.seatsVacant += vacancy;
        if (vacancy === 0) snapshot.fullyStaffedShiftCount += 1;
        // A completed shift's gap counts toward the fill rate but no longer "needs staff".
        if (vacancy > 0 && r.status !== ShiftStatus.COMPLETED) {
          snapshot.shiftsWithVacancies += 1;
          snapshot.unfilledTotal += 1;
          if (snapshot.unfilled.length < opts.unfilledLimit) {
            snapshot.unfilled.push({
              shiftId: r.id as string,
              venueName: venueNames ? (r.venue_name as string) : null,
              jobRoleName: r.job_role_name as string,
              startsAt: new Date(r.starts_at as string).toISOString(),
              endsAt: new Date(r.ends_at as string).toISOString(),
              status: r.status as string,
              requiredCount,
              confirmedCount: filled,
              vacancies: vacancy,
              pendingOffers: Number(r.pending_offers),
              awaitingConfirmation: Number(r.accepted_awaiting),
            });
          }
        }
      }
      return snapshot;
    });
  }

  /** Submitted requests, one row per shift. Original requester survives manager approval.
   * Scope is derived from the session, assigned venues and RLS, never client selectors.
   * No staff/user joins: counts must not disappear when identity rows are not readable.
   */
  async listSentShifts(ctx: AuthContext, dto: ListSentShiftsDto = {}, id?: string) {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      if (!await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.SCHEDULE_VIEW)) throw new ForbiddenException('Permission required.');
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind !== 'venue') throw new ForbiddenException('Venue manager required.');
      const view = dto.view ?? 'all';
      const { skip, take } = paginationSkipTake(dto);
      // One row per submitted request (shift), classified in SQL so tabs, totals and pagination agree. Offer counts use
      // each recipient's LATEST offer; assignment state is authoritative after confirmation (the offer stays historical).
      const rowsSql = `WITH latest AS (
          SELECT DISTINCT ON (sa.shift_id, o.staff_profile_id) sa.shift_id, o.status, sa.status AS assignment_status
            FROM shift_assignment sa JOIN job_offer o ON o.shift_assignment_id = sa.id
           WHERE sa.organisation_id = $1 AND o.organisation_id = $1
           ORDER BY sa.shift_id, o.staff_profile_id, o.sent_at DESC, o.id DESC
        ), counts AS (
          SELECT shift_id,
            count(*)::int AS sent,
            count(*) FILTER (WHERE status = 'pending' AND assignment_status = 'offered')::int AS pending,
            count(*) FILTER (WHERE assignment_status = 'staff_accepted')::int AS accepted,
            count(*) FILTER (WHERE assignment_status IN ('confirmed','completed'))::int AS confirmed,
            count(*) FILTER (WHERE assignment_status = 'no_show')::int AS no_show,
            count(*) FILTER (WHERE assignment_status = 'cancelled')::int AS cancelled,
            count(*) FILTER (WHERE status = 'declined')::int AS declined,
            count(*) FILTER (WHERE status = 'expired')::int AS expired,
            count(*) FILTER (WHERE status = 'withdrawn')::int AS withdrawn,
            count(*) FILTER (WHERE status = 'manager_rejected')::int AS rejected
          FROM latest GROUP BY shift_id
        ), rows AS (
          SELECT s.id, s.status, s.required_count AS "requiredCount", s.filled_count AS "filledCount",
            coalesce(s.default_starts_at, s.starts_at) AS "startsAt", coalesce(s.default_ends_at, s.ends_at) AS "endsAt",
            s.created_at AS "submittedAt", v.name AS "venueName", jr.name AS "roleName",
            s.ends_at + make_interval(hours => ${SHIFT_ACTION_WINDOW_HOURS}) AS "actionExpiresAt",
            now() >= s.ends_at + make_interval(hours => ${SHIFT_ACTION_WINDOW_HOURS}) AS "actionExpired",
            coalesce(c.sent, 0) AS sent, coalesce(c.pending, 0) AS pending, coalesce(c.accepted, 0) AS accepted,
            coalesce(c.confirmed, 0) AS confirmed, coalesce(c.no_show, 0) AS no_show, coalesce(c.cancelled, 0) AS cancelled,
            coalesce(c.declined, 0) AS declined, coalesce(c.expired, 0) AS expired, coalesce(c.withdrawn, 0) AS withdrawn,
            coalesce(c.rejected, 0) AS rejected,
            s.status IN ('cancelled','completed','declined') AS terminal
          FROM shift s JOIN venue v ON v.id = s.venue_id JOIN job_role jr ON jr.id = s.job_role_id
          LEFT JOIN counts c ON c.shift_id = s.id
          WHERE s.organisation_id = $1 AND s.requested_by = $2 AND s.venue_id = ANY($3::uuid[]) AND ($4::uuid IS NULL OR s.id = $4)
        ), classified AS (
          SELECT r.*,
            -- Genuinely expired: past the shift action window, or every recipient's latest offer expired with nobody
            -- accepted/confirmed. Terminal requests (cancelled / completed / declined) keep their own state.
            (NOT r.terminal AND (r."actionExpired" OR (r.sent > 0 AND r.expired = r.sent))) AS is_expired
          FROM rows r
        )`;
      const VIEW_SQL: Record<SentShiftView, string> = {
        all: 'NOT is_expired',
        pending: `NOT is_expired AND NOT terminal AND (status = 'pending_manager_approval' OR pending > 0)`,
        accepted: 'NOT is_expired AND NOT terminal AND accepted + confirmed > 0',
        confirmed: '"requiredCount" > 0 AND confirmed >= "requiredCount" AND NOT terminal AND NOT is_expired',
        declined: `(status = 'declined' OR (NOT terminal AND declined > 0)) AND NOT is_expired`,
        expired: 'is_expired',
      };
      const params = [ctx.organisationId, ctx.userId, scope.venueIds, id ?? null];
      const rows = await manager.query(
        `${rowsSql} SELECT *, count(*) OVER () AS view_total FROM classified WHERE ${id ? 'TRUE' : VIEW_SQL[view]}
          ORDER BY "submittedAt" DESC, id DESC LIMIT $5 OFFSET $6`,
        [...params, take, skip],
      );
      if (id && !rows.length) throw new NotFoundException('Shift not found.');
      // Tab counts + the distinct number of submitted requests (one request = one, however many recipients).
      const [tabs] = await manager.query(
        `${rowsSql} SELECT ${Object.entries(VIEW_SQL).map(([k, w]) => `count(*) FILTER (WHERE ${w})::int AS "${k}"`).join(', ')},
          count(*)::int AS submitted FROM classified`,
        params,
      );
      const total = rows[0] ? Number(rows[0].view_total) : 0;
      return {
        data: rows.map((r: any) => {
          const offerCounts: Record<string, number> = {
            sent: r.sent, pending: r.pending, accepted: r.accepted, confirmed: r.confirmed, noShow: r.no_show, cancelled: r.cancelled,
            declined: r.declined, expired: r.expired, withdrawn: r.withdrawn, rejected: r.rejected,
          };
          const { sent: _s, pending: _p, accepted: _a, confirmed: _c, no_show: _n, cancelled: _x, declined: _d, expired: _e, withdrawn: _w, rejected: _r,
            terminal: _t, is_expired, view_total: _v, ...row } = r;
          return { ...row, offerCounts, ...sentShiftPresentation(r.status, r.requiredCount, offerCounts, is_expired) };
        }),
        total,
        view,
        counts: tabs,
      };
    });
  }

  async get(ctx: AuthContext, id: string): Promise<Shift> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftViewable(manager, ctx, shift);
      return this.memberAccess.project(await this.memberAccess.resolveTx(manager, ctx, 'shift'), shift);
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

  /**
   * Layers: route PermissionGuard(SCHEDULE_CREATE) → SCHEDULE_CREATE re-checked here, first, in the same tenant
   * transaction (jobs / CLI / other services never pass the guard; LAYER2_HARDENING_2026-10-25 F2) → venue + job-role
   * scope (404) → workspace RLS. 403 like the guard: a categorical lack, decided before any referenced id is looked up.
   */
  async create(ctx: AuthContext, dto: CreateShiftDto): Promise<Shift> {
    return this.tenantContext.runInWorkspaceContext(ctx, (manager) => this.createDraftTx(manager, ctx, dto));
  }

  /**
   * Read-only: the venue and job role a new draft would use, under exactly the scope and archive rules `create` applies
   * (404 out of scope, 409 archived). Shared by `createDraftTx` and the AI `create_draft_shift` proposal's `prepare()`, so
   * the card and the write can never disagree about what is allowed.
   */
  async resolveDraftTargetsTx(manager: EntityManager, ctx: AuthContext, venueId: string, jobRoleId: string): Promise<{ venue: Venue; jobRole: JobRole }> {
    // Closes an IDOR that Venue/JobRole ownership scoping would otherwise
    // open: without this, a Manager could still create a shift against
    // another Manager's private venue/job-role by reusing a known id, even
    // though they can no longer see it in a list.
    const venue = await this.venueService.assertVenueAccessibleTx(manager, ctx, venueId);
    const jobRole = await manager.findOne(JobRole, { where: { id: jobRoleId } });
    if (!jobRole) throw new NotFoundException('Job role not found.');
    await this.assertJobRoleOwned(manager, ctx, jobRole);
    // Wave 5: no new work at an archived venue or with an archived job role (restore first).
    this.venueService.assertVenueNotArchived(venue);
    this.assertJobRoleNotArchived(jobRole);
    return { venue, jobRole };
  }

  /**
   * `create`, inside the CALLER's transaction (PHASE5_TWENTY_PLAN C6): the AI proposal executor runs it in the same
   * transaction as its compare-and-set, so "approved", the shift and "executed" commit or roll back together. Same layers
   * as `create`, starting with the SCHEDULE_CREATE re-check; the caller's `ctx` is the actor (`created_by`).
   */
  async createDraftTx(manager: EntityManager, ctx: AuthContext, dto: CreateShiftDto): Promise<Shift> {
    await this.assertFlagTx(manager, ctx, PermissionFlag.SCHEDULE_CREATE, 'Creating shifts is not permitted.');
    const { venue } = await this.resolveDraftTargetsTx(manager, ctx, dto.venueId, dto.jobRoleId);

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
    const saved = await manager.save(shift);
    // Wave 5 timeline: the lifecycle's first step, in the same transaction (no pay in metadata).
    await this.auditService.record(manager, ctx, AuditAction.SHIFT_CREATED, {
      entityType: 'shift',
      entityId: saved.id,
      metadata: { status: ShiftStatus.DRAFT, requiredCount: saved.requiredCount },
    });
    return saved;
  }

  /**
   * Read-only: the caller's OWN draft for an edit — strict owner scope (`assertShiftOwned`, 404 otherwise, including
   * another workspace's or organisation's shift, which RLS hides first), not archived (409 SHIFT_ARCHIVED) and still
   * DRAFT (409 SHIFT_NOT_DRAFT). Shared by `updateDraftTx` and the AI `update_draft_shift` proposal's `prepare()`.
   */
  async getOwnDraftTx(manager: EntityManager, ctx: AuthContext, id: string): Promise<Shift> {
    const shift = await manager.findOne(Shift, { where: { id } });
    if (!shift) throw new NotFoundException('Shift not found.');
    await this.assertShiftOwned(manager, ctx, shift);
    if (shift.archivedAt) throw new ConflictException({ code: 'SHIFT_ARCHIVED', message: 'This draft shift is archived. Restore it before editing.' });
    if (shift.status !== ShiftStatus.DRAFT) throw new ConflictException({ code: 'SHIFT_NOT_DRAFT', message: 'Only draft shifts can be edited.' });
    return shift;
  }

  /** Named action `updateDraftShift` (console route and the AI `update_draft_shift` proposal call the same code). */
  async updateDraft(ctx: AuthContext, id: string, dto: UpdateDraftShiftDto): Promise<Shift> {
    return this.tenantContext.runInWorkspaceContext(ctx, (manager) => this.updateDraftTx(manager, ctx, id, dto));
  }

  /**
   * Edits the five schedule fields of a DRAFT shift, inside the caller's transaction. Layers: route
   * PermissionGuard(SCHEDULE_CREATE) → SCHEDULE_CREATE re-checked here, first (403 for any id, before any lookup) →
   * explicit field mapping + service-side validation (400; a direct caller never passes the ValidationPipe) →
   * `getOwnDraftTx` (404 / 409) → compare-and-set on (status = DRAFT, archived_at IS NULL) → workspace RLS → DB CHECKs.
   * Never changes `status`, `pay_rate_pence`, `charge_rate_pence`, the venue or the job role: the pay rate snapshotted at
   * creation is kept (PHASE5_TWENTY_PLAN D2, flagged assumption — an edit never reprices the draft). Audited
   * `shift.draft_updated` with the changed field NAMES only.
   */
  async updateDraftTx(manager: EntityManager, ctx: AuthContext, id: string, dto: UpdateDraftShiftDto): Promise<Shift> {
    await this.assertFlagTx(manager, ctx, PermissionFlag.SCHEDULE_CREATE, 'Editing shifts is not permitted.');
    const changed = UPDATE_DRAFT_SHIFT_FIELDS.filter((key) => dto?.[key] !== undefined);
    if (changed.length === 0) throw new BadRequestException('Name at least one field to change.');
    const startsAtInput = dto.startsAt !== undefined ? new Date(dto.startsAt) : undefined;
    const endsAtInput = dto.endsAt !== undefined ? new Date(dto.endsAt) : undefined;
    if ((startsAtInput && Number.isNaN(startsAtInput.getTime())) || (endsAtInput && Number.isNaN(endsAtInput.getTime()))) {
      throw new BadRequestException('Start and end must be valid dates.');
    }
    if (dto.breakMinutes !== undefined && !(Number.isInteger(dto.breakMinutes) && dto.breakMinutes >= 0)) throw new BadRequestException('Break minutes must be a whole number of at least 0.');
    if (dto.requiredCount !== undefined && !(Number.isInteger(dto.requiredCount) && dto.requiredCount >= 1)) throw new BadRequestException('The number of people needed must be a whole number of at least 1.');
    if (dto.notes !== undefined && dto.notes !== null && typeof dto.notes !== 'string') throw new BadRequestException('Notes must be text.');

    const shift = await this.getOwnDraftTx(manager, ctx, id);
    const startsAt = startsAtInput ?? shift.startsAt;
    const endsAt = endsAtInput ?? shift.endsAt;
    if (!(endsAt.getTime() > startsAt.getTime())) throw new BadRequestException('A shift must end after it starts.');
    const [claimed] = (await manager.query(
      `UPDATE shift SET starts_at = $2, ends_at = $3, break_minutes = $4, required_count = $5, notes = $6, updated_at = now()
        WHERE id = $1 AND status = $7 AND archived_at IS NULL RETURNING id`,
      [
        id,
        startsAt,
        endsAt,
        dto.breakMinutes ?? shift.breakMinutes,
        dto.requiredCount ?? shift.requiredCount,
        dto.notes !== undefined ? dto.notes : (shift.notes ?? null),
        ShiftStatus.DRAFT,
      ],
    )) as [Array<{ id: string }>, number];
    if (claimed.length === 0) throw new ConflictException('This shift changed while it was being edited — please refresh.');
    await this.auditService.record(manager, ctx, AuditAction.SHIFT_DRAFT_UPDATED, { entityType: 'shift', entityId: id, metadata: { fields: changed } });
    return manager.findOneByOrFail(Shift, { id });
  }

  /**
   * Named action `publishShift`. Layers: route PermissionGuard(SCHEDULE_PUBLISH) → SCHEDULE_PUBLISH re-checked here,
   * first (403 for any id, before the row is loaded — never an existence oracle; LAYER2_HARDENING_2026-10-25 F2) →
   * `assertShiftOwned` (404 out of scope) → `assertTransition` (409) → workspace RLS.
   */
  async publish(ctx: AuthContext, id: string): Promise<Shift> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertFlagTx(manager, ctx, PermissionFlag.SCHEDULE_PUBLISH, 'Publishing shifts is not permitted.');
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftOwned(manager, ctx, shift);
      // An archived draft must be restored before it is published (the DB CHECK shift_archived_draft_only_check is the
      // backstop for any other writer).
      if (shift.archivedAt) throw new ConflictException({ code: 'SHIFT_ARCHIVED', message: 'This draft shift is archived. Restore it before publishing.' });
      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.OPEN);
      await manager.update(Shift, id, { status: ShiftStatus.OPEN, publishedAt: new Date() });
      await this.auditService.record(manager, ctx, AuditAction.SHIFT_PUBLISHED, { entityType: 'shift', entityId: id, metadata: { previousStatus: shift.status } });
      return manager.findOneByOrFail(Shift, { id });
    });
  }

  /**
   * PHASE 5 — the previous version blind-`update()`d after an in-memory
   * `assertTransition` check: two concurrent cancel calls (double-click, a
   * retried request) both pass the check before either commits, then both
   * write — harmless for `status` itself (both write the same value) but it
   * meant this transition was completely unaudited (no `AuditService.record`
   * call existed at all) and, more importantly, `cancelled_by`/`cancelled_at`
   * didn't exist as columns to race over in the first place. Rewritten as
   * an atomic claim (`UPDATE ... WHERE status = :priorStatus RETURNING`),
   * the same CAS idiom used everywhere else in this codebase for a
   * concurrency-sensitive transition, so a genuine race (this cancel vs.
   * another cancel, or vs. any other concurrent status-changing action) is
   * detected and reported as a clean 409 instead of silently double-firing
   * the (now real) audit record.
   */
  async cancel(ctx: AuthContext, id: string, reason?: string): Promise<Shift> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftOwned(manager, ctx, shift);
      // Fails fast with the existing clean InvalidTransitionError for an
      // inherently-invalid request (e.g. an already-COMPLETED shift) before
      // ever attempting the claim below — the claim's own zero-rows path
      // below is for the genuinely-concurrent case, not this one.
      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.CANCELLED);

      const [claimedRows] = (await manager.query(
        `UPDATE shift
           SET status = $1, cancelled_reason = $2, cancelled_by = $3, cancelled_at = now(), updated_at = now()
           WHERE id = $4 AND status = $5
           RETURNING id`,
        [ShiftStatus.CANCELLED, reason ?? null, ctx.userId, id, shift.status],
      )) as [Array<{ id: string }>, number];
      if (claimedRows.length === 0) {
        // The status changed between our read and this claim (another
        // concurrent cancel, or some other transition) — report the
        // CURRENT state, never silently retry against data we know is stale.
        const current = await manager.findOneByOrFail(Shift, { id });
        if (current.status === ShiftStatus.CANCELLED) {
          throw new ConflictException('This shift has already been cancelled.');
        }
        throw new ConflictException(`This shift's status changed to "${current.status}" and can no longer be cancelled from here — please refresh.`);
      }

      await this.auditService.record(manager, ctx, AuditAction.SHIFT_CANCELLED, {
        entityType: 'shift',
        entityId: id,
        metadata: { reason: reason ?? null, previousStatus: shift.status },
      });

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
      .andWhere('sp.employmentStatus = :employment', { employment: EmploymentStatus.ACTIVE })
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
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const venue = await this.venueService.assertVenueAccessibleTx(manager, ctx, dto.venueId);
      const jobRole = await manager.findOne(JobRole, { where: { id: dto.jobRoleId } });
      if (!jobRole) throw new NotFoundException('Job role not found.');
      await this.assertJobRoleOwned(manager, ctx, jobRole);
      this.venueService.assertVenueNotArchived(venue);
      this.assertJobRoleNotArchived(jobRole);
      await assertVenueTeamSelection(manager, ctx, dto.staffProfileIds, venue.workspaceId);
      await this.assertStaffSelectable(manager, ctx, dto.staffProfileIds, venue.workspaceId);
      // Service-level validation also protects internal callers, not just DTO transport.
      if ('payRatePence' in dto) throw new BadRequestException('Venue requests cannot override pay.');
      if (new Set(dto.staffProfileIds).size !== dto.staffProfileIds.length || !dto.staffProfileIds.length || dto.staffProfileIds.length > dto.staffRequired) throw new BadRequestException('Invalid staff selection.');
      const overrides = new Map((dto.staffAssignments ?? []).map(a => [a.staffProfileId, a]));
      if (overrides.size !== (dto.staffAssignments ?? []).length || [...overrides.keys()].some(id => !dto.staffProfileIds.includes(id))) throw new BadRequestException('Invalid assignment selection.');
      const parent = { startsAt: new Date(dto.startsAt), endsAt: new Date(dto.endsAt) };
      const breakMinutes = dto.breakMinutes ?? venue.defaultBreakMinutes ?? 30;
      validateAssignmentTime(parent, parent, breakMinutes);
      const windows = new Map(dto.staffProfileIds.map(id => {
        const value = overrides.get(id);
        return [id, validateAssignmentTime(parent, value ? { startsAt: new Date(value.startsAt), endsAt: new Date(value.endsAt) } : parent, effectiveAssignmentBreakMinutes(value ?? null, { breakMinutes }))];
      }));
      for (const [id, time] of windows) await this.assertStaffAvailable(manager, [id], time.startsAt, time.endsAt);
      // Declared weekday availability, warned at the Venue Manager's selection step. Acknowledging here only lets the
      // REQUEST be submitted — it dispatches nothing; approval re-evaluates and the approver must acknowledge again.
      const acknowledgedConflicts = await assertStaffAvailabilityAcknowledged(
        manager,
        [...windows].map(([staffProfileId, time]) => ({ staffProfileId, ...time })),
        dto.acknowledgedAvailabilityConflicts,
      );

      const payRatePence = await this.resolvePayRate(manager, {
        venueId: dto.venueId,
        jobRoleId: dto.jobRoleId,
        startsAt: dto.startsAt,
      });

      const shift = manager.create(Shift, {
        organisationId: ctx.organisationId!,
        workspaceId: venue.workspaceId,
        venueId: dto.venueId,
        jobRoleId: dto.jobRoleId,
        ...assignmentEnvelope(parent, [...windows.values()]),
        defaultStartsAt: parent.startsAt,
        defaultEndsAt: parent.endsAt,
        // Priority: explicit submitter override -> this Venue's configured
        // default -> a 30-minute fallback only when the Venue has none
        // configured at all (never silently 0, which would understate a
        // real unpaid-break deduction the submitter never chose).
        breakMinutes: dto.breakMinutes ?? venue.defaultBreakMinutes ?? 30,
        requiredCount: dto.staffRequired,
        payRatePence,
        notes: undefined,
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
          ...windows.get(staffProfileId)!,
          breakMinutes: overrides.get(staffProfileId)?.breakMinutes ?? null,
        })),
      );

      await this.auditService.record(manager, ctx, AuditAction.SHIFT_REQUEST_SUBMITTED, {
        entityType: 'shift',
        entityId: saved.id,
        metadata: { venueId: dto.venueId, jobRoleId: dto.jobRoleId, staffRequired: dto.staffRequired, staffProfileIds: dto.staffProfileIds },
      });
      for (const conflict of acknowledgedConflicts) {
        await this.auditService.record(manager, ctx, AuditAction.SHIFT_REQUEST_AVAILABILITY_CONFLICT_ACKNOWLEDGED, {
          entityType: 'shift',
          entityId: saved.id,
          metadata: {
            staffProfileId: conflict.staffProfileId,
            dates: conflict.conflictDates.map((d) => d.date),
            weekdays: conflict.conflictDates.map((d) => d.weekday),
            availableDays: conflict.availableDays,
          },
        });
      }

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
  async getRequestedStaff(ctx: AuthContext, shiftId: string): Promise<{ staffProfileId: string; firstName: string; lastName: string; email: string; stillActive: boolean; available: boolean; startsAt: Date; endsAt: Date }[]> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id: shiftId } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftViewable(manager, ctx, shift);
      // These rows are Staff records: a custom workspace-member also needs Staff read, its record filter and
      // Email visibility (no-op for everyone else).
      const staffPolicy = await this.memberAccess.resolveTx(manager, ctx, 'staff');
      if (!staffPolicy.canRead) return [];
      const staffFilter = this.memberAccess.qbWhere(staffPolicy, 'sp');
      const rows = await manager
        .createQueryBuilder(ShiftRequestStaff, 'rs')
        .innerJoin(StaffProfile, 'sp', 'sp.id = rs.staffProfileId')
        .innerJoin(User, 'u', 'u.id = sp.userId')
        .where('rs.shiftId = :shiftId', { shiftId })
        .andWhere(staffFilter.sql, staffFilter.named)
        .orderBy('u.firstName', 'ASC')
        .select('sp.id', 'staffProfileId')
        .addSelect('u.firstName', 'firstName')
        .addSelect('u.lastName', 'lastName')
        .addSelect('u.email', 'email')
        .addSelect('rs.startsAt', 'startsAt').addSelect('rs.endsAt', 'endsAt').addSelect('rs.breakMinutes', 'breakMinutes')
        .addSelect('(u.status = :activeStatus AND sp.employmentStatus = :activeEmployment)', 'stillActive')
        .setParameter('activeStatus', UserStatus.ACTIVE)
        .setParameter('activeEmployment', EmploymentStatus.ACTIVE)
        .getRawMany<{ staffProfileId: string; firstName: string; lastName: string; email: string; stillActive: boolean; startsAt: Date | null; endsAt: Date | null }>();
      return Promise.all(rows.map(async row => {
        const startsAt = row.startsAt ?? defaultAssignmentTime(shift).startsAt, endsAt = row.endsAt ?? defaultAssignmentTime(shift).endsAt;
        const busy = await this.availabilityService.findBusyStaffIds(manager, [row.staffProfileId], startsAt, endsAt, shift.id);
        const result = { ...row, startsAt, endsAt, available: !busy.has(row.staffProfileId) };
        if (!this.memberAccess.isFieldVisible(staffPolicy, 'email')) delete (result as Partial<typeof result>).email;
        return result;
      }));
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
    return this.tenantContext.runInWorkspaceContext(ctx, (manager) => this.removeRequestedStaffTx(manager, ctx, shiftId, staffProfileId));
  }

  private async removeRequestedStaffTx(manager: EntityManager, ctx: AuthContext, shiftId: string, staffProfileId: string): Promise<void> {
    const shift = await manager.findOne(Shift, { where: { id: shiftId }, lock: { mode: 'pessimistic_write' } });
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
      // Redis checkpoint — Core Entity Cache: pure display-only interpolation into a notification
      // message, never an authorization decision — see CoreEntityCacheService's own doc comment.
      const [venue, jobRole] = await Promise.all([
        this.entityCache.getVenueSummary(manager, shift.venueId),
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
    return this.tenantContext.runInWorkspaceContext(ctx, (manager) => this.addRequestedStaffTx(manager, ctx, shiftId, staffProfileId));
  }

  private async addRequestedStaffTx(manager: EntityManager, ctx: AuthContext, shiftId: string, staffProfileId: string): Promise<void> {
    const shift = await manager.findOne(Shift, { where: { id: shiftId }, lock: { mode: 'pessimistic_write' } });
    // Explicit org check alongside RLS — see `assertShiftViewable`'s own
    // comment on why a single enforcement layer isn't enough here.
    if (!shift || shift.organisationId !== ctx.organisationId) throw new NotFoundException('Shift not found.');
    if (shift.status !== ShiftStatus.PENDING_MANAGER_APPROVAL) {
      throw new ConflictException('This request has already been actioned and can no longer be edited.');
    }
    await this.assertStaffSelectable(manager, ctx, [staffProfileId], shift.workspaceId);
    await this.assertStaffAvailable(manager, [staffProfileId], defaultAssignmentTime(shift).startsAt, defaultAssignmentTime(shift).endsAt, shiftId);

    const existing = await manager.findOne(ShiftRequestStaff, { where: { shiftId, staffProfileId } });
    if (existing) throw new ConflictException('This staff member is already on the request.');
    if (await manager.count(ShiftRequestStaff, { where: { shiftId } }) >= shift.requiredCount) {
      throw new ConflictException('All required staff are already selected.');
    }

    await manager.insert(ShiftRequestStaff, {
      organisationId: ctx.organisationId!,
      workspaceId: shift.workspaceId,
      shiftId,
      staffProfileId,
      ...defaultAssignmentTime(shift),
    });

    await this.auditService.record(manager, ctx, AuditAction.SHIFT_REQUEST_STAFF_ADDED, {
      entityType: 'shift',
      entityId: shiftId,
      metadata: { staffProfileId },
    });
  }

  /** Internal Manager picker: private ACTIVE staff, availability from the saved shift. */
  async listSelectableStaff(ctx: AuthContext, shiftId: string, dto: ListSelectableStaffDto) {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      for (const permission of [PermissionFlag.STAFF_VIEW, PermissionFlag.STAFFING_REQUEST_APPROVE]) {
        if (!await this.permissions.userHasPermissionTx(manager, ctx, permission)) throw new ForbiddenException('You cannot select staff for this request.');
      }
      const shift = await manager.findOne(Shift, { where: { id: shiftId } });
      if (!shift || shift.organisationId !== ctx.organisationId || !ctx.workspaceId || shift.workspaceId !== ctx.workspaceId || !shift.requestedBy) {
        throw new NotFoundException('Shift not found.');
      }
      const replacing = shift.status !== ShiftStatus.PENDING_MANAGER_APPROVAL;
      if (replacing) {
        if (shift.status === ShiftStatus.DECLINED) throw new ConflictException('This request has been declined.');
        await this.assertShiftOwned(manager, ctx, shift);
        if (!await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.OFFER_SEND)) throw new ForbiddenException('Cannot send offers.');
        const [clock] = await manager.query('SELECT clock_timestamp() AS now');
        if (['cancelled','completed','declined'].includes(shift.status) || new Date(clock.now) >= shift.startsAt) throw new ConflictException('This shift no longer accepts replacement staff.');
      }
      const qb = manager.createQueryBuilder(StaffProfile, 'sp')
        .innerJoin(User, 'u', 'u.id = sp.userId')
        .where('sp.organisationId = :org', { org: ctx.organisationId })
        .andWhere('u.organisationId = :org', { org: ctx.organisationId })
        .andWhere('sp.workspaceId = :workspace', { workspace: ctx.workspaceId })
        .andWhere('sp.createdBy = :owner', { owner: ctx.userId })
        .andWhere('sp.employmentStatus = :employment', { employment: EmploymentStatus.ACTIVE })
        .andWhere('u.status = :account', { account: UserStatus.ACTIVE });
      if (replacing) qb.andWhere('NOT EXISTS (SELECT 1 FROM shift_assignment sa WHERE sa.shift_id=:shiftId AND sa.staff_profile_id=sp.id)', { shiftId });
      if (dto.q?.trim()) qb.andWhere("(u.firstName ILIKE :q OR u.lastName ILIKE :q OR CONCAT(u.firstName, ' ', u.lastName) ILIKE :q OR u.email ILIKE :q OR sp.staffRef ILIKE :q)", { q: toIlikePattern(dto.q.trim()) });
      const total = await qb.getCount();
      const { skip, take } = paginationSkipTake(dto);
      const rows = await qb.select('sp.id', 'id')
        .addSelect('u.firstName', 'firstName').addSelect('u.lastName', 'lastName')
        .addSelect('sp.staffRef', 'staffRef').addSelect('u.email', 'email').addSelect('u.phone', 'phone')
        .addSelect('sp.defaultPayRatePence', 'defaultPayRatePence')
        .addSelect('sp.employmentStatus', 'employmentStatus').addSelect('u.status', 'accountStatus')
        .addSelect('sp.createdAt', 'createdAt')
        .orderBy('u.firstName', 'ASC').addOrderBy('u.lastName', 'ASC').addOrderBy('sp.id', 'ASC')
        .offset(skip).limit(take).getRawMany<{ id: string; firstName: string; lastName: string; staffRef: string; email: string; phone: string | null; defaultPayRatePence: number; employmentStatus: string; accountStatus: string; createdAt: Date }>();
      const busy = await this.availabilityService.findBusyStaffIds(manager, rows.map((row) => row.id), shift.startsAt, shift.endsAt, shift.id);
      if (!replacing) {
        const requested = await manager.find(ShiftRequestStaff, { where: { shiftId } });
        const visibleIds = new Set(rows.map(row => row.id));
        for (const row of requested) {
          if (!visibleIds.has(row.staffProfileId) || !row.startsAt || !row.endsAt) continue;
          const actual = await this.availabilityService.findBusyStaffIds(manager, [row.staffProfileId], row.startsAt, row.endsAt, shift.id);
          if (actual.has(row.staffProfileId)) busy.add(row.staffProfileId);
          else busy.delete(row.staffProfileId);
        }
      }
      return { data: rows.map((row) => ({ ...row, available: !busy.has(row.id) })), total };
    });
  }

  /** Save one staged selection atomically. Never approves or creates offers. */
  async setRequestedStaff(ctx: AuthContext, shiftId: string, dto: SetRequestedStaffDto): Promise<void> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      if (!await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.STAFFING_REQUEST_APPROVE)) {
        throw new ForbiddenException('You cannot edit shift requests.');
      }
      const shift = await manager.findOne(Shift, { where: { id: shiftId }, lock: { mode: 'pessimistic_write' } });
      if (!shift || shift.organisationId !== ctx.organisationId || !ctx.workspaceId || shift.workspaceId !== ctx.workspaceId) {
        throw new NotFoundException('Shift not found.');
      }
      if (shift.status !== ShiftStatus.PENDING_MANAGER_APPROVAL) throw new ConflictException('This request has already been actioned.');
      const ids = dto.staffProfileIds;
      if (new Set(ids).size !== ids.length || ids.length > shift.requiredCount) throw new BadRequestException('Selection exceeds capacity or contains duplicate staff.');
      const current = await manager.find(ShiftRequestStaff, { where: { shiftId } });
      const currentIds = new Set(current.map((row) => row.staffProfileId));
      if (currentIds.size !== dto.expectedStaffProfileIds.length || dto.expectedStaffProfileIds.some((id) => !currentIds.has(id))) {
        throw new ConflictException('The selection changed. Reload the request before saving.');
      }
      if (ids.length) {
        await this.assertStaffSelectable(manager, ctx, ids, shift.workspaceId);
        // Same private owner boundary as StaffService.list, plus ACTIVE employment.
        const ownActive = await manager.createQueryBuilder(StaffProfile, 'sp')
          .where('sp.id IN (:...ids)', { ids })
          .andWhere('sp.organisationId = :org', { org: ctx.organisationId })
          .andWhere('sp.workspaceId = :workspace', { workspace: ctx.workspaceId })
          .andWhere('sp.createdBy = :owner', { owner: ctx.userId })
          .andWhere('sp.employmentStatus = :active', { active: EmploymentStatus.ACTIVE }).getCount();
        if (ownActive !== ids.length) throw new BadRequestException('One or more selected staff are no longer eligible.');
        for (const id of ids) {
          const request = current.find(row => row.staffProfileId === id);
          await this.assertStaffAvailable(manager, [id], request?.startsAt ?? defaultAssignmentTime(shift).startsAt, request?.endsAt ?? defaultAssignmentTime(shift).endsAt, shiftId);
        }
      }
      for (const id of currentIds) {
        if (!ids.includes(id)) await this.removeRequestedStaffTx(manager, ctx, shiftId, id);
      }
      for (const id of ids) {
        if (!currentIds.has(id)) await this.addRequestedStaffTx(manager, ctx, shiftId, id);
      }
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
   *
   * PERF-01 CORRECTION — same stale claim as `listPendingApprovals` above,
   * flagged there in full: the app-level query here has no workspace
   * narrowing, but `shift`'s own `shift_tenant` RLS policy silently
   * restricts every result to the caller's own workspace (or a venue they
   * personally manage) regardless. This is NOT genuinely org-wide today.
   * Not fixed here — see the full writeup on `listPendingApprovals`.
   */
  async listVenueOffers(ctx: AuthContext, dto: ListVenueOffersDto = {}): Promise<{ data: Record<string, unknown>[]; total: number }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const qb = manager
        .createQueryBuilder(Shift, 'shift')
        .innerJoin(Venue, 'v', 'v.id = shift.venueId')
        .innerJoin(JobRole, 'jr', 'jr.id = shift.jobRoleId')
        .innerJoin(User, 'vm', 'vm.id = shift.requestedBy')
        .where('shift.organisationId = :organisationId', { organisationId: ctx.organisationId })
        .andWhere('shift.requestedBy IS NOT NULL')
        .andWhere('(shift.status IN (:...reviewStates) OR shift.createdBy = :owner)', { reviewStates: [ShiftStatus.PENDING_MANAGER_APPROVAL, ShiftStatus.DECLINED], owner: ctx.userId });

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
        .addSelect("(SELECT COUNT(*) FROM shift_assignment sa WHERE sa.shift_id=shift.id AND sa.status IN ('confirmed','completed'))", 'confirmedCount')
        .addSelect("(SELECT COUNT(*) FROM shift_assignment sa WHERE sa.shift_id=shift.id AND sa.status='staff_accepted')", 'acceptedCount')
        .addSelect("(SELECT COUNT(*) FROM shift_assignment sa JOIN job_offer o ON o.shift_assignment_id=sa.id WHERE sa.shift_id=shift.id AND o.status='declined')", 'rejectedCount')
        .addSelect('shift.payRatePence', 'payRatePence')
        .addSelect('shift.notes', 'notes')
        .addSelect('shift.createdAt', 'submittedAt')
        .addSelect('v.name', 'venueName')
        .addSelect('jr.name', 'roleName')
        .addSelect("CONCAT(vm.firstName, ' ', vm.lastName)", 'venueManagerName')
        .addSelect(
          '(SELECT COUNT(*) FROM shift_request_staff rs WHERE rs.shift_id = shift.id)',
          'selectedCount',
        )
        .orderBy('shift.createdAt', 'DESC')
        .offset(skip)
        .limit(take)
        .getRawMany();
      return { data: data.map(row => ({ ...row, displayStatus: resolveVenueOfferStatus({ status: row.status, required: Number(row.requiredCount), confirmed: Number(row.confirmedCount), accepted: Number(row.acceptedCount), rejected: Number(row.rejectedCount) }) })), total };
    });
  }

  /**
   * The approval queue — the APPLICATION-level query here is deliberately
   * organisation-only (no `assertShiftOwned`/`createdBy` narrowing), matching
   * `STAFFING_REQUEST_APPROVE`'s own "any Internal Manager in this org" grant.
   * A request has no real "owner" yet in that sense — it belongs to whichever
   * Internal Manager acts on it first.
   *
   * PERF-01 CORRECTION — this comment used to claim that made the queue
   * genuinely "org-wide," visible to every Internal Manager regardless of
   * workspace. Verified false while writing PERF-01's own tests: `shift`'s
   * `shift_tenant` RLS policy (`OperationalWorkspaceRlsTransition`, latest
   * shape in `PlatformAdminGlobalRedesign`) enforces `workspace_id =
   * current_workspace() OR <caller manages this shift's venue>` UNDERNEATH
   * this query, regardless of what this method's own WHERE clause asks for —
   * RLS is the real, final authority (CLAUDE.md's five-layer rule), and it
   * silently narrows every result here to the caller's OWN workspace (plus
   * any venue they personally manage). Two Internal Managers in the same
   * organisation but different workspaces do NOT currently share this queue,
   * despite this comment's former claim and `STAFFING_REQUEST_APPROVE`'s own
   * "any Internal Manager in this org" framing elsewhere. `listVenueOffers`
   * below carries the identical stale claim and the identical real
   * behavior — flagged, not fixed, here: whether cross-workspace approval
   * visibility should be restored is a real product/authorization decision
   * (and an RLS policy change), out of PERF-01's bounded-pagination scope.
   * Not silently changing the RLS boundary either way — just documenting it
   * accurately and pagination-testing what's ACTUALLY enforced today.
   *
   * PERF-01 — this used to be a plain `manager.find()` with no `skip`/`take`
   * at all: a manager/workspace with a large pending queue would load every
   * matching row, unbounded, on every request. Reuses the SAME
   * `PaginationDto`/`paginationSkipTake` convention every other list
   * endpoint in this codebase already uses (`staff.service.ts`,
   * `venue.service.ts`, `offer.service.ts`, `listVenueOffers` above) —
   * deliberately not a new cursor/keyset protocol, since this platform
   * already standardises on offset pagination and `{data, total}` response
   * shapes. `id` is added as a tie-breaker alongside `createdAt` so two
   * requests created in the same instant still paginate deterministically
   * (no skipped or duplicated row across pages).
   */
  async listPendingApprovals(ctx: AuthContext, dto: PaginationDto = {}): Promise<{ data: Shift[]; total: number }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const { skip, take } = paginationSkipTake(dto);
      const [data, total] = await manager.findAndCount(Shift, {
        where: { organisationId: ctx.organisationId!, status: ShiftStatus.PENDING_MANAGER_APPROVAL },
        order: { createdAt: 'ASC', id: 'ASC' },
        skip,
        take,
      });
      return { data, total };
    });
  }

  /**
   * Declining never sends offers — nothing in `OfferService` runs. Kept
   * here rather than `OfferService` because, unlike approve, decline is a
   * pure Shift-status action (see `OfferService.approveShiftRequest` for
   * why approve lives there instead).
   */
  async declineRequest(ctx: AuthContext, id: string, dto: DeclineShiftRequestDto): Promise<Shift> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id }, lock: { mode: 'pessimistic_write' } });
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
        // Redis checkpoint — Core Entity Cache: display-only, see the identical comment above in this file.
        const venue = await this.entityCache.getVenueSummary(manager, shift.venueId);
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
