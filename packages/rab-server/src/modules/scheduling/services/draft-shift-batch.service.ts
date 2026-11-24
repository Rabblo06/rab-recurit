import { PermissionFlag, ShiftStatus } from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { MemberAccessPolicyService } from '../../identity/member-access/member-access-policy.service';
import { VenueService } from '../../venue/services/venue.service';
import { CopyPreviousWeekDto } from '../dto/copy-previous-week.dto';
import { ShiftPatternDto } from '../dto/shift-pattern.dto';
import { Shift } from '../entities/shift.entity';
import {
  COPYABLE_SOURCE_STATUSES,
  DRAFT_BATCH_MAX_ROWS,
  DUPLICATE_BLOCKING_STATUSES,
  DraftCandidate,
  PlannedDraft,
  TargetCheck,
  moveByLocalDays,
  planDrafts,
  slotKey,
  targetKey,
  weekCopyWindows,
} from '../utils/draft-batch-plan';
import { ShiftPatternDefinition, patternDefinitionError, patternOccurrences, zonedInstant } from '../utils/shift-pattern-plan';
import { addDays } from '../../ai/tools/ai-date-range';
import { SchedulingService } from './scheduling.service';
import { ExpensiveActionRateLimitService } from '../../../engine/core-modules/rate-limit/expensive-action-rate-limit.service';
import { randomUUID } from 'node:crypto';

/** One row of a batch preview / result. Ids, times and counts only: never a pay amount. */
export interface DraftBatchRow {
  key: string;
  venueId: string;
  jobRoleId: string;
  startsAt: string;
  endsAt: string;
  requiredCount: number;
  outcome: 'create' | 'skip';
  reason?: string;
}

export interface DraftBatchPreview {
  timezone: string;
  window: { from: string; to: string };
  rows: DraftBatchRow[];
  createCount: number;
  skipCount: number;
}

export interface DraftBatchResult extends DraftBatchPreview {
  /** Only on confirm: the new DRAFT shifts, in row order (`key` → new shift id). */
  created: Array<{ key: string; shiftId: string }>;
}

export interface ShiftPatternResult extends DraftBatchResult {
  /** The server-generated `recurrence_group_id` every shift of this generation carries (null when nothing was created). */
  recurrenceGroupId: string | null;
}

/**
 * Batch builders that create many DRAFT shifts at once: "copy previous week" (this PR) and the recurring pattern.
 *
 * Layers, for both preview and confirm: route PermissionGuard(SCHEDULE_CREATE) + RequireWorkspaceGuard →
 * SCHEDULE_CREATE re-checked here, first, inside the tenant transaction (403 before any row is read; jobs and other
 * services never pass the guard) → the caller's own shift read scope for the source rows (`applyShiftReadScope`, no
 * pending-request widening) → every new row through `SchedulingService.insertNewShiftTx` (venue + job role scope 404,
 * archive rules 409, pay rate resolved for the new date, `shift.created` audit row) → workspace RLS.
 *
 * Never copied: assignments, offers, requested staff, status, publication, QR, pay rate. Every new shift is a DRAFT.
 * Confirm recomputes the whole plan server-side (a preview is never trusted) and writes in ONE transaction: if any
 * insert fails unexpectedly, nothing is created.
 */
@Injectable()
export class DraftShiftBatchService {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
    private readonly memberAccess: MemberAccessPolicyService,
    private readonly venueService: VenueService,
    private readonly scheduling: SchedulingService,
    private readonly expensiveLimit: ExpensiveActionRateLimitService,
  ) {}

  /** Named action `previewCopyPreviousWeek`: what `copyPreviousWeek` would create. Writes nothing. */
  previewCopyPreviousWeek(ctx: AuthContext, dto: CopyPreviousWeekDto): Promise<DraftBatchPreview> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const { plan, timezone, window } = await this.planWeekCopyTx(manager, ctx, dto);
      return summarise(plan, timezone, window);
    });
  }

  /** Named action `copyPreviousWeek`: copies week N−1 into week N as new DRAFT shifts. One transaction. */
  copyPreviousWeek(ctx: AuthContext, dto: CopyPreviousWeekDto): Promise<DraftBatchResult> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const { plan, timezone, window } = await this.planWeekCopyTx(manager, ctx, dto, dto.sourceShiftIds ? new Set(dto.sourceShiftIds) : undefined, true);
      const created = await this.insertPlanTx(manager, ctx, plan);
      return { ...summarise(plan, timezone, window), created };
    });
  }

  /** Named action `previewShiftPattern`: the occurrences `generateShiftPattern` would create. Writes nothing. */
  previewShiftPattern(ctx: AuthContext, dto: ShiftPatternDto): Promise<DraftBatchPreview> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const { plan, timezone, window } = await this.planPatternTx(manager, ctx, dto);
      return summarise(plan, timezone, window);
    });
  }

  /**
   * Named action `generateShiftPattern`: every `create` occurrence becomes a DRAFT shift; all of them share one
   * server-generated `recurrence_group_id` (`shift.recurrence_group_id`, never accepted from a client). One transaction.
   */
  generateShiftPattern(ctx: AuthContext, dto: ShiftPatternDto): Promise<ShiftPatternResult> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const { plan, timezone, window } = await this.planPatternTx(manager, ctx, dto, dto.dates ? new Set(dto.dates) : undefined, true);
      const recurrenceGroupId = plan.some((row) => row.outcome === 'create') ? randomUUID() : null;
      const created = await this.insertPlanTx(manager, ctx, plan, recurrenceGroupId ? { recurrenceGroupId } : {});
      return { ...summarise(plan, timezone, window), created, recurrenceGroupId };
    });
  }

  /**
   * The set-wide pre-check for a pattern: the definition is validated first (400 for the whole request), then every
   * occurrence is checked together: the venue + job role once under `create`'s rules, the past, an identical live shift
   * already in scope, and duplicates inside the set. Staff are never assigned here, so the staff double-booking
   * exclusion (`shift_assignment_no_double_booking`) cannot be reached; it still applies when staff are offered later.
   */
  private async planPatternTx(
    manager: EntityManager,
    ctx: AuthContext,
    dto: ShiftPatternDto,
    selectedKeys?: ReadonlySet<string>,
    forWrite = false,
  ): Promise<{ plan: PlannedDraft[]; timezone: string; window: { from: Date; to: Date } }> {
    await this.admitTx(manager, ctx, forWrite);
    const def: ShiftPatternDefinition = {
      venueId: dto?.venueId,
      jobRoleId: dto?.jobRoleId,
      startDate: dto?.startDate,
      endDate: dto?.endDate,
      weekdays: dto?.weekdays,
      startTime: dto?.startTime,
      endTime: dto?.endTime,
      intervalWeeks: dto?.intervalWeeks ?? 1,
      breakMinutes: dto?.breakMinutes ?? 0,
      requiredCount: dto?.requiredCount,
      chargeRatePence: dto?.chargeRatePence ?? 0,
      notes: dto?.notes ?? null,
    };
    const invalid = patternDefinitionError(def);
    if (invalid) throw new BadRequestException(invalid);
    // The venue first, as its own 404 (an out-of-scope id never reaches the occurrence list).
    await this.venueService.assertVenueAccessibleTx(manager, ctx, def.venueId);
    const timezone = await this.organisationTimezoneTx(manager, ctx);
    const candidates = patternOccurrences(def, timezone);
    if (candidates.length > DRAFT_BATCH_MAX_ROWS) throw new BadRequestException(`A pattern can create at most ${DRAFT_BATCH_MAX_ROWS} shifts.`);
    const window = { from: zonedInstant(def.startDate, '00:00', timezone), to: zonedInstant(addDays(def.endDate, 2), '00:00', timezone) };
    const plan = planDrafts(candidates, {
      existingSlots: await this.liveSlotsTx(manager, window, candidates),
      targetChecks: await this.checkTargetsTx(manager, ctx, candidates),
      now: new Date(),
      selectedKeys,
    });
    return { plan, timezone, window: { from: window.from, to: zonedInstant(addDays(def.endDate, 1), '00:00', timezone) } };
  }

  private async planWeekCopyTx(
    manager: EntityManager,
    ctx: AuthContext,
    dto: CopyPreviousWeekDto,
    selectedKeys?: ReadonlySet<string>,
    forWrite = false,
  ): Promise<{ plan: PlannedDraft[]; timezone: string; window: { from: Date; to: Date } }> {
    await this.admitTx(manager, ctx, forWrite);
    const weekStart = assertIsoDay(dto?.weekStart);
    if (dto.venueId !== undefined) await this.venueService.assertVenueAccessibleTx(manager, ctx, dto.venueId);
    const timezone = await this.organisationTimezoneTx(manager, ctx);
    const { source, target } = weekCopyWindows(weekStart, timezone);

    // One more than the cap, so "too many" is detectable without reading an unbounded set.
    const sources = await this.scopedShiftsTx(manager, ctx, source, COPYABLE_SOURCE_STATUSES, dto.venueId, DRAFT_BATCH_MAX_ROWS + 1);
    if (sources.length > DRAFT_BATCH_MAX_ROWS) {
      throw new BadRequestException(`The previous week has more than ${DRAFT_BATCH_MAX_ROWS} shifts. Copy one venue at a time.`);
    }
    const candidates: DraftCandidate[] = sources.map((shift) => ({
      key: shift.id,
      venueId: shift.venueId,
      jobRoleId: shift.jobRoleId,
      ...moveByLocalDays(shift.startsAt, shift.endsAt, 7, timezone),
      breakMinutes: shift.breakMinutes,
      requiredCount: shift.requiredCount,
      chargeRatePence: shift.chargeRatePence,
      notes: shift.notes ?? null,
      address: shift.address ?? null,
    }));
    const plan = planDrafts(candidates, {
      existingSlots: await this.liveSlotsTx(manager, target, candidates),
      targetChecks: await this.checkTargetsTx(manager, ctx, candidates),
      now: new Date(),
      selectedKeys,
    });
    return { plan, timezone, window: target };
  }

  /**
   * Every batch call, first, in this order:
   *  1. layer 2: SCHEDULE_CREATE AND SCHEDULE_BULK (bulk & recurring scheduling is its own capability, §5), re-checked in
   *     the service — 403, a categorical lack, before any row is read;
   *  2. the EXPENSIVE request class (§5.5: 10/min per user, 30/min per organisation; preview and confirm both count) —
   *     429, or 503 when the limiter is unavailable (fail closed);
   *  3. for a write (confirm), a transaction-scoped advisory lock per organisation + workspace, so two confirms of the
   *     same batch (two tabs, a retry) run one after the other and the second sees the first's drafts as
   *     `already_exists` instead of creating them twice (READ COMMITTED alone lets both plan before either commits).
   */
  private async admitTx(manager: EntityManager, ctx: AuthContext, forWrite: boolean): Promise<void> {
    for (const flag of [PermissionFlag.SCHEDULE_CREATE, PermissionFlag.SCHEDULE_BULK]) {
      if (!(await this.permissions.userHasPermissionTx(manager, ctx, flag))) {
        throw new ForbiddenException('Bulk scheduling is not permitted.');
      }
    }
    await this.expensiveLimit.admit('bulk-scheduling', { userId: ctx.userId, organisationId: ctx.organisationId! });
    if (forWrite) {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`draft-batch:${ctx.organisationId}:${ctx.workspaceId ?? ''}`]);
    }
  }

  /**
   * The (venue, job role, start, end) of every live shift already in [from, to) at the candidates' venues, in THIS
   * workspace (RLS). Not limited to the caller's own read scope on purpose: a delegated member's earlier drafts are
   * created by the member while their read scope is the workspace owner's, and a duplicate must be recognised whoever
   * created it. Only the slot keys leave this method; no row of another manager is returned to the caller.
   */
  private async liveSlotsTx(manager: EntityManager, window: { from: Date; to: Date }, candidates: DraftCandidate[]): Promise<Set<string>> {
    const venueIds = [...new Set(candidates.map((c) => c.venueId))];
    if (venueIds.length === 0) return new Set();
    const rows = await manager
      .createQueryBuilder(Shift, 'shift')
      .where('shift.venueId IN (:...venueIds)', { venueIds })
      .andWhere('shift.startsAt >= :from AND shift.startsAt < :to', { from: window.from, to: window.to })
      .andWhere('shift.status IN (:...statuses)', { statuses: [...DUPLICATE_BLOCKING_STATUSES] })
      .andWhere('shift.archivedAt IS NULL')
      .select(['shift.venueId', 'shift.jobRoleId', 'shift.startsAt', 'shift.endsAt'])
      .getMany();
    return new Set(rows.map((s) => slotKey(s.venueId, s.jobRoleId, s.startsAt, s.endsAt)));
  }

  private async organisationTimezoneTx(manager: EntityManager, ctx: AuthContext): Promise<string> {
    const [org] = (await manager.query(`SELECT timezone FROM core.organisation WHERE id = $1`, [ctx.organisationId])) as Array<{ timezone: string | null }>;
    return org?.timezone || 'Europe/London';
  }

  /** Shifts STARTING in [from, to) inside the caller's own read scope (no pending-request widening), not archived. */
  private async scopedShiftsTx(
    manager: EntityManager,
    ctx: AuthContext,
    window: { from: Date; to: Date },
    statuses: readonly string[],
    venueId?: string,
    limit?: number,
  ): Promise<Shift[]> {
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (scope.kind === 'venue' && scope.venueIds.length === 0) return [];
    const policy = await this.memberAccess.resolveTx(manager, ctx, 'shift');
    const qb = manager.createQueryBuilder(Shift, 'shift');
    this.scheduling.applyShiftReadScope(qb, ctx, scope, policy, { widenPendingApproval: false });
    qb.andWhere('shift.startsAt >= :from AND shift.startsAt < :to', { from: window.from, to: window.to })
      .andWhere('shift.status IN (:...statuses)', { statuses: [...statuses] })
      .andWhere('shift.archivedAt IS NULL');
    if (venueId) qb.andWhere('shift.venueId = :venueId', { venueId });
    qb.orderBy('shift.startsAt', 'ASC').addOrderBy('shift.id', 'ASC');
    if (limit !== undefined) qb.take(limit);
    return qb.getMany();
  }

  /**
   * Each distinct venue + job role checked ONCE under exactly `create`'s rules (`resolveDraftTargetsTx`): out of scope →
   * `*_unavailable` (the 404 of a single create), archived → `*_archived` (its 409). Any other error propagates.
   */
  private async checkTargetsTx(manager: EntityManager, ctx: AuthContext, candidates: DraftCandidate[]): Promise<Map<string, TargetCheck>> {
    const checks = new Map<string, TargetCheck>();
    for (const candidate of candidates) {
      const key = targetKey(candidate.venueId, candidate.jobRoleId);
      if (checks.has(key)) continue;
      try {
        await this.scheduling.resolveDraftTargetsTx(manager, ctx, candidate.venueId, candidate.jobRoleId);
        checks.set(key, null);
      } catch (error) {
        checks.set(key, targetFailure(error));
      }
    }
    return checks;
  }

  /** Inserts every `create` row through the one shift-insert path, in the caller's transaction. */
  private async insertPlanTx(manager: EntityManager, ctx: AuthContext, plan: PlannedDraft[], opts: { recurrenceGroupId?: string } = {}): Promise<Array<{ key: string; shiftId: string }>> {
    const created: Array<{ key: string; shiftId: string }> = [];
    for (const row of plan) {
      if (row.outcome !== 'create') continue;
      const shift = await this.scheduling.insertNewShiftTx(
        manager,
        ctx,
        {
          venueId: row.venueId,
          jobRoleId: row.jobRoleId,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          breakMinutes: row.breakMinutes,
          requiredCount: row.requiredCount,
          chargeRatePence: row.chargeRatePence,
          notes: row.notes ?? undefined,
          address: row.address ?? undefined,
        },
        ShiftStatus.DRAFT,
        opts,
      );
      created.push({ key: row.key, shiftId: shift.id });
    }
    return created;
  }
}

function summarise(plan: PlannedDraft[], timezone: string, window: { from: Date; to: Date }): DraftBatchPreview {
  const rows = plan.map<DraftBatchRow>((row) => ({
    key: row.key,
    venueId: row.venueId,
    jobRoleId: row.jobRoleId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    requiredCount: row.requiredCount,
    outcome: row.outcome,
    ...(row.reason ? { reason: row.reason } : {}),
  }));
  const createCount = rows.filter((r) => r.outcome === 'create').length;
  return { timezone, window: { from: window.from.toISOString(), to: window.to.toISOString() }, rows, createCount, skipCount: rows.length - createCount };
}

/** A strict `YYYY-MM-DD` that is a real calendar day (a direct caller never passes the ValidationPipe). */
export function assertIsoDay(value: unknown): string {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException('weekStart must be a date (YYYY-MM-DD).');
  }
  return value;
}

function targetFailure(error: unknown): TargetCheck {
  if (error instanceof NotFoundException) {
    return /venue/i.test(error.message) ? 'venue_unavailable' : 'job_role_unavailable';
  }
  if (error instanceof ConflictException) {
    const code = (error.getResponse() as { code?: string })?.code;
    if (code === 'VENUE_ARCHIVED') return 'venue_archived';
    if (code === 'JOB_ROLE_ARCHIVED') return 'job_role_archived';
  }
  throw error;
}
