import { EmploymentStatus, hasDeclaredAvailability, PermissionFlag, WEEKDAY_NAMES, WeekdayName } from '@rab/shared';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';

import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { beginAssistantRead } from '../../../engine/utils/assistant-read.util';
import { MemberAccessPolicyService } from '../../identity/member-access/member-access-policy.service';
import { AvailabilityService } from '../../scheduling/services/availability.service';
import { StaffProfile } from '../entities/staff-profile.entity';

/** Hard bound on the staff profiles one availability aggregate reads (`truncated` says so). */
export const ASSISTANT_MAX_STAFF = 2000;

export interface AssistantAvailabilityDay {
  date: string;
  weekday: WeekdayName;
  /** Active in-scope staff whose declared weekdays include this weekday. */
  declaredAvailable: number;
  /** Of those, the ones with no confirmed assignment overlapping this day. */
  availableNotBooked: number;
  /** Active in-scope staff with a confirmed assignment overlapping this day (declared or not). */
  booked: number;
  /** Active in-scope staff who never declared weekday availability (NULL or empty: "unknown", never "none"). */
  notDeclared: number;
}

export interface AssistantAvailabilityCounts {
  activeStaff: number;
  truncated: boolean;
  byDay: AssistantAvailabilityDay[];
}

/** The weekday of a calendar date string (the date's own weekday, independent of any timezone). */
export function weekdayOf(day: string): WeekdayName {
  return WEEKDAY_NAMES[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]!;
}

/**
 * AI Phase 3 `get_staff_availability` read model (docs/ai/PHASE3_TWENTY_PLAN.md §4–§5, P3-D9). PARTIAL BY DESIGN and
 * ADVISORY: the only availability data that exists is `staff_profile.available_days` (a weekday list; NULL / [] =
 * "not declared") and "busy" = a CONFIRMED assignment overlapping the day (`AvailabilityService.findBusyStaffIds`, the ONE
 * busy rule). There are no dates, hours, leave or unavailability records, and `preferred_shift_times` (free text) is never
 * read. COUNTS ONLY: no name, id, contact or ranking leaves this method — it never helps decide who gets work (rule 3.6).
 *
 * Scope: the staff read scope of `StaffService.list()` (the caller's own staff, or for a custom workspace-member their
 * workspace owner's staff within the member's record filter; a member whose role cannot read staff gets the same 403 as
 * `list()`), ACTIVE and not archived. A `jobRoleId` is only a filter
 * ANDed onto that scope (another organisation's or manager's id matches nothing); it is ignored-as-empty when the member's
 * field policy hides the job role (a hidden field is never probed). Layer 2: `staff.view` re-checked here (403). Own READ
 * ONLY tenant transaction (crewflow_app, RLS bound), 5 s per statement.
 */
@Injectable()
export class StaffAssistantService {
  @Inject(MemberAccessPolicyService)
  private readonly memberAccess!: MemberAccessPolicyService;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
    private readonly availability: AvailabilityService,
  ) {}

  /** `days` are organisation-local calendar days, each with its [start, end) instants (computed by the caller, DST-correct). */
  async assistantAvailabilityCounts(
    ctx: AuthContext,
    days: ReadonlyArray<{ date: string; from: Date; to: Date }>,
    opts: { jobRoleId?: string },
  ): Promise<AssistantAvailabilityCounts> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await beginAssistantRead(m);
      if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.STAFF_VIEW))) throw new ForbiddenException('Permission required.');
      const empty = (): AssistantAvailabilityCounts => ({
        activeStaff: 0,
        truncated: false,
        byDay: days.map((d) => ({ date: d.date, weekday: weekdayOf(d.date), declaredAvailable: 0, availableNotBooked: 0, booked: 0, notDeclared: 0 })),
      });
      const scope = await this.resourceScope.resolveTx(m, ctx);
      const ownerUserId = scope.kind === 'owner' && scope.delegated ? scope.ownerUserId : ctx.userId;
      const policy = await this.memberAccess.resolveTx(m, ctx, 'staff');
      this.memberAccess.assertCanRead(policy);
      if (opts.jobRoleId && !this.memberAccess.isFieldVisible(policy, 'jobRole')) return empty();
      const qb = m
        .createQueryBuilder(StaffProfile, 'sp')
        .select('sp.id', 'id')
        .addSelect('sp.availableDays', 'available_days')
        .where('sp.organisationId = :orgId', { orgId: ctx.organisationId! })
        .andWhere('sp.createdBy = :createdBy', { createdBy: ownerUserId })
        .andWhere('sp.employmentStatus = :active', { active: EmploymentStatus.ACTIVE })
        .andWhere('sp.archivedAt IS NULL');
      const recordFilter = this.memberAccess.qbWhere(policy, 'sp');
      qb.andWhere(recordFilter.sql, recordFilter.named);
      if (opts.jobRoleId) qb.andWhere('sp.jobRoleId = :jobRoleId', { jobRoleId: opts.jobRoleId });
      const rows = await qb.orderBy('sp.id', 'ASC').limit(ASSISTANT_MAX_STAFF + 1).getRawMany<{ id: string; available_days: string[] | null }>();
      const truncated = rows.length > ASSISTANT_MAX_STAFF;
      const staff = rows.slice(0, ASSISTANT_MAX_STAFF);
      if (staff.length === 0) return empty();
      const ids = staff.map((s) => s.id);
      const byDay: AssistantAvailabilityDay[] = [];
      for (const day of days) {
        const weekday = weekdayOf(day.date);
        const busy = await this.availability.findBusyStaffIds(m, ids, day.from, day.to);
        let declaredAvailable = 0;
        let availableNotBooked = 0;
        let notDeclared = 0;
        for (const s of staff) {
          if (!hasDeclaredAvailability(s.available_days)) {
            notDeclared += 1;
            continue;
          }
          if (!s.available_days.includes(weekday)) continue;
          declaredAvailable += 1;
          if (!busy.has(s.id)) availableNotBooked += 1;
        }
        byDay.push({ date: day.date, weekday, declaredAvailable, availableNotBooked, booked: busy.size, notDeclared });
      }
      return { activeStaff: staff.length, truncated, byDay };
    });
  }
}
