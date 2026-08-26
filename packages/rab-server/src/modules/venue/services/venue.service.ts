import { assertTransition, VENUE_TRANSITIONS, VenueStatus } from '@rab/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { In } from 'typeorm';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { CreateVenueDto } from '../dto/create-venue.dto';
import { UpdateVenueDto } from '../dto/update-venue.dto';
import { Venue } from '../entities/venue.entity';

@Injectable()
export class VenueService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
  ) {}

  /**
   * Venues have no ownership field and are today's intentionally-shared
   * resource among Managers/CEOs/Admin (every manager collaboratively works
   * across the org's venues) — that's preserved unchanged here. A Venue
   * Manager is the one role scoped to their explicitly assigned venues
   * (`ManagerVenue`, previously unwired — see `ManagerService.assignVenue`).
   */
  list(ctx: AuthContext, pagination: PaginationDto = {}): Promise<Venue[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue') {
        if (scope.venueIds.length === 0) return [];
        return manager.find(Venue, {
          where: { id: In(scope.venueIds) },
          order: { name: 'ASC' },
          ...paginationSkipTake(pagination),
        });
      }
      return manager.find(Venue, { order: { name: 'ASC' }, ...paginationSkipTake(pagination) });
    });
  }

  async get(ctx: AuthContext, id: string): Promise<Venue> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue' && !scope.venueIds.includes(id)) {
        throw new NotFoundException('Venue not found.');
      }
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
