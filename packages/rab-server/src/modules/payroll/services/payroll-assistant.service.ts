import { formatPence, PermissionFlag, subtractPence } from '@rab/shared';
import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { beginAssistantRead } from '../../../engine/utils/assistant-read.util';
import { attendanceReadScopeCondition } from '../../attendance/services/attendance.service';
import { FieldPolicyService } from '../../identity/member-access/field-policy.service';
import { PayrollService } from './payroll.service';

/** Totals of ONE payroll run. Money is integer pence (`grossTotalPence`) plus the `formatPence` string; never a float. */
export interface AssistantRunTotals {
  periodStart: string;
  periodEnd: string;
  payday: string;
  runStatus: string;
  shiftRecords: number;
  staff: number;
  /** null when the caller's field policy hides worked time. */
  hours: number | null;
  /** null when the caller's field policy hides amounts. */
  grossTotalPence: number | null;
  grossTotalFormatted: string | null;
  lateApprovals: number;
}

export interface AssistantRunDifferences {
  shiftRecords: number;
  staff: number;
  hours: number | null;
  grossTotalPence: number | null;
  grossTotalFormatted: string | null;
  lateApprovals: number;
}

export type AssistantRunComparison =
  | { available: false; reason: string }
  | { available: true; current: AssistantRunTotals; previous: AssistantRunTotals | null; differences: AssistantRunDifferences | null };

export interface AssistantApprovalQueue {
  awaitingApproval: number;
  rejected: number;
  /** Awaiting records of the caller's OWN hours (the caller cannot approve them: separation of duties). */
  ownHoursAwaiting: number;
  oldestAwaitingShiftDate: string | null;
  /** null unless the caller also holds attendance.view (one flag gates the tool; secondary flags null fields). */
  attendanceUnderReview: number | null;
  attendanceDisputed: number | null;
  reportsNotFinalised: number | null;
}

const hoursOf = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

/**
 * AI Phase 3 payroll read models (docs/ai/PHASE3_TWENTY_PLAN.md §4, P3-C8 / D6, C9). READ-ONLY, AGGREGATES ONLY:
 *  - `assistantRunTotals` replaces the Phase 1 path that loaded `PayrollRunService.detail()` (every per-staff row with its
 *    amount) into the AI process: here every figure is ONE SQL aggregate per run (`count`, `count(DISTINCT
 *    staff_profile_id)`, `sum(worked_minutes)`, `sum(amount_pence)`, late count) — no per-staff row, name, rate, payslip or
 *    net figure is ever selected. Money stays integer pence; differences use `subtractPence`.
 *  - `assistantApprovalQueue`: counts of the workspace's payroll records awaiting approval (the same workspace-wide read
 *    `GET /payroll` gives a payroll.view holder), never amounts.
 * Layer 2 in both: `PayrollService.assertPayrollAccess(payroll.view)` — a workspace, the flag, and never a Venue Manager
 * (403). The field policy ('payroll_record') is applied: a hidden amount / worked time stays null, never re-derived. Own
 * READ ONLY tenant transaction (crewflow_app, RLS bound), 5 s per statement, pinned to the session's org AND workspace.
 */
@Injectable()
export class PayrollAssistantService {
  @Inject(FieldPolicyService)
  private readonly fieldPolicy!: FieldPolicyService;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly payroll: PayrollService,
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
  ) {}

  async assistantRunTotals(ctx: AuthContext, opts: { periodStart?: string; comparePeriodStart?: string }): Promise<AssistantRunComparison> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await beginAssistantRead(m);
      await this.payroll.assertPayrollAccess(m, ctx, PermissionFlag.PAYROLL_VIEW);
      const runs: Array<{ id: string; status: string; period_start: string; period_end: string; payday: string }> = await m.query(
        `SELECT r.id, r.status, to_char(p.period_start, 'YYYY-MM-DD') AS period_start, to_char(p.period_end, 'YYYY-MM-DD') AS period_end,
                to_char(p.payday, 'YYYY-MM-DD') AS payday
           FROM payroll_run r JOIN core.payroll_calendar_period p ON p.id = r.period_id
          WHERE r.organisation_id = $1 AND r.workspace_id = $2
          ORDER BY p.period_start, r.id`,
        [ctx.organisationId, ctx.workspaceId],
      );
      const current = opts.periodStart ? runs.find((r) => r.period_start === opts.periodStart) : runs[runs.length - 1];
      if (!current) return { available: false, reason: 'No payroll run exists for the requested period.' };
      const previous = opts.comparePeriodStart
        ? runs.find((r) => r.period_start === opts.comparePeriodStart) ?? null
        : runs.filter((r) => r.period_start < current.period_start).pop() ?? null;
      const ids = previous ? [current.id, previous.id] : [current.id];
      // The ONLY read of run lines: one aggregate row per run. Never per staff member.
      const totals: Array<{ run_id: string; records: number; staff: number; minutes: string; gross: string; late: number }> = await m.query(
        `SELECT l.run_id, count(*)::int AS records, count(DISTINCT l.staff_profile_id)::int AS staff,
                COALESCE(sum(l.worked_minutes), 0)::bigint AS minutes, COALESCE(sum(l.amount_pence), 0)::bigint AS gross,
                count(*) FILTER (WHERE l.late_approval)::int AS late
           FROM payroll_run_line l
          WHERE l.run_id = ANY($1::uuid[]) AND l.workspace_id = $2
          GROUP BY l.run_id`,
        [ids, ctx.workspaceId],
      );
      const policy = await this.fieldPolicy.resolveTx(m, ctx, 'payroll_record');
      const showAmount = this.fieldPolicy.isVisible(policy, 'amount');
      const showTime = this.fieldPolicy.isVisible(policy, 'workedTime');
      const totalsOf = (run: (typeof runs)[number]): AssistantRunTotals => {
        const t = totals.find((x) => x.run_id === run.id);
        const gross = Number(t?.gross ?? 0);
        if (!Number.isSafeInteger(gross)) throw new RangeError('payroll total out of range');
        return {
          periodStart: run.period_start,
          periodEnd: run.period_end,
          payday: run.payday,
          runStatus: run.status,
          shiftRecords: Number(t?.records ?? 0),
          staff: Number(t?.staff ?? 0),
          hours: showTime ? hoursOf(Number(t?.minutes ?? 0)) : null,
          grossTotalPence: showAmount ? gross : null,
          grossTotalFormatted: showAmount ? formatPence(gross) : null,
          lateApprovals: Number(t?.late ?? 0),
        };
      };
      const a = totalsOf(current);
      if (!previous) return { available: true, current: a, previous: null, differences: null };
      const b = totalsOf(previous);
      const grossDiff = a.grossTotalPence !== null && b.grossTotalPence !== null ? subtractPence(a.grossTotalPence, b.grossTotalPence) : null;
      return {
        available: true,
        current: a,
        previous: b,
        differences: {
          shiftRecords: a.shiftRecords - b.shiftRecords,
          staff: a.staff - b.staff,
          hours: a.hours !== null && b.hours !== null ? Math.round((a.hours - b.hours) * 100) / 100 : null,
          grossTotalPence: grossDiff,
          grossTotalFormatted: grossDiff === null ? null : formatPence(grossDiff),
          lateApprovals: a.lateApprovals - b.lateApprovals,
        },
      };
    });
  }

  /**
   * `get_timesheet_approval_queue` (P3 C9: gated by payroll.view, read-only counts as on `GET /payroll`). `range`
   * (optional) restricts to shifts STARTING in it. Attendance review states and unfinalised shift reports are the earlier
   * stages; they are counted only for a caller who also holds attendance.view, in the attendance / report read scope.
   */
  async assistantApprovalQueue(ctx: AuthContext, range: { from: Date; to: Date } | null, timeZone: string): Promise<AssistantApprovalQueue> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await beginAssistantRead(m);
      await this.payroll.assertPayrollAccess(m, ctx, PermissionFlag.PAYROLL_VIEW);
      const params: unknown[] = [ctx.organisationId, ctx.workspaceId, ctx.userId];
      let rangeSql = '';
      if (range) {
        params.push(range.from, range.to);
        rangeSql = ' AND s.starts_at >= $4 AND s.starts_at < $5';
      }
      const [queue] = await m.query(
        `SELECT count(*) FILTER (WHERE pr.status = 'pending_approval')::int AS awaiting,
                count(*) FILTER (WHERE pr.status = 'rejected')::int AS rejected,
                count(*) FILTER (WHERE pr.status = 'pending_approval' AND sp.user_id = $3)::int AS own,
                min(s.starts_at) FILTER (WHERE pr.status = 'pending_approval') AS oldest
           FROM payroll_record pr
           JOIN shift s ON s.id = pr.shift_id
           LEFT JOIN staff_profile sp ON sp.id = pr.staff_profile_id
          WHERE pr.organisation_id = $1 AND pr.workspace_id = $2${rangeSql}`,
        params,
      );
      const out: AssistantApprovalQueue = {
        awaitingApproval: Number(queue?.awaiting ?? 0),
        rejected: Number(queue?.rejected ?? 0),
        ownHoursAwaiting: Number(queue?.own ?? 0),
        oldestAwaitingShiftDate: queue?.oldest ? localDate(new Date(queue.oldest as string), timeZone) : null,
        attendanceUnderReview: null,
        attendanceDisputed: null,
        reportsNotFinalised: null,
      };
      if (await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.ATTENDANCE_VIEW)) Object.assign(out, await this.attendanceStages(m, ctx, range));
      return out;
    });
  }

  private async attendanceStages(m: EntityManager, ctx: AuthContext, range: { from: Date; to: Date } | null): Promise<Pick<AssistantApprovalQueue, 'attendanceUnderReview' | 'attendanceDisputed' | 'reportsNotFinalised'>> {
    const scope = await this.resourceScope.resolveTx(m, ctx);
    const params: unknown[] = [];
    const nextParam = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const scopeSql = attendanceReadScopeCondition(scope, ctx, nextParam);
    const rangeSql = range ? ` AND s.starts_at >= ${nextParam(range.from)} AND s.starts_at < ${nextParam(range.to)}` : '';
    const [att] = await m.query(
      `SELECT count(*) FILTER (WHERE a.status = 'under_review')::int AS under_review, count(*) FILTER (WHERE a.status = 'disputed')::int AS disputed
         FROM attendance a
         JOIN shift s ON s.id = a.shift_id
         JOIN staff_profile sp ON sp.id = a.staff_profile_id
        WHERE ${scopeSql}${rangeSql}`,
      params,
    );
    // The shift-report read scope (`ShiftReportService.listReports`): a Manager's own shifts (payroll refuses Venue Managers).
    const reportParams: unknown[] = [ctx.userId];
    const reportRange = range ? (reportParams.push(range.from, range.to), ' AND s.starts_at >= $2 AND s.starts_at < $3') : '';
    const [rep] = await m.query(
      `SELECT count(*)::int AS open FROM shift_report sr JOIN shift s ON s.id = sr.shift_id
        WHERE s.created_by = $1 AND sr.status IN ('pending', 'ready')${reportRange}`,
      reportParams,
    );
    return { attendanceUnderReview: Number(att?.under_review ?? 0), attendanceDisputed: Number(att?.disputed ?? 0), reportsNotFinalised: Number(rep?.open ?? 0) };
  }
}

function localDate(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  }
}
