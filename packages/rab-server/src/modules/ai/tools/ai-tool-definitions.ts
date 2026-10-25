import { AttendanceStatus, OfferStatus, PermissionFlag } from '@rab/shared';
import { z } from 'zod';

import { AttendanceService } from '../../attendance/services/attendance.service';
import { OfferService } from '../../offer/services/offer.service';
import { PayrollRunService, PeriodRunSummary } from '../../payroll/services/payroll-run.service';
import { SchedulingService } from '../../scheduling/services/scheduling.service';
import { AI_TOOL_MAX_ROWS } from '../constants/ai.constants';
import { aiTenantContext } from '../services/ai-access.service';
import { isoDay, localRange, rangeInput, rangeShape, rangeWithin } from './ai-date-range';
import { AiToolDefinition } from './ai-tool.types';

export interface AiToolServices {
  scheduling: SchedulingService;
  offers: OfferService;
  attendance: AttendanceService;
  payrollRuns: PayrollRunService;
}

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/**
 * The five Phase-1 tools. All READ, all aggregate or operational-only, all backed by an existing domain service method
 * that re-checks its own permission and runs in its own short tenant transaction (never a transaction held across the
 * model call). Descriptions are fixed server text; nothing the model or a record supplies is ever placed in them.
 */
export function buildAiToolDefinitions(svc: AiToolServices): AiToolDefinition[] {
  const listUnfilled: AiToolDefinition = {
    name: 'list_unfilled_shifts',
    description:
      'Shifts starting in a date range (organisation local days, at most 31) that still need staff. Returns, per shift: id, venue name (only if the user may view venues), job role, start/end time, required, confirmed and remaining vacancies. Read-only.',
    kind: 'read',
    permission: PermissionFlag.SCHEDULE_VIEW,
    input: z
      .strictObject({ ...rangeShape, limit: z.number().int().min(1).max(AI_TOOL_MAX_ROWS).optional().describe('How many shifts to list (default 10).') })
      .refine(rangeWithin(31), { message: '"to" must be on or after "from" and the range at most 31 days.' }),
    outputKeys: ['range', 'from', 'to', 'unfilledShiftCount', 'listed', 'truncated', 'shifts', 'shiftId', 'venue', 'jobRole', 'startsAt', 'endsAt', 'required', 'confirmed', 'vacancies', 'offersAwaitingReply', 'acceptedAwaitingConfirmation'],
    maxRows: AI_TOOL_MAX_ROWS,
    async run(actor, input) {
      const args = input as { from: string; to: string; limit?: number };
      const snapshot = await svc.scheduling.assistantStaffing(aiTenantContext(actor), localRange(args.from, args.to, actor.timezone), { unfilledLimit: args.limit ?? 10 });
      return {
        range: { from: args.from, to: args.to },
        unfilledShiftCount: snapshot.unfilledTotal,
        listed: snapshot.unfilled.length,
        truncated: snapshot.truncated,
        shifts: snapshot.unfilled.map((s) => ({
          shiftId: s.shiftId,
          venue: s.venueName,
          jobRole: s.jobRoleName,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          required: s.requiredCount,
          confirmed: s.confirmedCount,
          vacancies: s.vacancies,
          offersAwaitingReply: s.pendingOffers,
          acceptedAwaitingConfirmation: s.awaitingConfirmation,
        })),
      };
    },
  };

  const fillRate: AiToolDefinition = {
    name: 'get_fill_rate',
    description:
      'Fill rate of shifts starting in a date range (organisation local days, at most 62): counts of shifts and seats required/filled/vacant and the resulting percentages. Counts only. Read-only.',
    kind: 'read',
    permission: PermissionFlag.SCHEDULE_VIEW,
    input: rangeInput(62),
    outputKeys: ['range', 'from', 'to', 'shifts', 'fullyStaffedShifts', 'shiftsWithVacancies', 'seatsRequired', 'seatsFilled', 'seatsVacant', 'seatFillRatePercent', 'shiftFillRatePercent', 'truncated', 'definition'],
    maxRows: AI_TOOL_MAX_ROWS,
    async run(actor, input) {
      const args = input as { from: string; to: string };
      const s = await svc.scheduling.assistantStaffing(aiTenantContext(actor), localRange(args.from, args.to, actor.timezone), { unfilledLimit: 0 });
      return {
        range: { from: args.from, to: args.to },
        shifts: s.shiftCount,
        fullyStaffedShifts: s.fullyStaffedShiftCount,
        shiftsWithVacancies: s.shiftsWithVacancies,
        seatsRequired: s.seatsRequired,
        seatsFilled: s.seatsFilled,
        seatsVacant: s.seatsVacant,
        seatFillRatePercent: pct(s.seatsFilled, s.seatsRequired),
        shiftFillRatePercent: pct(s.fullyStaffedShiftCount, s.shiftCount),
        truncated: s.truncated,
        definition: 'Seats filled = confirmed or completed assignments (unreviewed no-shows still hold their seat), capped at the required count; open, offered, partially/fully filled, confirmed, in-progress and completed shifts only.',
      };
    },
  };

  const attendance: AiToolDefinition = {
    name: 'get_attendance_summary',
    description:
      'Aggregated attendance counts for a date range (organisation local days, at most 92): clock-ins by attendance status, late clock-ins and no-shows (confirmed vs provisional). Organisation totals only, never per person; not an employment judgement. Read-only.',
    kind: 'read',
    permission: PermissionFlag.ATTENDANCE_VIEW,
    input: rangeInput(92),
    outputKeys: ['range', 'from', 'to', 'records', 'byStatus', ...Object.values(AttendanceStatus), 'lateClockIns', 'lateGraceMinutes', 'noShows', 'confirmed', 'provisional', 'definition'],
    maxRows: AI_TOOL_MAX_ROWS,
    async run(actor, input) {
      const args = input as { from: string; to: string };
      const s = await svc.attendance.assistantAttendanceSummary(aiTenantContext(actor), localRange(args.from, args.to, actor.timezone));
      return {
        range: { from: args.from, to: args.to },
        records: s.records,
        byStatus: s.byStatus,
        lateClockIns: s.lateClockIns,
        lateGraceMinutes: s.lateGraceMinutes,
        noShows: s.noShows,
        definition: `A late clock-in is one recorded more than ${s.lateGraceMinutes} minutes after the assignment start. A provisional no-show has not been reviewed by a manager yet.`,
      };
    },
  };

  const offers: AiToolDefinition = {
    name: 'get_offer_status',
    description:
      'How many shift offers are in each offer status, for offers on assignments starting in a date range (organisation local days, at most 92). Statuses: pending (waiting for the staff member), staff_accepted (accepted, awaiting manager confirmation), manager_confirmed, manager_rejected, declined, expired, withdrawn. Counts only. Read-only.',
    kind: 'read',
    permission: PermissionFlag.SCHEDULE_VIEW,
    input: rangeInput(92),
    outputKeys: ['range', 'from', 'to', 'total', 'awaitingStaffResponse', 'awaitingManagerConfirmation', 'byStatus', ...Object.values(OfferStatus)],
    maxRows: AI_TOOL_MAX_ROWS,
    async run(actor, input) {
      const args = input as { from: string; to: string };
      const counts = await svc.offers.assistantOfferStatusCounts(aiTenantContext(actor), localRange(args.from, args.to, actor.timezone));
      return {
        range: { from: args.from, to: args.to },
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        awaitingStaffResponse: counts[OfferStatus.PENDING],
        awaitingManagerConfirmation: counts[OfferStatus.STAFF_ACCEPTED],
        byStatus: counts,
      };
    },
  };

  const payroll: AiToolDefinition = {
    name: 'compare_payroll_runs',
    description:
      'Compares the totals of two payroll runs of this workspace (by default the two most recent runs; or the runs of the periods starting on the given dates): shift records, staff count, hours, gross total and late approvals, and the differences. Aggregate totals only — never individual pay, rates, bank details or payslips. Read-only.',
    kind: 'read',
    permission: PermissionFlag.PAYROLL_VIEW,
    input: z.strictObject({
      periodStart: isoDay.optional().describe('Start date of the period to examine (default: the latest period with a run).'),
      comparePeriodStart: isoDay.optional().describe('Start date of the period to compare with (default: the run before it).'),
    }),
    outputKeys: ['current', 'previous', 'differences', 'periodStart', 'periodEnd', 'payday', 'runStatus', 'shiftRecords', 'staff', 'hours', 'grossTotalPounds', 'lateApprovals', 'available', 'reason'],
    maxRows: AI_TOOL_MAX_ROWS,
    async run(actor, input) {
      const args = input as { periodStart?: string; comparePeriodStart?: string };
      const ctx = aiTenantContext(actor);
      const { periods } = await svc.payrollRuns.listPeriods(ctx);
      const withRuns = periods.filter((p): p is PeriodRunSummary & { run: NonNullable<PeriodRunSummary['run']> } => Boolean(p.run)).sort((a, b) => a.period.start.localeCompare(b.period.start));
      const current = args.periodStart ? withRuns.find((p) => p.period.start === args.periodStart) : withRuns[withRuns.length - 1];
      if (!current) return { available: false, reason: 'No payroll run exists for the requested period.' };
      const previous = args.comparePeriodStart
        ? withRuns.find((p) => p.period.start === args.comparePeriodStart)
        : withRuns.filter((p) => p.period.start < current.period.start).pop();
      const totalsOf = async (p: (typeof withRuns)[number]) => {
        const view = await svc.payrollRuns.detail(ctx, p.run.id);
        const t = view.totals as Partial<typeof view.totals>;
        return {
          periodStart: p.period.start,
          periodEnd: p.period.end,
          payday: p.period.payday,
          runStatus: view.status,
          shiftRecords: t.records ?? null,
          staff: t.staff ?? null,
          hours: typeof t.minutes === 'number' ? Math.round((t.minutes / 60) * 100) / 100 : null,
          // A field hidden by the caller's field policy stays hidden (null), never re-derived.
          grossTotalPounds: typeof t.grossPence === 'number' ? Math.round(t.grossPence) / 100 : null,
          lateApprovals: t.lateCount ?? null,
        };
      };
      const a = await totalsOf(current);
      if (!previous) return { available: true, current: a, previous: null, differences: null };
      const b = await totalsOf(previous);
      const diff = (x: number | null, y: number | null) => (x === null || y === null ? null : Math.round((x - y) * 100) / 100);
      return {
        available: true,
        current: a,
        previous: b,
        differences: {
          shiftRecords: diff(a.shiftRecords, b.shiftRecords),
          staff: diff(a.staff, b.staff),
          hours: diff(a.hours, b.hours),
          grossTotalPounds: diff(a.grossTotalPounds, b.grossTotalPounds),
          lateApprovals: diff(a.lateApprovals, b.lateApprovals),
        },
      };
    },
  };

  return [listUnfilled, fillRate, attendance, offers, payroll];
}
