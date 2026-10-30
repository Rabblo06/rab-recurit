import { ARCHIVE_TRANSITIONS, ArchiveState, archiveStateOf, assertTransition, PermissionFlag, VENUE_TRANSITIONS, VenueStatus } from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { CoreEntityCacheService } from '../../../engine/core-modules/entity-cache/core-entity-cache.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { FileKind } from '../../../engine/core-modules/storage/file-kinds';
import { FileService } from '../../../engine/core-modules/storage/file.service';
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
import { MemberAccessPolicyService } from '../../identity/member-access/member-access-policy.service';

/** Same allowlist-via-lookup-map pattern as `StaffService`'s `STAFF_SORT_COLUMNS` — see that file's comment. */
const VENUE_SORT_COLUMNS: Record<string, string> = {
  name: 'venue.name',
  createdAt: 'venue.createdAt',
};

@Injectable()
export class VenueService {
  @Inject(MemberAccessPolicyService)
  private readonly memberAccess!: MemberAccessPolicyService;

  @Inject(PermissionsService)
  private readonly permissions!: PermissionsService;

  @Inject(FileService)
  private readonly fileService!: FileService;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
    private readonly auditService: AuditService,
    private readonly entityCache: CoreEntityCacheService,
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
  /**
   * Wave 5: NEW work (a shift, a shift request) is never created at an archived venue — restore it first. 409, not
   * 404: the caller already passed the venue's scope check, so its existence is not a disclosure.
   */
  assertVenueNotArchived(venue: Venue): void {
    if (venue.status === VenueStatus.ARCHIVED || venue.archivedAt) {
      throw new ConflictException({ code: 'VENUE_ARCHIVED', message: 'This venue is archived. Restore it before scheduling new shifts.' });
    }
  }

  async assertVenueAccessibleTx(manager: EntityManager, ctx: AuthContext, venueId: string): Promise<Venue> {
    const venue = await manager.findOne(Venue, { where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found.');
    await this.assertVenueOwned(manager, ctx, venue);
    return venue;
  }

  /**
   * Layers: route PermissionGuard(VENUE_VIEW) → this service re-checks VENUE_VIEW in the same tenant transaction (jobs,
   * CLI commands and other services never pass the guard; LAYER2_HARDENING_2026-10-25 F1) → owner / assigned-venue
   * scope → member role policy → workspace RLS. A caller without VENUE_VIEW gets the guard's own answer (403, a
   * categorical lack — CLAUDE.md), checked before any row is read, so it is never an existence oracle.
   */
  list(ctx: AuthContext, dto: ListVenuesDto = {}): Promise<{ data: Venue[]; total: number }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertCanViewVenueTx(manager, ctx);
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue' && scope.venueIds.length === 0) return { data: [], total: 0 };

      const qb = manager.createQueryBuilder(Venue, 'venue');
      if (scope.kind === 'venue') {
        qb.where('venue.id IN (:...venueIds)', { venueIds: scope.venueIds });
      } else {
        // ownerUserId is the caller themselves, or — for a custom workspace-member only — their workspace's owner.
        qb.where('venue.createdBy = :createdBy', { createdBy: scope.ownerUserId });
      }
      // Custom workspace-members: object / field / record-level role policy on top of the owner scope (no-op for others).
      const policy = await this.memberAccess.resolveTx(manager, ctx, 'venue');
      this.memberAccess.assertCanRead(policy);
      const visible = (field: string) => this.memberAccess.isFieldVisible(policy, field);
      const recordFilter = this.memberAccess.qbWhere(policy, 'venue');
      qb.andWhere(recordFilter.sql, recordFilter.named);

      if (dto.q) {
        // `address` is jsonb (no fixed `city` column) — City is a search
        // target here, not a dedicated filter dropdown, since it has no
        // fixed enum of values to select from the way Status/Type do.
        // Hidden fields are never search targets (no probing through matches).
        const targets = ['venue.name ILIKE :q'];
        if (visible('clientName')) targets.push('venue.clientName ILIKE :q');
        if (visible('address')) targets.push("venue.address->>'city' ILIKE :q");
        qb.andWhere(`(${targets.join(' OR ')})`, { q: toIlikePattern(dto.q) });
      }
      if (dto.status) qb.andWhere('venue.status = :status', { status: dto.status });
      // Wave 5: archived venues are hidden from the list unless asked for ("Show archived", or an explicit
      // status=archived filter). `status` stays the venue's source of truth (pre-wave-5 archives have no archived_at).
      if (!dto.includeArchived && dto.status !== VenueStatus.ARCHIVED) {
        qb.andWhere('venue.status <> :archivedStatus AND venue.archivedAt IS NULL', { archivedStatus: VenueStatus.ARCHIVED });
      }
      if (dto.type && visible('type')) qb.andWhere('venue.type = :type', { type: dto.type });

      const sortColumn = VENUE_SORT_COLUMNS[dto.sort ?? 'name'] ?? VENUE_SORT_COLUMNS.name;
      qb.orderBy(sortColumn, (dto.direction ?? 'asc').toUpperCase() as 'ASC' | 'DESC');

      const { skip, take } = paginationSkipTake(dto);
      qb.skip(skip).take(take);

      const [data, total] = await qb.getManyAndCount();
      return { data: data.map((venue) => this.memberAccess.project(policy, venue)), total };
    }, { useReplica: true });
  }

  /** Same layers as `list()`: VENUE_VIEW re-checked first (403, for any id, before the row is loaded), then 404 out of scope. */
  async get(ctx: AuthContext, id: string): Promise<Venue> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertCanViewVenueTx(manager, ctx);
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      await this.assertVenueReadable(manager, ctx, venue);
      const policy = await this.memberAccess.resolveTx(manager, ctx, 'venue');
      if (policy.restricted) {
        // Outside the member's role (object denied or excluded by a record filter) ⇒ 404, never 403.
        if (!policy.canRead) throw new NotFoundException('Venue not found.');
        const recordFilter = this.memberAccess.qbWhere(policy, 'venue');
        const inScope = await manager.createQueryBuilder(Venue, 'venue').where('venue.id = :id', { id: venue.id }).andWhere(recordFilter.sql, recordFilter.named).getExists();
        if (!inScope) throw new NotFoundException('Venue not found.');
      }
      return this.memberAccess.project(policy, venue);
    });
  }

  /**
   * READ-only variant of `assertVenueOwned`: identical, plus one branch for a custom workspace-member, who may read
   * the venues their workspace OWNER created (creator-based ownership is unchanged — the record still belongs to
   * that Manager). Never used on a write path; writes stay on `assertVenueOwned` (the caller's own `created_by`).
   */
  private async assertVenueReadable(manager: EntityManager, ctx: AuthContext, venue: Venue): Promise<void> {
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (scope.kind === 'owner' && scope.delegated && venue.createdBy === scope.ownerUserId) return;
    await this.assertVenueOwned(manager, ctx, venue);
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
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
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
    const result = await this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
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
    await this.entityCache.invalidate('venue', id);
    return result;
  }

  // ------------------------------------------------------------------ profile photo

  /**
   * Sets the venue's profile photo: store-new -> swap `photo_file_id` -> tombstone-old, one transaction, mirroring
   * `VenueManagerService.uploadAvatar`. Layer 2 of the five: the route's PermissionGuard(VENUE_EDIT) is re-checked here
   * (jobs/other services never pass the guard), then the SAME write-scope rule `update()` uses (`assertVenueOwned`:
   * the creator, or a Venue Manager's assigned venue) — anything else is 404. organisationId/workspaceId of the stored
   * file come from the verified context, never from the request; the file is workspace-bound so stored_file RLS
   * (layer 4) confines it to this workspace. Content type and the 5 MB limit are re-decided from the bytes by
   * `FileService.validateContent`, whatever the client claimed.
   */
  async uploadPhoto(ctx: AuthContext, id: string, buffer: Buffer): Promise<{ photoFileId: string }> {
    this.resourceScope.assertHasWorkspace(ctx);
    const result = await this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertCanEditVenueTx(manager, ctx);
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      await this.assertVenueOwned(manager, ctx, venue);
      const before = venue.photoFileId ?? null;
      const file = await this.fileService.store(manager, {
        kind: FileKind.VENUE_PHOTO,
        organisationId: ctx.organisationId!,
        workspaceId: ctx.workspaceId!,
        resourceType: 'venue',
        resourceId: venue.id,
        buffer,
        createdBy: ctx.userId,
      });
      await manager.update(Venue, venue.id, { photoFileId: file.id });
      await this.retirePhoto(manager, before);
      await this.auditService.record(manager, ctx, AuditAction.FILE_UPLOADED, {
        entityType: 'stored_file',
        entityId: file.id,
        metadata: { kind: file.kind, sizeBytes: file.sizeBytes },
      });
      await this.auditService.record(manager, ctx, AuditAction.VENUE_PHOTO_UPDATED, {
        entityType: 'venue',
        entityId: venue.id,
        metadata: { fields: ['photo'], previousFileId: before, fileId: file.id },
      });
      return { photoFileId: file.id };
    });
    await this.entityCache.invalidate('venue', id);
    return result;
  }

  /** Clears the venue's photo and tombstones the file. Same layer-2 checks as `uploadPhoto`; idempotent when there is no photo. */
  async removePhoto(ctx: AuthContext, id: string): Promise<{ photoFileId: null }> {
    this.resourceScope.assertHasWorkspace(ctx);
    const result = await this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertCanEditVenueTx(manager, ctx);
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      await this.assertVenueOwned(manager, ctx, venue);
      const before = venue.photoFileId ?? null;
      if (before) {
        await manager.update(Venue, venue.id, { photoFileId: null });
        await this.retirePhoto(manager, before);
        await this.auditService.record(manager, ctx, AuditAction.VENUE_PHOTO_UPDATED, {
          entityType: 'venue',
          entityId: venue.id,
          metadata: { fields: ['photo'], previousFileId: before, fileId: null },
        });
      }
      return { photoFileId: null };
    });
    await this.entityCache.invalidate('venue', id);
    return result as { photoFileId: null };
  }

  /**
   * Read rule for a VENUE_PHOTO file, for a MANAGER-application caller (web console or Venue Manager app). True only
   * when `GET /venues/:id` would return that venue to this caller: VENUE_VIEW, the same owner/assigned/delegated
   * visibility (`assertVenueReadable`), and — for a custom workspace member — the role's object + record filter.
   * Never throws for "not visible": the file layer answers 404 for every false.
   */
  async canViewVenueTx(manager: EntityManager, ctx: AuthContext, venue: Venue): Promise<boolean> {
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.VENUE_VIEW))) return false;
    try {
      await this.assertVenueReadable(manager, ctx, venue);
    } catch (error) {
      if (error instanceof NotFoundException) return false;
      throw error;
    }
    const policy = await this.memberAccess.resolveTx(manager, ctx, 'venue');
    if (!policy.restricted) return true;
    if (!policy.canRead) return false;
    const recordFilter = this.memberAccess.qbWhere(policy, 'venue');
    return manager.createQueryBuilder(Venue, 'venue').where('venue.id = :id', { id: venue.id }).andWhere(recordFilter.sql, recordFilter.named).getExists();
  }

  /**
   * Layer 2 for venue READS (`list`, `get`): the route's PermissionGuard(VENUE_VIEW), re-checked in the caller's own
   * tenant transaction. 403 like the guard (and like `assertCanEditVenueTx` below) — the guard runs first on HTTP, so
   * the response there is unchanged; this only ever answers a direct service caller.
   */
  private async assertCanViewVenueTx(manager: EntityManager, ctx: AuthContext): Promise<void> {
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.VENUE_VIEW))) {
      throw new ForbiddenException('Viewing venues is not permitted.');
    }
  }

  private async assertCanEditVenueTx(manager: EntityManager, ctx: AuthContext): Promise<void> {
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.VENUE_EDIT))) {
      throw new ForbiddenException('Editing venues is not permitted.');
    }
  }

  /** Tombstones the replaced photo (row kept as DELETED, object purged later by `storage:reconcile`), as `retireAvatar` does. */
  private async retirePhoto(manager: EntityManager, fileId: string | null): Promise<void> {
    if (!fileId) return;
    const file = await manager.findOne(StoredFile, { where: { id: fileId } });
    if (file) await this.fileService.tombstone(manager, file, { removeObject: false });
  }

  /**
   * Named action `archiveVenue`. Venues are archived, never deleted — matches rab-workforce-architecture.md's
   * venue-deletion edge case (§13). Layers: route PermissionGuard(VENUE_EDIT) → this service re-checks VENUE_EDIT
   * (jobs / other services never pass the guard) → write scope `assertVenueOwned` (creator, or a Venue Manager's
   * assigned venue; 404 otherwise, including another workspace's or organisation's venue) → workspace RLS. The status
   * transition AND the archive state are both validated (`VENUE_TRANSITIONS`, `ARCHIVE_TRANSITIONS`): archiving an
   * archived venue is a 409. `archived_at`/`archived_by` move in the same UPDATE, with an audit row in the same
   * transaction. Historical reads (shifts, attendance, payslips, `GET /venues/:id`) still resolve the venue.
   */
  async archive(ctx: AuthContext, id: string): Promise<Venue> {
    const result = await this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertCanEditVenueTx(manager, ctx);
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      await this.assertVenueOwned(manager, ctx, venue);
      assertTransition(VENUE_TRANSITIONS, venue.status, VenueStatus.ARCHIVED);
      assertTransition(ARCHIVE_TRANSITIONS, archiveStateOf(venue.archivedAt), ArchiveState.ARCHIVED);
      await manager.update(Venue, id, { status: VenueStatus.ARCHIVED, archivedAt: () => 'now()', archivedBy: ctx.userId } as never);
      await this.auditService.record(manager, ctx, AuditAction.VENUE_ARCHIVED, { entityType: 'venue', entityId: id, metadata: { name: venue.name } });
      return manager.findOneByOrFail(Venue, { id });
    });
    await this.entityCache.invalidate('venue', id);
    return result;
  }

  /**
   * Named action `restoreVenue` — the only path back from archived (same five layers as `archive`). Venues have no
   * unique constraint (ArchiveAndSearchSchema contract §3), so a restore cannot conflict; a venue archived before the
   * archive columns existed (`status = 'archived'`, `archived_at IS NULL`) is restorable too.
   */
  async restore(ctx: AuthContext, id: string): Promise<Venue> {
    const result = await this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertCanEditVenueTx(manager, ctx);
      const venue = await manager.findOne(Venue, { where: { id } });
      if (!venue) throw new NotFoundException('Venue not found.');
      await this.assertVenueOwned(manager, ctx, venue);
      assertTransition(VENUE_TRANSITIONS, venue.status, VenueStatus.ACTIVE);
      await manager.update(Venue, id, { status: VenueStatus.ACTIVE, archivedAt: null, archivedBy: null });
      await this.auditService.record(manager, ctx, AuditAction.VENUE_RESTORED, { entityType: 'venue', entityId: id, metadata: { name: venue.name } });
      return manager.findOneByOrFail(Venue, { id });
    });
    await this.entityCache.invalidate('venue', id);
    return result;
  }

  /**
   * Venue-level Pay Details — `VenueRoleRate` already existed as a schema
   * (RLS included) but had no service/endpoint reading or writing it before
   * this. `venueId` always comes from `assertVenueAccessibleTx` re-checking
   * the caller's own scope, never trusted bare off the URL/body.
   */
  async listRoleRates(ctx: AuthContext, venueId: string): Promise<VenueRoleRate[]> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertVenueAccessibleTx(manager, ctx, venueId);
      return manager.find(VenueRoleRate, { where: { venueId }, order: { createdAt: 'ASC' } });
    });
  }

  async createRoleRate(ctx: AuthContext, venueId: string, dto: CreateVenueRoleRateDto): Promise<VenueRoleRate> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
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
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertVenueAccessibleTx(manager, ctx, venueId);
      const rate = await manager.findOne(VenueRoleRate, { where: { id: rateId, venueId } });
      if (!rate) throw new NotFoundException('Pay rate not found.');
      manager.merge(VenueRoleRate, rate, dto);
      await manager.save(rate);
      return manager.findOneByOrFail(VenueRoleRate, { id: rateId });
    });
  }

  async deleteRoleRate(ctx: AuthContext, venueId: string, rateId: string): Promise<void> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertVenueAccessibleTx(manager, ctx, venueId);
      const rate = await manager.findOne(VenueRoleRate, { where: { id: rateId, venueId } });
      if (!rate) throw new NotFoundException('Pay rate not found.');
      await manager.remove(rate);
    });
  }
}
