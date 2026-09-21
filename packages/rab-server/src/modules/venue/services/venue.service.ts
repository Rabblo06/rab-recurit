import { assertTransition, VENUE_TRANSITIONS, VenueStatus } from '@rab/shared';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { toIlikePattern } from '../../../engine/utils/ilike-pattern.util';
import { JobRole } from '../../scheduling/entities/job-role.entity';
import { VenueRoleRate } from '../../scheduling/entities/venue-role-rate.entity';
import { CreateVenueDto } from '../dto/create-venue.dto';
import { CreateVenueRoleRateDto } from '../dto/create-venue-role-rate.dto';
import { ListVenuesDto } from '../dto/list-venues.dto';
import { UpdateVenueDto } from '../dto/update-venue.dto';
import { UpdateVenueRoleRateDto } from '../dto/update-venue-role-rate.dto';
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
    private readonly auditService: AuditService,
  ) {}

  /**
   * Cross-field geofence rules the per-field DTO validators can't express —
   * the server is authoritative, the web form's own checks are only UX.
   * `state` is the FINAL effective config (stored values merged with the
   * incoming change), so an update that would leave enforcement on with no
   * usable location is rejected even if that request never mentioned it.
   * Rules: lat and lng are set together or not at all; enforcement needs
   * both plus a radius >= 50m.
   */
  private assertGeofenceConfig(state: {
    lat?: number | null;
    lng?: number | null;
    geofenceRadiusM?: number | null;
    enforceGeofence?: boolean;
  }): void {
    const hasLat = state.lat != null;
    const hasLng = state.lng != null;
    if (hasLat !== hasLng) {
      throw new BadRequestException('Latitude and longitude must be set together.');
    }
    if (!state.enforceGeofence) return;
    if (!hasLat || !hasLng) {
      throw new BadRequestException('Set the venue latitude and longitude before enabling geofence enforcement.');
    }
    if (state.geofenceRadiusM == null || state.geofenceRadiusM < 50) {
      throw new BadRequestException('Geofence enforcement requires a radius of at least 50 metres.');
    }
  }

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
    // On create the radius must be explicit when enforcing — the column's
    // 200m default is fine for a venue that isn't enforced yet, but a Manager
    // turning enforcement on at creation must consciously choose the radius.
    if (dto.enforceGeofence && dto.geofenceRadiusM === undefined) {
      throw new BadRequestException('Geofence enforcement requires a radius of at least 50 metres.');
    }
    this.assertGeofenceConfig({ ...dto, geofenceRadiusM: dto.geofenceRadiusM ?? 200 });
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
      const before = {
        lat: venue.lat ?? null,
        lng: venue.lng ?? null,
        geofenceRadiusM: venue.geofenceRadiusM,
        enforceGeofence: venue.enforceGeofence,
      };
      const after = {
        lat: dto.lat !== undefined ? dto.lat : before.lat,
        lng: dto.lng !== undefined ? dto.lng : before.lng,
        geofenceRadiusM: dto.geofenceRadiusM ?? before.geofenceRadiusM,
        enforceGeofence: dto.enforceGeofence ?? before.enforceGeofence,
      };
      this.assertGeofenceConfig(after);
      manager.merge(Venue, venue, dto);
      await manager.save(venue);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await this.auditService.record(manager, ctx, AuditAction.VENUE_GEOFENCE_UPDATED, {
          entityType: 'venue',
          entityId: id,
          metadata: { before, after },
        });
      }
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

  /**
   * Venue-level Pay Details — `VenueRoleRate` already existed as a schema
   * (RLS included) but had no service/endpoint reading or writing it before
   * this. `venueId` always comes from `assertVenueAccessibleTx` re-checking
   * the caller's own scope, never trusted bare off the URL/body.
   */
  async listRoleRates(ctx: AuthContext, venueId: string): Promise<VenueRoleRate[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertVenueAccessibleTx(manager, ctx, venueId);
      return manager.find(VenueRoleRate, { where: { venueId }, order: { createdAt: 'ASC' } });
    });
  }

  async createRoleRate(ctx: AuthContext, venueId: string, dto: CreateVenueRoleRateDto): Promise<VenueRoleRate> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const venue = await this.assertVenueAccessibleTx(manager, ctx, venueId);
      const role = await manager.findOne(JobRole, { where: { id: dto.jobRoleId } });
      if (!role) throw new NotFoundException('Job role not found.');
      const rate = manager.create(VenueRoleRate, {
        organisationId: ctx.organisationId!,
        venueId,
        workspaceId: venue.workspaceId,
        jobRoleId: dto.jobRoleId,
        payRatePence: dto.payRatePence,
        chargeRatePence: dto.chargeRatePence ?? 0,
        overtimeMultiplier: dto.overtimeMultiplier ?? 1,
        effectiveFrom: dto.effectiveFrom ?? new Date().toISOString().slice(0, 10),
        effectiveTo: dto.effectiveTo,
      });
      return manager.save(rate);
    });
  }

  async updateRoleRate(
    ctx: AuthContext,
    venueId: string,
    rateId: string,
    dto: UpdateVenueRoleRateDto,
  ): Promise<VenueRoleRate> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertVenueAccessibleTx(manager, ctx, venueId);
      const rate = await manager.findOne(VenueRoleRate, { where: { id: rateId, venueId } });
      if (!rate) throw new NotFoundException('Pay rate not found.');
      manager.merge(VenueRoleRate, rate, dto);
      await manager.save(rate);
      return manager.findOneByOrFail(VenueRoleRate, { id: rateId });
    });
  }

  async deleteRoleRate(ctx: AuthContext, venueId: string, rateId: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertVenueAccessibleTx(manager, ctx, venueId);
      const rate = await manager.findOne(VenueRoleRate, { where: { id: rateId, venueId } });
      if (!rate) throw new NotFoundException('Pay rate not found.');
      await manager.remove(rate);
    });
  }
}
