import { assertTransition, SHIFT_TRANSITIONS, ShiftStatus } from '@rab/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Between, EntityManager, In } from 'typeorm';

import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { CreateJobRoleDto } from '../dto/create-job-role.dto';
import { CreateShiftDto } from '../dto/create-shift.dto';
import { ListShiftsDto } from '../dto/list-shifts.dto';
import { JobRole } from '../entities/job-role.entity';
import { Shift } from '../entities/shift.entity';
import { VenueRoleRate } from '../entities/venue-role-rate.entity';
import { VenueService } from '../../venue/services/venue.service';

@Injectable()
export class SchedulingService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
    private readonly venueService: VenueService,
  ) {}

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

  list(ctx: AuthContext, dto: ListShiftsDto = {}): Promise<Shift[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      const dateFilter = dto.from && dto.to ? { startsAt: Between(new Date(dto.from), new Date(dto.to)) } : {};
      if (scope.kind === 'venue' && scope.venueIds.length === 0) return [];
      const where =
        scope.kind === 'venue' ? { ...dateFilter, venueId: In(scope.venueIds) } : { ...dateFilter, createdBy: ctx.userId };
      return manager.find(Shift, {
        where,
        order: { startsAt: 'ASC' },
        ...paginationSkipTake(dto),
      });
    });
  }

  async get(ctx: AuthContext, id: string): Promise<Shift> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftOwned(manager, ctx, shift);
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

  async cancel(ctx: AuthContext, id: string, reason: string): Promise<Shift> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftOwned(manager, ctx, shift);
      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.CANCELLED);
      await manager.update(Shift, id, { status: ShiftStatus.CANCELLED, cancelledReason: reason });
      return manager.findOneByOrFail(Shift, { id });
    });
  }
}
