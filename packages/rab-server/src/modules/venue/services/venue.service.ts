import { assertTransition, VENUE_TRANSITIONS, VenueStatus } from '@rab/shared';
import { Injectable, NotFoundException } from '@nestjs/common';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { CreateVenueDto } from '../dto/create-venue.dto';
import { UpdateVenueDto } from '../dto/update-venue.dto';
import { Venue } from '../entities/venue.entity';

@Injectable()
export class VenueService {
  constructor(private readonly tenantContext: TenantContextService) {}

  list(ctx: AuthContext, pagination: PaginationDto = {}): Promise<Venue[]> {
    return this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager.find(Venue, { order: { name: 'ASC' }, ...paginationSkipTake(pagination) }),
    );
  }

  async get(ctx: AuthContext, id: string): Promise<Venue> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      return venue;
    });
  }

  /**
   * `{ ...dto }`/`merge(venue, dto)` below are safe only because
   * `CreateVenueDto`/`UpdateVenueDto` deliberately never declare `status`,
   * `organisationId`, or `id` — the global `forbidNonWhitelisted` pipe is
   * the actual gate. If either DTO ever grows one of those fields, this
   * spread/merge would let a client with plain `VENUE_EDIT` set it
   * directly, bypassing `archive()`'s dedicated transition-checked path
   * below — switch to explicit field destructuring at that point (see
   * `StaffService.update`/`ManagerService.update` for the pattern).
   */
  create(ctx: AuthContext, dto: CreateVenueDto): Promise<Venue> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // .create()/.save() rather than .insert() — TypeORM's insert() query
      // builder types jsonb columns through _QueryDeepPartialEntity, which
      // doesn't accept a plain Record<string, unknown> object literal.
      const venue = manager.create(Venue, { organisationId: ctx.organisationId!, ...dto });
      return manager.save(venue);
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateVenueDto): Promise<Venue> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      manager.merge(Venue, venue, dto);
      await manager.save(venue);
      return manager.findOneByOrFail(Venue, { id });
    });
  }

  /** Venues are archived, never deleted — matches rab-workforce-architecture.md's venue-deletion edge case (§13). */
  async archive(ctx: AuthContext, id: string): Promise<Venue> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      assertTransition(VENUE_TRANSITIONS, venue.status, VenueStatus.ARCHIVED);
      await manager.update(Venue, id, { status: VenueStatus.ARCHIVED });
      return manager.findOneByOrFail(Venue, { id });
    });
  }
}
