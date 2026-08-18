import { assertTransition, SHIFT_TRANSITIONS, ShiftStatus } from '@rab/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Between } from 'typeorm';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { CreateJobRoleDto } from '../dto/create-job-role.dto';
import { CreateShiftDto } from '../dto/create-shift.dto';
import { JobRole } from '../entities/job-role.entity';
import { Shift } from '../entities/shift.entity';
import { VenueRoleRate } from '../entities/venue-role-rate.entity';

@Injectable()
export class SchedulingService {
  constructor(private readonly tenantContext: TenantContextService) {}

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

  list(ctx: AuthContext, from?: string, to?: string): Promise<Shift[]> {
    return this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager.find(Shift, {
        where: from && to ? { startsAt: Between(new Date(from), new Date(to)) } : {},
        order: { startsAt: 'ASC' },
      }),
    );
  }

  async get(ctx: AuthContext, id: string): Promise<Shift> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      return shift;
    });
  }

  /**
   * Rate resolution, `assignment → staff role rate → venue role rate → org
   * default` (rab-workforce-architecture.md §1 A6) — staff-specific
   * overrides don't exist yet (no per-staff rate table built), so this
   * resolves venue role rate → job role default, snapshotted onto the
   * shift itself at creation. `payRatePence` on the DTO always wins when
   * the manager sets it explicitly.
   */
  async create(ctx: AuthContext, dto: CreateShiftDto): Promise<Shift> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      let payRatePence = dto.payRatePence;
      if (payRatePence === undefined) {
        const rate = await manager
          .createQueryBuilder(VenueRoleRate, 'r')
          .where('r.venue_id = :venueId', { venueId: dto.venueId })
          .andWhere('r.job_role_id = :jobRoleId', { jobRoleId: dto.jobRoleId })
          .andWhere('r.effective_from <= :start', { start: dto.startsAt })
          .andWhere('(r.effective_to IS NULL OR r.effective_to >= :start)', { start: dto.startsAt })
          .orderBy('r.effective_from', 'DESC')
          .getOne();
        if (rate) {
          payRatePence = rate.payRatePence;
        } else {
          const jobRole = await manager.findOne(JobRole, { where: { id: dto.jobRoleId } });
          payRatePence = jobRole?.defaultRatePence ?? 0;
        }
      }

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
      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.OPEN);
      await manager.update(Shift, id, { status: ShiftStatus.OPEN, publishedAt: new Date() });
      return manager.findOneByOrFail(Shift, { id });
    });
  }

  async cancel(ctx: AuthContext, id: string, reason: string): Promise<Shift> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id } });
      if (!shift) throw new NotFoundException('Shift not found.');
      assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.CANCELLED);
      await manager.update(Shift, id, { status: ShiftStatus.CANCELLED, cancelledReason: reason });
      return manager.findOneByOrFail(Shift, { id });
    });
  }
}
