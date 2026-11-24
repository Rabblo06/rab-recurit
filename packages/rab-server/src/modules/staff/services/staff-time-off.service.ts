import {
  assertTransition,
  PermissionFlag,
  STAFF_TIME_OFF_MAX_DAYS,
  STAFF_TIME_OFF_TRANSITIONS,
  StaffTimeOffStatus,
  StaffTimeOffStatusType,
} from '@rab/shared';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';

import {
  AuditAction,
  AuditActionType,
  AuditService,
} from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import {
  PaginationDto,
  paginationSkipTake,
} from '../../../engine/dto/pagination.dto';
import {
  CreateStaffTimeOffDto,
  DeclineTimeOffDto,
  ListTimeOffDto,
  RequestTimeOffDto,
} from '../dto/staff-time-off.dto';
import { StaffProfile } from '../entities/staff-profile.entity';
import { StaffTimeOff } from '../entities/staff-time-off.entity';
import { StaffService } from './staff.service';
import { organisationToday } from './staff-time-off-check';

/**
 * Permission flags (existing flags only, so no permission migration — FLAGGED for the owner):
 *   - a manager READS time off with staff.view (who is available is part of the staff record);
 *   - a manager DECIDES or ENTERS time off with staff.edit (it changes which offers a staff member can receive);
 *   - a staff member's own requests use offer.respond, the staff-only self-service flag of the offers they receive
 *     (held by the system `staff` role alone; managers and Venue Managers do not hold it), plus their own staff profile in
 *     the bound workspace.
 */
export const TIME_OFF_MANAGER_READ_FLAG = PermissionFlag.STAFF_VIEW;
export const TIME_OFF_MANAGER_WRITE_FLAG = PermissionFlag.STAFF_EDIT;
export const TIME_OFF_STAFF_FLAG = PermissionFlag.OFFER_RESPOND;

export const TIME_OFF_NOT_FOUND = 'Time off not found.';
export const TIME_OFF_OVERLAP_MESSAGE =
  'This staff member already has approved time off that overlaps these dates.';

/** What the API returns: no tenant columns, no staff user id. Dates are organisation-local `YYYY-MM-DD`, both inclusive. */
export interface StaffTimeOffView {
  id: string;
  staffProfileId: string;
  startsOn: string;
  endsOn: string;
  status: StaffTimeOffStatusType;
  note: string | null;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  declineReason: string | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StaffTimeOffPage {
  data: StaffTimeOffView[];
  total: number;
}

/**
 * Date-specific staff time off (core.staff_time_off, StaffTimeOffSchema1786722230000; owner decisions 42, 48). Staff request
 * time off and cancel their own request; a manager approves, declines, cancels approved time off or enters approved time off
 * directly. APPROVED time off is a hard block on new offers (staff-time-off-check.ts), never here.
 *
 * Five layers on every call (CLAUDE.md):
 *   1. route PermissionGuard (StaffTimeOffController / MyTimeOffController): staff.view, staff.edit or offer.respond;
 *   2. the SAME flag re-checked here, first, inside the tenant transaction — 403 before any id is read (jobs, CLI and other
 *      services never pass the guard);
 *   3. scope: a manager reaches only staff they created (StaffService.findOwnedProfileTx, strict write-path scope) in the
 *      session's organisation and workspace; a staff member reaches only rows of their own profile and user id — 404, never
 *      403, for anything outside;
 *   4. RLS tenant predicate (organisation + workspace of the session, never a client value);
 *   5. RLS second predicate: a non-venue manager of the workspace (never on their own row) or the staff member themselves,
 *      per command (see core/staff-time-off-sql.ts).
 * Status changes are named actions validated by assertTransition(STAFF_TIME_OFF_TRANSITIONS) (409 otherwise) and written as a
 * compare-and-set on the expected previous status, so two concurrent decisions cannot both win. Every write records one
 * `staff_time_off.*` audit row in the same transaction: ids and dates only — never the note or the decline reason.
 * Time off is never deleted (no DELETE grant): it is declined or cancelled.
 */
@Injectable()
export class StaffTimeOffService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly auditService: AuditService,
    private readonly staffService: StaffService,
  ) {}

  // ------------------------------------------------------------------------------------------------ staff (self-service)

  async listMine(
    ctx: AuthContext,
    page: PaginationDto = {},
  ): Promise<StaffTimeOffPage> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertStaffTx(manager, ctx);
      const profile = await ownProfile(manager, ctx);
      const { workspaceId } = await boundTenant(manager);
      const { skip, take } = paginationSkipTake(page);
      const [rows, total] = await manager.findAndCount(StaffTimeOff, {
        where: {
          staffProfileId: profile.id,
          staffUserId: ctx.userId,
          workspaceId,
        },
        order: { startsOn: 'DESC', createdAt: 'DESC' },
        skip,
        take,
      });
      return { data: rows.map(toView), total };
    });
  }

  async request(
    ctx: AuthContext,
    dto: RequestTimeOffDto,
  ): Promise<StaffTimeOffView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertStaffTx(manager, ctx);
      const profile = await ownProfile(manager, ctx);
      assertRange(dto.startsOn, dto.endsOn, await organisationToday(manager));
      const { organisationId, workspaceId } = await boundTenant(manager);
      const saved = await manager.save(
        manager.create(StaffTimeOff, {
          organisationId,
          workspaceId,
          staffProfileId: profile.id,
          staffUserId: ctx.userId,
          startsOn: dto.startsOn,
          endsOn: dto.endsOn,
          status: StaffTimeOffStatus.REQUESTED,
          note: emptyToNull(dto.note),
          requestedBy: ctx.userId,
        }),
      );
      await this.audit(
        manager,
        ctx,
        AuditAction.STAFF_TIME_OFF_REQUESTED,
        saved,
        ctx.userId,
      );
      return toView(saved);
    });
  }

  /** A staff member withdraws their OWN request while it is still `requested` (approved time off: ask a manager). */
  async cancelMine(ctx: AuthContext, id: string): Promise<StaffTimeOffView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertStaffTx(manager, ctx);
      const profile = await ownProfile(manager, ctx);
      const { workspaceId } = await boundTenant(manager);
      const row = await manager.findOne(StaffTimeOff, {
        where: {
          id,
          staffProfileId: profile.id,
          staffUserId: ctx.userId,
          workspaceId,
        },
      });
      if (!row) throw new NotFoundException(TIME_OFF_NOT_FOUND);
      if (row.status === StaffTimeOffStatus.APPROVED) {
        throw new ConflictException({
          statusCode: 409,
          code: 'TIME_OFF_APPROVED',
          message: 'Approved time off can only be cancelled by a manager.',
        });
      }
      assertTransition(
        STAFF_TIME_OFF_TRANSITIONS,
        row.status,
        StaffTimeOffStatus.CANCELLED,
      );
      const updated = await this.transition(manager, row, {
        status: StaffTimeOffStatus.CANCELLED,
        cancelledBy: ctx.userId,
        cancelledAt: () => 'now()',
      });
      await this.audit(
        manager,
        ctx,
        AuditAction.STAFF_TIME_OFF_CANCELLED,
        updated,
        ctx.userId,
        row.status,
      );
      return toView(updated);
    });
  }

  // ------------------------------------------------------------------------------------------------ managers

  /** The workspace list: time off of the staff the caller manages, optionally one status, newest range first. */
  async listWorkspace(
    ctx: AuthContext,
    dto: ListTimeOffDto = {},
  ): Promise<StaffTimeOffPage> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.permissions.assertPermissionTx(
        manager,
        ctx,
        TIME_OFF_MANAGER_READ_FLAG,
        'Viewing time off is not permitted.',
      );
      const { organisationId, workspaceId } = await boundTenant(manager);
      const { skip, take } = paginationSkipTake(dto);
      const qb = manager
        .createQueryBuilder(StaffTimeOff, 't')
        .innerJoin(StaffProfile, 'sp', 'sp.id = t.staffProfileId')
        .where('t.organisationId = :organisationId', { organisationId })
        .andWhere('t.workspaceId = :workspaceId', { workspaceId })
        .andWhere('sp.organisationId = :organisationId', { organisationId })
        .andWhere('sp.userId = t.staffUserId')
        // Scope (layer 3): the staff the caller created, the strict rule of StaffService.findOwnedProfileTx.
        .andWhere('sp.createdBy = :me', { me: ctx.userId });
      if (dto.status) qb.andWhere('t.status = :status', { status: dto.status });
      const [rows, total] = await qb
        .orderBy('t.startsOn', 'DESC')
        .addOrderBy('t.createdAt', 'DESC')
        .addOrderBy('t.id', 'ASC')
        // The join is one profile per row (no fan-out), so a plain OFFSET / LIMIT pages it exactly.
        .offset(skip)
        .limit(take)
        .getManyAndCount();
      return { data: rows.map(toView), total };
    });
  }

  async listForStaff(
    ctx: AuthContext,
    staffProfileId: string,
    page: PaginationDto = {},
  ): Promise<StaffTimeOffPage> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.permissions.assertPermissionTx(
        manager,
        ctx,
        TIME_OFF_MANAGER_READ_FLAG,
        'Viewing time off is not permitted.',
      );
      const profile = await this.staffInScope(manager, ctx, staffProfileId);
      const { workspaceId } = await boundTenant(manager);
      const { skip, take } = paginationSkipTake(page);
      const [rows, total] = await manager.findAndCount(StaffTimeOff, {
        where: {
          staffProfileId: profile.id,
          staffUserId: profile.userId,
          workspaceId,
        },
        order: { startsOn: 'DESC', createdAt: 'DESC' },
        skip,
        take,
      });
      return { data: rows.map(toView), total };
    });
  }

  /** Manager-entered time off: approved at once, requested and decided by the caller (decision 42: a manager approves). */
  async enter(
    ctx: AuthContext,
    staffProfileId: string,
    dto: CreateStaffTimeOffDto,
  ): Promise<StaffTimeOffView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertManagerWriteTx(manager, ctx);
      const profile = await this.staffInScope(manager, ctx, staffProfileId);
      assertNotSelf(ctx, profile.userId);
      assertRange(dto.startsOn, dto.endsOn, await organisationToday(manager));
      const { organisationId, workspaceId } = await boundTenant(manager);
      const row = manager.create(StaffTimeOff, {
        organisationId,
        workspaceId,
        staffProfileId: profile.id,
        staffUserId: profile.userId,
        startsOn: dto.startsOn,
        endsOn: dto.endsOn,
        status: StaffTimeOffStatus.APPROVED,
        note: emptyToNull(dto.note),
        requestedBy: ctx.userId,
        decidedBy: ctx.userId,
        decidedAt: new Date(),
      });
      const saved = await writing(() => manager.save(row));
      await this.audit(
        manager,
        ctx,
        AuditAction.STAFF_TIME_OFF_ENTERED,
        saved,
        profile.userId,
      );
      return toView(saved);
    });
  }

  async approve(ctx: AuthContext, id: string): Promise<StaffTimeOffView> {
    return this.decide(ctx, id, StaffTimeOffStatus.APPROVED);
  }

  async decline(
    ctx: AuthContext,
    id: string,
    dto: DeclineTimeOffDto,
  ): Promise<StaffTimeOffView> {
    const reason = (dto.reason ?? '').trim();
    if (!reason) throw new BadRequestException('A reason is required.');
    return this.decide(ctx, id, StaffTimeOffStatus.DECLINED, reason);
  }

  /** A manager cancels APPROVED time off (a request is declined instead, so the staff member sees why). */
  async cancel(ctx: AuthContext, id: string): Promise<StaffTimeOffView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertManagerWriteTx(manager, ctx);
      const { row, profile } = await this.rowInScope(manager, ctx, id);
      assertNotSelf(ctx, profile.userId);
      if (row.status === StaffTimeOffStatus.REQUESTED) {
        throw new ConflictException({
          statusCode: 409,
          code: 'TIME_OFF_NOT_APPROVED',
          message: 'Decline a time-off request instead of cancelling it.',
        });
      }
      assertTransition(
        STAFF_TIME_OFF_TRANSITIONS,
        row.status,
        StaffTimeOffStatus.CANCELLED,
      );
      const updated = await this.transition(manager, row, {
        status: StaffTimeOffStatus.CANCELLED,
        cancelledBy: ctx.userId,
        cancelledAt: () => 'now()',
      });
      await this.audit(
        manager,
        ctx,
        AuditAction.STAFF_TIME_OFF_CANCELLED,
        updated,
        profile.userId,
        row.status,
      );
      return toView(updated);
    });
  }

  private async decide(
    ctx: AuthContext,
    id: string,
    to: typeof StaffTimeOffStatus.APPROVED | typeof StaffTimeOffStatus.DECLINED,
    declineReason?: string,
  ): Promise<StaffTimeOffView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertManagerWriteTx(manager, ctx);
      const { row, profile } = await this.rowInScope(manager, ctx, id);
      assertNotSelf(ctx, profile.userId);
      assertTransition(STAFF_TIME_OFF_TRANSITIONS, row.status, to);
      const updated = await writing(() =>
        this.transition(manager, row, {
          status: to,
          decidedBy: ctx.userId,
          decidedAt: () => 'now()',
          declineReason:
            to === StaffTimeOffStatus.DECLINED ? declineReason! : null,
        }),
      );
      await this.audit(
        manager,
        ctx,
        to === StaffTimeOffStatus.APPROVED
          ? AuditAction.STAFF_TIME_OFF_APPROVED
          : AuditAction.STAFF_TIME_OFF_DECLINED,
        updated,
        profile.userId,
        row.status,
      );
      return toView(updated);
    });
  }

  // ------------------------------------------------------------------------------------------------ helpers

  /** Layer 2 for staff self-service: offer.respond, before any read (403, a categorical lack). */
  private async assertStaffTx(
    manager: EntityManager,
    ctx: AuthContext,
  ): Promise<void> {
    await this.permissions.assertPermissionTx(
      manager,
      ctx,
      TIME_OFF_STAFF_FLAG,
      'Requesting time off is not permitted.',
    );
  }

  /** Layer 2 for manager writes: staff.edit, before any read. */
  private async assertManagerWriteTx(
    manager: EntityManager,
    ctx: AuthContext,
  ): Promise<void> {
    await this.permissions.assertPermissionTx(
      manager,
      ctx,
      TIME_OFF_MANAGER_WRITE_FLAG,
      'Changing time off is not permitted.',
    );
  }

  /** Layer 3: StaffService's strict scope, and the profile must belong to the session's workspace (404 otherwise). */
  private async staffInScope(
    manager: EntityManager,
    ctx: AuthContext,
    staffProfileId: string,
  ): Promise<StaffProfile> {
    const profile = await this.staffService.findOwnedProfileTx(
      manager,
      ctx,
      staffProfileId,
    );
    const { organisationId, workspaceId } = await boundTenant(manager);
    if (
      profile.organisationId !== organisationId ||
      profile.workspaceId !== workspaceId
    )
      throw new NotFoundException('Staff member not found.');
    return profile;
  }

  /** A row of the session's workspace whose staff member is in the caller's scope and still names that profile's user. */
  private async rowInScope(
    manager: EntityManager,
    ctx: AuthContext,
    id: string,
  ): Promise<{ row: StaffTimeOff; profile: StaffProfile }> {
    const { workspaceId } = await boundTenant(manager);
    const row = await manager.findOne(StaffTimeOff, {
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException(TIME_OFF_NOT_FOUND);
    let profile: StaffProfile;
    try {
      profile = await this.staffInScope(manager, ctx, row.staffProfileId);
    } catch (error) {
      if (error instanceof NotFoundException)
        throw new NotFoundException(TIME_OFF_NOT_FOUND);
      throw error;
    }
    if (profile.userId !== row.staffUserId)
      throw new NotFoundException(TIME_OFF_NOT_FOUND);
    return { row, profile };
  }

  /** Compare-and-set on the expected previous status: a concurrent change (or a row RLS hides from UPDATE) is a 409. */
  private async transition(
    manager: EntityManager,
    row: StaffTimeOff,
    fields: Parameters<EntityManager['update']>[2],
  ): Promise<StaffTimeOff> {
    const result = await manager.update(
      StaffTimeOff,
      { id: row.id, status: row.status },
      fields,
    );
    if (!result.affected)
      throw new ConflictException(
        'This time off was changed by someone else. Reload and try again.',
      );
    return manager.findOneByOrFail(StaffTimeOff, { id: row.id });
  }

  private async audit(
    manager: EntityManager,
    ctx: AuthContext,
    action: AuditActionType,
    row: StaffTimeOff,
    targetUserId: string,
    previousStatus?: StaffTimeOffStatusType,
  ): Promise<void> {
    await this.auditService.record(manager, ctx, action, {
      entityType: 'staff_time_off',
      entityId: row.id,
      targetUserId,
      metadata: {
        staffProfileId: row.staffProfileId,
        startsOn: day(row.startsOn),
        endsOn: day(row.endsOn),
        ...(previousStatus ? { previousStatus } : {}),
      },
    });
  }
}

/** The caller's own staff profile in the bound workspace (RLS + this lookup); none → 404. */
async function ownProfile(
  manager: EntityManager,
  ctx: AuthContext,
): Promise<StaffProfile> {
  const profile = await manager.findOne(StaffProfile, {
    where: { userId: ctx.userId },
  });
  const { organisationId, workspaceId } = await boundTenant(manager);
  if (
    !profile ||
    profile.organisationId !== organisationId ||
    profile.workspaceId !== workspaceId
  )
    throw new NotFoundException('Staff profile not found.');
  return profile;
}

/** The organisation and workspace bound into THIS transaction (what RLS compares against) — never a client value. */
async function boundTenant(
  manager: EntityManager,
): Promise<{ organisationId: string; workspaceId: string }> {
  const [row] = (await manager.query(
    `SELECT core.current_org()::text AS org, core.current_workspace()::text AS ws`,
  )) as Array<{ org: string | null; ws: string | null }>;
  if (!row?.org || !row.ws) throw new NotFoundException(TIME_OFF_NOT_FOUND); // fail closed: no tenant bound
  return { organisationId: row.org, workspaceId: row.ws };
}

/** Maker-checker (and the RLS `staff_user_id <> current uid` predicate): a manager never decides their own time off. */
function assertNotSelf(ctx: AuthContext, staffUserId: string): void {
  if (staffUserId === ctx.userId)
    throw new ConflictException({
      statusCode: 409,
      code: 'TIME_OFF_SELF_DECISION',
      message: 'Another manager must decide your own time off.',
    });
}

/** Dates are `YYYY-MM-DD` (validated by the DTO), so text order = date order. 400s mirror the table's CHECKs. */
export function assertRange(
  startsOn: string,
  endsOn: string,
  today: string,
): void {
  if (endsOn < startsOn)
    throw new BadRequestException('endsOn must be on or after startsOn.');
  const days =
    Math.round(
      (Date.parse(`${endsOn}T00:00:00Z`) -
        Date.parse(`${startsOn}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  if (!Number.isFinite(days) || days > STAFF_TIME_OFF_MAX_DAYS)
    throw new BadRequestException(
      `Time off can cover at most ${STAFF_TIME_OFF_MAX_DAYS} days.`,
    );
  // FLAGGED: time off that has already ended blocks nothing (decision 42 is about new offers), so it is refused.
  if (endsOn < today)
    throw new BadRequestException('Time off cannot end in the past.');
}

/** The exclusion constraint is the authority on overlapping APPROVED ranges (concurrent approvals): 409, never a 500. */
async function writing<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const driver =
      error instanceof QueryFailedError
        ? (
            error as QueryFailedError & {
              driverError?: { code?: string; constraint?: string };
            }
          ).driverError
        : undefined;
    if (
      driver?.code === '23P01' &&
      driver.constraint === 'staff_time_off_no_overlapping_approved'
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: 'STAFF_TIME_OFF_OVERLAP',
        message: TIME_OFF_OVERLAP_MESSAGE,
      });
    }
    throw error;
  }
}

function emptyToNull(note: string | null | undefined): string | null {
  const trimmed = typeof note === 'string' ? note.trim() : '';
  return trimmed ? trimmed : null;
}

function day(value: unknown): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value);
}

export function toView(row: StaffTimeOff): StaffTimeOffView {
  return {
    id: row.id,
    staffProfileId: row.staffProfileId,
    startsOn: day(row.startsOn),
    endsOn: day(row.endsOn),
    status: row.status,
    note: row.note,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    declineReason: row.declineReason,
    cancelledBy: row.cancelledBy,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
