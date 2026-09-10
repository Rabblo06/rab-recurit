import { assertTransition, VENUE_TRANSITIONS, VenueStatus } from '@rab/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { toIlikePattern } from '../../../engine/utils/ilike-pattern.util';
import { CreateVenueDto } from '../dto/create-venue.dto';
import { ListVenuesDto } from '../dto/list-venues.dto';
import { UpdateVenueDto } from '../dto/update-venue.dto';
import { Venue } from '../entities/venue.entity';

/** Same allowlist-via-lookup-map pattern as `StaffService`'s `STAFF_SORT_COLUMNS` — see that file's comment. */
const VENUE_SORT_COLUMNS: Record<string, string> = {
  name: 'venue.name',
  createdAt: 'venue.createdAt',
};

@Injectable()
export class VenueService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
  ) {}

  /**
   * A normal Manager's private scope is "venues I created" — same shape as
   * `StaffService.assertOwned`/`SchedulingService.assertShiftOwned`.
   * A Venue Manager's scope is their explicitly assigned venues
   * (`ManagerVenue`), unaffected by ownership. Stage 2A Phase 2 retired the
   * platform-admin org-wide bypass this used to have — cross-Manager
   * visibility is available only through the audited Admin Inspect
   * mechanism, which rebinds `ctx.userId` to the inspected target so this
   * same check naturally resolves against the target's own scope. A
   * NULL-`createdBy` venue (predates this column, no recoverable creator)
   * stays invisible to everyone until reassigned — never guessed into a
   * Manager's scope.
   */
  private async assertVenueOwned(manager: EntityManager, ctx: AuthContext, venue: Venue): Promise<void> {
    const scope = await this.resourceScope.resolveTx(manager, ctx);
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
    await this.assertVenueOwned(manager, ctx, venue);
    return venue;
  }

  list(ctx: AuthContext, dto: ListVenuesDto = {}): Promise<{ data: Venue[]; total: number }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue' && scope.venueIds.length === 0) return { data: [], total: 0 };

      const qb = manager.createQueryBuilder(Venue, 'venue');
      if (scope.kind === 'venue') {
        qb.where('venue.id IN (:...venueIds)', { venueIds: scope.venueIds });
      } else {
        qb.where('venue.createdBy = :createdBy', { createdBy: ctx.userId });
      }

      if (dto.q) {
        // `address` is jsonb (no fixed `city` column) — City is a search
        // target here, not a dedicated filter dropdown, since it has no
        // fixed enum of values to select from the way Status/Type do.
        qb.andWhere(
          "(venue.name ILIKE :q OR venue.clientName ILIKE :q OR venue.address->>'city' ILIKE :q)",
          { q: toIlikePattern(dto.q) },
        );
      }
      if (dto.status) qb.andWhere('venue.status = :status', { status: dto.status });
      if (dto.type) qb.andWhere('venue.type = :type', { type: dto.type });

      const sortColumn = VENUE_SORT_COLUMNS[dto.sort ?? 'name'] ?? VENUE_SORT_COLUMNS.name;
      qb.orderBy(sortColumn, (dto.direction ?? 'asc').toUpperCase() as 'ASC' | 'DESC');

      const { skip, take } = paginationSkipTake(dto);
      qb.skip(skip).take(take);

      const [data, total] = await qb.getManyAndCount();
      return { data, total };
    });
  }

  async get(ctx: AuthContext, id: string): Promise<Venue> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      await this.assertVenueOwned(manager, ctx, venue);
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
    this.resourceScope.assertHasWorkspace(ctx);
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // .create()/.save() rather than .insert() — TypeORM's insert() query
      // builder types jsonb columns through _QueryDeepPartialEntity, which
      // doesn't accept a plain Record<string, unknown> object literal.
      const venue = manager.create(Venue, {
        organisationId: ctx.organisationId!,
        createdBy: ctx.userId,
        workspaceId: ctx.workspaceId ?? undefined,
        ...dto,
      });
      return manager.save(venue);
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateVenueDto): Promise<Venue> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      await this.assertVenueOwned(manager, ctx, venue);
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
      await this.assertVenueOwned(manager, ctx, venue);
      assertTransition(VENUE_TRANSITIONS, venue.status, VenueStatus.ARCHIVED);
      await manager.update(Venue, id, { status: VenueStatus.ARCHIVED });
      return manager.findOneByOrFail(Venue, { id });
    });
  }
}
