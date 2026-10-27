import { PermissionFlag, ShiftStatus, ShiftStatusType, VenueStatus, VenueStatusType } from '@rab/shared';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScope, ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { beginAssistantRead } from '../../../engine/utils/assistant-read.util';
import { MemberAccessPolicyService } from '../../identity/member-access/member-access-policy.service';
import { shiftSeatCountsSql, vacancyFromCounts } from '../../offer/services/shift-vacancy';
import { Venue } from '../../venue/entities/venue.entity';
import { VenueService } from '../../venue/services/venue.service';
import { Shift } from '../entities/shift.entity';
import { SchedulingService } from './scheduling.service';

/**
 * AI Phase 3 read models (docs/ai/PHASE3_TWENTY_PLAN.md §3–§4). Every method is READ-ONLY and aggregate or operational:
 *  - layer 2 inside: the flag the tool declares is re-checked here (403), because jobs, the AI registry and other services
 *    call services directly and never pass a route guard;
 *  - the EXISTING read scopes only: shifts through `SchedulingService.applyShiftReadScope` (the ONE shift read scope, without
 *    the pending-approval widening), venues through `VenueService.canViewVenueTx`; never a second copy of either rule;
 *  - seats through `shiftSeatCountsSql` + `vacancyFromCounts` (the ONE vacancy rule);
 *  - the caller's own tenant transaction (`runInWorkspaceContext`: crewflow_app, RLS bound), READ ONLY, 5 s per statement;
 *  - bounded (at most ASSISTANT_MAX_SHIFTS shifts are aggregated; `truncated` says so) and no staff identity, note, address,
 *    pay or rate is ever read. An id argument (venue, job role) is only ever a FILTER ANDed onto the scope: an id of another
 *    organisation or another manager simply matches nothing, so the answer is identical to a random uuid (404-equivalent).
 */

/** Shift statuses the assistant may list or count (requests, drafts and declined requests are not shifts). */
export const ASSISTANT_SHIFT_STATUSES = [
  ShiftStatus.OPEN, ShiftStatus.OFFERED, ShiftStatus.PARTIALLY_FILLED, ShiftStatus.FULLY_FILLED, ShiftStatus.CONFIRMED, ShiftStatus.IN_PROGRESS,
  ShiftStatus.COMPLETED, ShiftStatus.CANCELLED,
] as const satisfies readonly ShiftStatusType[];
export type AssistantShiftStatus = (typeof ASSISTANT_SHIFT_STATUSES)[number];

/** Statuses that need (or needed) staff — the same set as Phase 1's `assistantStaffing`. */
const STAFFABLE: readonly ShiftStatusType[] = ASSISTANT_SHIFT_STATUSES.filter((s) => s !== ShiftStatus.CANCELLED);

/** Hard bound on the shifts one aggregate reads (same as ASSISTANT_STAFFING_MAX_SHIFTS). */
export const ASSISTANT_MAX_SHIFTS = 2000;
export const ASSISTANT_MAX_VENUES = 25;
const VENUE_CANDIDATES = ASSISTANT_MAX_VENUES * 2;

export interface AssistantRange {
  from: Date;
  to: Date;
}

export interface AssistantShiftRow {
  shiftId: string;
  venueName: string | null;
  jobRoleName: string;
  startsAt: string;
  endsAt: string;
  status: string;
  requiredCount: number;
  filledCount: number;
  vacancies: number;
}

export interface AssistantFindShiftsResult {
  total: number;
  truncated: boolean;
  shifts: AssistantShiftRow[];
}

export interface AssistantShiftCounts {
  total: number;
  truncated: boolean;
  byStatus: Record<AssistantShiftStatus, number>;
  byDay: Array<{ date: string; shifts: number; seatsRequired: number; seatsFilled: number }>;
}

export interface AssistantCoverageGap {
  date: string;
  venueName: string | null;
  jobRoleName: string;
  shifts: number;
  seatsVacant: number;
}

export interface AssistantCoverageGaps {
  gapGroups: number;
  truncated: boolean;
  gaps: AssistantCoverageGap[];
}

export interface AssistantVenueRow {
  venueId: string;
  venueName: string;
  venueStatus: VenueStatusType;
  /** null when the caller lacks schedule.view (one flag gates the tool; secondary flags null fields — P3 C3). */
  shifts: number | null;
  seatsRequired: number | null;
  seatsFilled: number | null;
  seatsVacant: number | null;
  unfilledShifts: number | null;
  offersAwaitingReply: number | null;
}

export interface AssistantVenueSummary {
  truncated: boolean;
  shiftsIncluded: boolean;
  venues: AssistantVenueRow[];
}

interface SeatRow {
  id: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  venueId: string;
  venueName: string;
  jobRoleId: string;
  jobRoleName: string;
  required: number;
  filled: number;
  vacancy: number;
  pendingOffers: number;
}

/** Organisation-local calendar day (YYYY-MM-DD) of an instant. */
export function localDay(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  }
}

@Injectable()
export class SchedulingAssistantService {
  @Inject(MemberAccessPolicyService)
  private readonly memberAccess!: MemberAccessPolicyService;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
    private readonly scheduling: SchedulingService,
    private readonly venues: VenueService,
  ) {}

  /** `find_shifts`: the caller's shifts starting in [from, to) in start order, with optional venue / job role / status filters. */
  async assistantFindShifts(
    ctx: AuthContext,
    range: AssistantRange,
    opts: { venueId?: string; jobRoleId?: string; statuses?: readonly AssistantShiftStatus[]; limit: number },
  ): Promise<AssistantFindShiftsResult> {
    return this.read(ctx, PermissionFlag.SCHEDULE_VIEW, { total: 0, truncated: false, shifts: [] }, async (m, scope) => {
      const ids = await this.scopedShiftIds(m, ctx, scope, range, {
        statuses: opts.statuses?.length ? opts.statuses : ASSISTANT_SHIFT_STATUSES,
        venueId: opts.venueId,
        jobRoleId: opts.jobRoleId,
      });
      const rows = await this.seatRows(m, ids.ids.slice(0, Math.max(0, opts.limit)));
      const venueNames = await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.VENUE_VIEW);
      return {
        total: ids.total,
        truncated: ids.total > rows.length,
        shifts: rows.map((r) => ({
          shiftId: r.id,
          venueName: venueNames ? r.venueName : null,
          jobRoleName: r.jobRoleName,
          startsAt: r.startsAt.toISOString(),
          endsAt: r.endsAt.toISOString(),
          status: r.status,
          requiredCount: r.required,
          filledCount: r.filled,
          vacancies: r.status === ShiftStatus.CANCELLED ? 0 : r.vacancy,
        })),
      };
    });
  }

  /** `count_shifts`: counts by status and, for staffable shifts, by organisation-local day with seat totals. */
  async assistantShiftCounts(ctx: AuthContext, range: AssistantRange, timeZone: string): Promise<AssistantShiftCounts> {
    const byStatus = Object.fromEntries(ASSISTANT_SHIFT_STATUSES.map((s) => [s, 0])) as Record<AssistantShiftStatus, number>;
    return this.read(ctx, PermissionFlag.SCHEDULE_VIEW, { total: 0, truncated: false, byStatus, byDay: [] }, async (m, scope) => {
      const ids = await this.scopedShiftIds(m, ctx, scope, range, { statuses: ASSISTANT_SHIFT_STATUSES });
      const rows = await this.seatRows(m, ids.ids);
      const days = new Map<string, { date: string; shifts: number; seatsRequired: number; seatsFilled: number }>();
      const counts = { ...byStatus };
      for (const r of rows) {
        if (r.status in counts) counts[r.status as AssistantShiftStatus] += 1;
        if (!STAFFABLE.includes(r.status as ShiftStatusType)) continue;
        const date = localDay(r.startsAt, timeZone);
        const day = days.get(date) ?? { date, shifts: 0, seatsRequired: 0, seatsFilled: 0 };
        day.shifts += 1;
        day.seatsRequired += r.required;
        day.seatsFilled += r.filled;
        days.set(date, day);
      }
      return { total: ids.total, truncated: ids.total > rows.length, byStatus: counts, byDay: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
    });
  }

  /**
   * `get_rota_coverage_gaps` (PARTIAL by design, §5.3): there is no rota template or demand model, so a gap is a vacant
   * seat on a shift that EXISTS (staffable, not completed), grouped by organisation-local day, venue and job role.
   */
  async assistantCoverageGaps(
    ctx: AuthContext,
    range: AssistantRange,
    timeZone: string,
    opts: { venueId?: string; jobRoleId?: string; limit: number },
  ): Promise<AssistantCoverageGaps> {
    return this.read(ctx, PermissionFlag.SCHEDULE_VIEW, { gapGroups: 0, truncated: false, gaps: [] }, async (m, scope) => {
      const ids = await this.scopedShiftIds(m, ctx, scope, range, {
        statuses: STAFFABLE.filter((s) => s !== ShiftStatus.COMPLETED),
        venueId: opts.venueId,
        jobRoleId: opts.jobRoleId,
      });
      const rows = await this.seatRows(m, ids.ids);
      const venueNames = await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.VENUE_VIEW);
      const groups = new Map<string, AssistantCoverageGap>();
      for (const r of rows) {
        if (r.vacancy <= 0) continue;
        const date = localDay(r.startsAt, timeZone);
        const key = `${date}|${r.venueId}|${r.jobRoleId}`;
        const g = groups.get(key) ?? { date, venueName: venueNames ? r.venueName : null, jobRoleName: r.jobRoleName, shifts: 0, seatsVacant: 0 };
        g.shifts += 1;
        g.seatsVacant += r.vacancy;
        groups.set(key, g);
      }
      const all = [...groups.values()].sort(
        (a, b) => a.date.localeCompare(b.date) || b.seatsVacant - a.seatsVacant || (a.venueName ?? '').localeCompare(b.venueName ?? '') || a.jobRoleName.localeCompare(b.jobRoleName),
      );
      return { gapGroups: all.length, truncated: ids.total > rows.length || all.length > opts.limit, gaps: all.slice(0, Math.max(0, opts.limit)) };
    });
  }

  /**
   * `get_venue_summary`: the venues the caller may view (each one through `VenueService.canViewVenueTx`: venue.view +
   * owner / assigned-venue scope + member role policy), at most 25, with the caller's own shifts at each in range when the
   * caller also holds schedule.view (otherwise those fields are null).
   */
  async assistantVenueSummary(ctx: AuthContext, range: AssistantRange, opts: { venueId?: string }): Promise<AssistantVenueSummary> {
    return this.read(ctx, PermissionFlag.VENUE_VIEW, { truncated: false, shiftsIncluded: false, venues: [] }, async (m, scope) => {
      const qb = m
        .createQueryBuilder(Venue, 'venue')
        .select(['venue.id', 'venue.name', 'venue.status', 'venue.createdBy', 'venue.archivedAt'])
        .where('venue.archivedAt IS NULL')
        .andWhere('venue.status <> :archived', { archived: VenueStatus.ARCHIVED });
      // A pre-filter only (cheap candidate set); canViewVenueTx below is the authoritative check for every row.
      if (scope.kind === 'venue') qb.andWhere('venue.id IN (:...venueIds)', { venueIds: scope.venueIds });
      else qb.andWhere('venue.createdBy = :ownerUserId', { ownerUserId: scope.ownerUserId });
      if (opts.venueId) qb.andWhere('venue.id = :venueId', { venueId: opts.venueId });
      const candidates = await qb.orderBy('venue.name', 'ASC').addOrderBy('venue.id', 'ASC').limit(VENUE_CANDIDATES + 1).getMany();
      const visible: Venue[] = [];
      for (const venue of candidates.slice(0, VENUE_CANDIDATES)) {
        if (visible.length > ASSISTANT_MAX_VENUES) break;
        if (await this.venues.canViewVenueTx(m, ctx, venue)) visible.push(venue);
      }
      const truncated = visible.length > ASSISTANT_MAX_VENUES || candidates.length > VENUE_CANDIDATES;
      const listed = visible.slice(0, ASSISTANT_MAX_VENUES);
      const shiftsIncluded = await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.SCHEDULE_VIEW);
      const perVenue = new Map<string, { shifts: number; seatsRequired: number; seatsFilled: number; seatsVacant: number; unfilledShifts: number; offersAwaitingReply: number }>();
      if (shiftsIncluded && listed.length > 0) {
        const policy = await this.memberAccess.resolveTx(m, ctx, 'shift');
        if (!policy.restricted || policy.canRead) {
          const ids = await this.scopedShiftIds(m, ctx, scope, range, { statuses: STAFFABLE, venueIds: listed.map((v) => v.id) });
          for (const r of await this.seatRows(m, ids.ids)) {
            const agg = perVenue.get(r.venueId) ?? { shifts: 0, seatsRequired: 0, seatsFilled: 0, seatsVacant: 0, unfilledShifts: 0, offersAwaitingReply: 0 };
            agg.shifts += 1;
            agg.seatsRequired += r.required;
            agg.seatsFilled += r.filled;
            agg.seatsVacant += r.vacancy;
            if (r.vacancy > 0 && r.status !== ShiftStatus.COMPLETED) agg.unfilledShifts += 1;
            agg.offersAwaitingReply += r.pendingOffers;
            perVenue.set(r.venueId, agg);
          }
        }
      }
      return {
        truncated,
        shiftsIncluded,
        venues: listed.map((v) => {
          const agg = perVenue.get(v.id) ?? { shifts: 0, seatsRequired: 0, seatsFilled: 0, seatsVacant: 0, unfilledShifts: 0, offersAwaitingReply: 0 };
          const show = <T>(value: T): T | null => (shiftsIncluded ? value : null);
          return {
            venueId: v.id,
            venueName: v.name,
            venueStatus: v.status,
            shifts: show(agg.shifts),
            seatsRequired: show(agg.seatsRequired),
            seatsFilled: show(agg.seatsFilled),
            seatsVacant: show(agg.seatsVacant),
            unfilledShifts: show(agg.unfilledShifts),
            offersAwaitingReply: show(agg.offersAwaitingReply),
          };
        }),
      };
    });
  }

  /** The shared frame: own read-only, time-boxed tenant transaction; layer-2 flag (403); an empty venue scope reads nothing. */
  private read<T>(ctx: AuthContext, flag: typeof PermissionFlag.SCHEDULE_VIEW | typeof PermissionFlag.VENUE_VIEW, empty: T, fn: (m: EntityManager, scope: ResourceScope) => Promise<T>): Promise<T> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await beginAssistantRead(m);
      if (!(await this.permissions.userHasPermissionTx(m, ctx, flag))) throw new ForbiddenException('Permission required.');
      const scope = await this.resourceScope.resolveTx(m, ctx);
      if (scope.kind === 'venue' && scope.venueIds.length === 0) return empty;
      return fn(m, scope);
    });
  }

  /** Ids of the caller's in-scope shifts (the ONE shift read scope, no pending-approval widening), start order, bounded. */
  private async scopedShiftIds(
    m: EntityManager,
    ctx: AuthContext,
    scope: ResourceScope,
    range: AssistantRange,
    filter: { statuses: readonly ShiftStatusType[]; venueId?: string; venueIds?: string[]; jobRoleId?: string },
  ): Promise<{ total: number; ids: string[] }> {
    const policy = await this.memberAccess.resolveTx(m, ctx, 'shift');
    const qb = m.createQueryBuilder(Shift, 'shift').select('shift.id', 'id');
    this.scheduling.applyShiftReadScope(qb, ctx, scope, policy, { widenPendingApproval: false });
    qb.andWhere('shift.startsAt >= :from AND shift.startsAt < :to', { from: range.from, to: range.to })
      .andWhere('shift.status IN (:...statuses)', { statuses: [...filter.statuses] })
      .andWhere('shift.archivedAt IS NULL');
    if (filter.venueId) qb.andWhere('shift.venueId = :venueId', { venueId: filter.venueId });
    if (filter.venueIds) qb.andWhere('shift.venueId IN (:...venueIds)', { venueIds: filter.venueIds });
    if (filter.jobRoleId) qb.andWhere('shift.jobRoleId = :jobRoleId', { jobRoleId: filter.jobRoleId });
    const total = await qb.getCount();
    if (total === 0) return { total: 0, ids: [] };
    qb.orderBy('shift.startsAt', 'ASC').addOrderBy('shift.id', 'ASC').limit(ASSISTANT_MAX_SHIFTS);
    return { total, ids: (await qb.getRawMany<{ id: string }>()).map((r) => r.id) };
  }

  /** Operational fields + seat counts of the given (already scoped) shift ids; never a staff, note, address or pay column. */
  private async seatRows(m: EntityManager, ids: string[]): Promise<SeatRow[]> {
    if (ids.length === 0) return [];
    const rows: Array<Record<string, unknown>> = await m.query(
      `SELECT s.id, s.status, s.starts_at, s.ends_at, s.required_count, s.filled_count, s.venue_id, v.name AS venue_name, s.job_role_id, jr.name AS job_role_name,
              ${shiftSeatCountsSql('sa')}
         FROM shift s
         JOIN venue v ON v.id = s.venue_id
         JOIN job_role jr ON jr.id = s.job_role_id
         LEFT JOIN shift_assignment sa ON sa.shift_id = s.id
        WHERE s.id = ANY($1::uuid[])
        GROUP BY s.id, v.name, jr.name
        ORDER BY s.starts_at, s.id`,
      [ids],
    );
    return rows.map((r) => {
      const required = Number(r.required_count);
      const { effectiveFilled, vacancy } = vacancyFromCounts({ requiredCount: required, filledCount: Number(r.filled_count), occupied: Number(r.occupied), confirmedNoShows: Number(r.confirmed_no_shows) });
      return {
        id: r.id as string,
        status: r.status as string,
        startsAt: new Date(r.starts_at as string),
        endsAt: new Date(r.ends_at as string),
        venueId: r.venue_id as string,
        venueName: r.venue_name as string,
        jobRoleId: r.job_role_id as string,
        jobRoleName: r.job_role_name as string,
        required,
        filled: Math.min(required, effectiveFilled),
        vacancy: r.status === ShiftStatus.CANCELLED ? 0 : vacancy,
        pendingOffers: Number(r.pending_offers),
      };
    });
  }
}
