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

@Injectable()
export class SchedulingService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
  ) {}

  /**
   * A normal manager's private scope is "shifts I created"; a Venue
   * Manager's is "shifts at venues I'm assigned to" (they never create
   * shifts themselves — `SCHEDULE_CREATE` isn't in their permission set —
   * so a plain creator check always came back empty for them, a real bug
   * this fixes); the platform admin sees every shift in the org regardless.
   * Unlike StaffProfile/JobOffer, `shift.created_by` has been NOT NULL
   * since the table's original migration, so there is no legacy-ambiguous-
   * owner case to handle here — every shift has always had a real creator.
   */
  private async assertShiftOwnedOrAdmin(manager: EntityManager, ctx: AuthContext, shift: Shift): Promise<void> {
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (scope.kind === 'admin') return;
    if (scope.kind === 'owner' && shift.createdBy === ctx.userId) return;
    if (scope.kind === 'venue' && scope.venueIds.includes(shift.venueId)) return;
    throw new NotFoundException('Shift not found.');
  }

  listJobRoles(ctx: AuthContext): Promise<JobRole[]> {
    return this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager.find(JobRole, { order: { name: 'ASC' } }),
    );
  }

  createJobRole(ctx: AuthContext, dto: CreateJobRoleDto): Promise<JobRole> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const role = manager.create(JobRole, {
        organisationId: ctx.organisationId!,
        name: dto.name,
        defaultRatePence: dto.defaultRatePence ?? 0,
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
        scope.kind === 'admin'
          ? dateFilter
          : scope.kind === 'venue'
            ? { ...dateFilter, venueId: In(scope.venueIds) }
            : { ...dateFilter, createdBy: ctx.userId };
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
      await this.assertShiftOwnedOrAdmin(manager, ctx, shift);
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
      const payRatePence = await this.resolvePayRate(manager, dto);

      const shift = manager.create(Shift, {
        organisationId: ctx.organisationId!,
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
      await this.assertShiftOwnedOrAdmin(manager, ctx, shift);
      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.OPEN);
      await manager.update(Shift, id, { status: ShiftStatus.OPEN, publishedAt: new Date() });
      return manager.findOneByOrFail(Shift, { id });
    });
  }

  async cancel(ctx: AuthContext, id: string, reason: string): Promise<Shift> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftOwnedOrAdmin(manager, ctx, shift);
      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.CANCELLED);
      await manager.update(Shift, id, { status: ShiftStatus.CANCELLED, cancelledReason: reason });
      return manager.findOneByOrFail(Shift, { id });
    });
  }
}
