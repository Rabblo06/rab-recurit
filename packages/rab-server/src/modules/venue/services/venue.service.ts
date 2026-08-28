import { assertTransition, VENUE_TRANSITIONS, VenueStatus } from '@rab/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

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
   * A normal Manager's private scope is "venues I created" — same shape as
   * `StaffService.assertOwnedOrAdmin`/`SchedulingService.assertShiftOwnedOrAdmin`.
   * A Venue Manager's scope is their explicitly assigned venues
   * (`ManagerVenue`), unaffected by ownership. The platform admin sees every
   * venue in the org regardless. A NULL-`createdBy` venue (predates this
   * column, no recoverable creator) is admin-only until reassigned — never
   * guessed into a Manager's scope.
   */
  private async assertVenueOwnedOrAdmin(manager: EntityManager, ctx: AuthContext, venue: Venue): Promise<void> {
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (scope.kind === 'admin') return;
    if (scope.kind === 'owner' && venue.createdBy === ctx.userId) return;
    if (scope.kind === 'venue' && scope.venueIds.includes(venue.id)) return;
    throw new NotFoundException('Venue not found.');
  }

  /**
   * Public, `Tx`-suffixed (takes an already-open `manager`, never opens its
   * own transaction — see `TenantContextService.runInTenantContext`'s own
   * doc comment on why nesting a second `runInTenantContext` call would run
   * on an unrelated connection with no tenant context bound) — for other
   * services that need to validate a referenced venue id belongs to the
   * caller before using it (e.g. `SchedulingService.create` validating
   * `dto.venueId` isn't a guessed id pointing at another Manager's private
   * venue). Throws the identical 404 `get()` would.
   */
  async assertVenueAccessibleTx(manager: EntityManager, ctx: AuthContext, venueId: string): Promise<Venue> {
    const venue = await manager.findOne(Venue, { where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found.');
    await this.assertVenueOwnedOrAdmin(manager, ctx, venue);
    return venue;
  }

  list(ctx: AuthContext, pagination: PaginationDto = {}): Promise<Venue[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'admin') {
        return manager.find(Venue, { order: { name: 'ASC' }, ...paginationSkipTake(pagination) });
      }
      if (scope.kind === 'venue') {
        if (scope.venueIds.length === 0) return [];
        return manager.find(Venue, {
          where: { id: In(scope.venueIds) },
          order: { name: 'ASC' },
          ...paginationSkipTake(pagination),
        });
      }
      return manager.find(Venue, {
        where: { createdBy: ctx.userId },
        order: { name: 'ASC' },
        ...paginationSkipTake(pagination),
      });
    });
  }

  async get(ctx: AuthContext, id: string): Promise<Venue> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      await this.assertVenueOwnedOrAdmin(manager, ctx, venue);
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
      const venue = manager.create(Venue, { organisationId: ctx.organisationId!, createdBy: ctx.userId, ...dto });
      return manager.save(venue);
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateVenueDto): Promise<Venue> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      await this.assertVenueOwnedOrAdmin(manager, ctx, venue);
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
      await this.assertVenueOwnedOrAdmin(manager, ctx, venue);
      assertTransition(VENUE_TRANSITIONS, venue.status, VenueStatus.ARCHIVED);
      await manager.update(Venue, id, { status: VenueStatus.ARCHIVED });
      return manager.findOneByOrFail(Venue, { id });
    });
  }
}
