import { PermissionFlag, PermissionFlagType } from '@rab/shared';
import { z } from 'zod';

import type { AiPermissionChecker, AiToolRunContextV2 } from '../../../modules/ai/contracts/tools';
import type { AiActor } from '../../../modules/ai/services/ai-access.service';
import { AiToolRegistry } from '../../../modules/ai/tools/ai-tool-registry.service';
import { ComparePayrollRunsTool } from '../../../modules/ai/tools/read/compare-payroll-runs.tool';
import { CountShiftsTool } from '../../../modules/ai/tools/read/count-shifts.tool';
import { FindShiftsTool } from '../../../modules/ai/tools/read/find-shifts.tool';
import { GetAttendanceSummaryTool } from '../../../modules/ai/tools/read/get-attendance-summary.tool';
import { GetFillRateTool } from '../../../modules/ai/tools/read/get-fill-rate.tool';
import { GetOfferPipelineTool } from '../../../modules/ai/tools/read/get-offer-pipeline.tool';
import { GetOfferStatusTool } from '../../../modules/ai/tools/read/get-offer-status.tool';
import { GetRotaCoverageGapsTool } from '../../../modules/ai/tools/read/get-rota-coverage-gaps.tool';
import { GetStaffAvailabilityTool } from '../../../modules/ai/tools/read/get-staff-availability.tool';
import { GetTimesheetApprovalQueueTool } from '../../../modules/ai/tools/read/get-timesheet-approval-queue.tool';
import { GetVenueSummaryTool } from '../../../modules/ai/tools/read/get-venue-summary.tool';
import { ListUnfilledShiftsTool } from '../../../modules/ai/tools/read/list-unfilled-shifts.tool';

/**
 * TEST-ONLY fakes for the Phase 3 tool-layer unit specs: every read tool instantiated with a fake domain service that
 * returns SEED-LIKE synthetic data (venue / role names like the AI Demo seed), so the fixture outputs can be scanned by
 * the payload guard (T-L3) without a database. `venueName` lets a spec inject a hostile or sensitive venue name.
 */
export const SHIFT_ID = '3f2a1234-1234-4123-8123-123456789012';
export const VENUE_ID = '5b0c6e1a-2d3f-4a5b-9c8d-7e6f5a4b3c2d';

export function fakeServices(opts: { venueName?: string; shifts?: number } = {}) {
  const venueName = opts.venueName ?? 'Riverside Hotel';
  const n = opts.shifts ?? 2;
  const shiftRow = (i: number) => ({
    shiftId: SHIFT_ID, venueName, jobRoleName: 'Bartender', startsAt: '2026-10-26T18:00:00.000Z', endsAt: '2026-10-27T02:00:00.000Z',
    status: 'open', requiredCount: 3, confirmedCount: 1, filledCount: 1, vacancies: 2 + (i % 2), pendingOffers: 1, awaitingConfirmation: 0,
  });
  const calls: string[] = [];
  const spy = <T>(name: string, value: T) => async () => {
    calls.push(name);
    return value;
  };
  return {
    calls,
    scheduling: {
      assistantStaffing: spy('assistantStaffing', {
        shiftCount: n, fullyStaffedShiftCount: 0, shiftsWithVacancies: n, seatsRequired: 3 * n, seatsFilled: n, seatsVacant: 2 * n, truncated: false,
        unfilledTotal: n, unfilled: Array.from({ length: n }, (_, i) => shiftRow(i)),
      }),
    },
    schedulingAssistant: {
      assistantFindShifts: spy('assistantFindShifts', { total: n, truncated: false, shifts: Array.from({ length: n }, (_, i) => shiftRow(i)) }),
      assistantShiftCounts: spy('assistantShiftCounts', {
        total: 3, truncated: false,
        byStatus: { open: 1, offered: 0, partially_filled: 1, fully_filled: 1, confirmed: 0, in_progress: 0, completed: 0, cancelled: 0 },
        byDay: [{ date: '2026-10-26', shifts: 3, seatsRequired: 5, seatsFilled: 2 }],
      }),
      assistantCoverageGaps: spy('assistantCoverageGaps', { gapGroups: 1, truncated: false, gaps: [{ date: '2026-10-26', venueName, jobRoleName: 'Bartender', shifts: 2, seatsVacant: 3 }] }),
      assistantVenueSummary: spy('assistantVenueSummary', {
        truncated: false, shiftsIncluded: true,
        venues: [{ venueId: VENUE_ID, venueName, venueStatus: 'active', shifts: 3, seatsRequired: 5, seatsFilled: 2, seatsVacant: 3, unfilledShifts: 2, offersAwaitingReply: 1 }],
      }),
    },
    attendance: {
      assistantAttendanceSummary: spy('assistantAttendanceSummary', {
        records: 2, byStatus: { scheduled: 0, clocked_in: 0, on_break: 0, clocked_out: 1, late: 0, missing_clock_out: 0, absent: 0, under_review: 0, approved: 1, disputed: 0 },
        lateClockIns: 1, lateGraceMinutes: 10, noShows: { confirmed: 0, provisional: 1 }, assignmentsStarting: 3, attendedAssignments: 2,
      }),
    },
    offers: { assistantOfferStatusCounts: spy('assistantOfferStatusCounts', { pending: 1, staff_accepted: 1, manager_confirmed: 0, manager_rejected: 0, declined: 1, expired: 0, withdrawn: 0 }) },
    offerAssistant: {
      assistantOfferPipeline: spy('assistantOfferPipeline', {
        byStatus: { pending: 1, staff_accepted: 1, manager_confirmed: 0, manager_rejected: 0, declined: 1, expired: 0, withdrawn: 0 }, total: 3,
        awaitingStaffResponse: 1, awaitingManagerConfirmation: 1, expiringWithin24h: 1, pendingOver24h: 0, medianResponseMinutes: 42,
      }),
    },
    payroll: {
      assistantRunTotals: spy('assistantRunTotals', {
        available: true,
        current: { periodStart: '2026-09-15', periodEnd: '2026-09-28', payday: '2026-10-02', runStatus: 'prepared', shiftRecords: 1, staff: 1, hours: 8, grossTotalPence: 15000, grossTotalFormatted: '£150.00', lateApprovals: 0 },
        previous: { periodStart: '2026-09-01', periodEnd: '2026-09-14', payday: '2026-09-18', runStatus: 'finalised', shiftRecords: 1, staff: 1, hours: 8, grossTotalPence: 12000, grossTotalFormatted: '£120.00', lateApprovals: 0 },
        differences: { shiftRecords: 0, staff: 0, hours: 0, grossTotalPence: 3000, grossTotalFormatted: '£30.00', lateApprovals: 0 },
      }),
      assistantApprovalQueue: spy('assistantApprovalQueue', {
        awaitingApproval: 2, rejected: 0, ownHoursAwaiting: 0, oldestAwaitingShiftDate: '2026-10-20', attendanceUnderReview: 1, attendanceDisputed: 0, reportsNotFinalised: 1,
      }),
    },
    staff: {
      assistantAvailabilityCounts: spy('assistantAvailabilityCounts', {
        activeStaff: 4, truncated: false,
        byDay: [{ date: '2026-10-26', weekday: 'Monday', declaredAvailable: 3, availableNotBooked: 2, booked: 1, notDeclared: 1 }],
      }),
    },
  };
}

export function toolInstances(svc: ReturnType<typeof fakeServices>) {
  return [
    new ComparePayrollRunsTool(svc.payroll as never),
    new CountShiftsTool(svc.schedulingAssistant as never),
    new FindShiftsTool(svc.schedulingAssistant as never),
    new GetAttendanceSummaryTool(svc.attendance as never),
    new GetFillRateTool(svc.scheduling as never),
    new GetOfferPipelineTool(svc.offerAssistant as never),
    new GetOfferStatusTool(svc.offers as never),
    new GetRotaCoverageGapsTool(svc.schedulingAssistant as never),
    new GetStaffAvailabilityTool(svc.staff as never),
    new GetTimesheetApprovalQueueTool(svc.payroll as never),
    new GetVenueSummaryTool(svc.schedulingAssistant as never),
    new ListUnfilledShiftsTool(svc.scheduling as never),
  ];
}

export const ALL_FLAGS: PermissionFlagType[] = [PermissionFlag.SCHEDULE_VIEW, PermissionFlag.ATTENDANCE_VIEW, PermissionFlag.PAYROLL_VIEW, PermissionFlag.VENUE_VIEW, PermissionFlag.STAFF_VIEW];

export function fakeActor(flags: PermissionFlagType[] = ALL_FLAGS): AiActor {
  return {
    organisationId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', userId: '33333333-3333-4333-8333-333333333333',
    sessionId: '44444444-4444-4444-8444-444444444444', timezone: 'Europe/London', permissions: new Set(flags), model: {} as never, realProviderPermitted: true,
  };
}

export function buildRegistry(opts: { venueName?: string; shifts?: number } = {}) {
  const svc = fakeServices(opts);
  const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  const access = { assertStillAllowed: jest.fn(async () => undefined), fingerprint: jest.fn(async () => 'fp') };
  const audit = { record: jest.fn(async (_m: unknown, _ctx: unknown, action: string, entry: { metadata: Record<string, unknown> }) => void audits.push({ action, metadata: entry.metadata })) };
  const tenant = { runInTenantContext: jest.fn(async (_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => fn({})) };
  const permissions = { userHasPermissionTx: jest.fn(async (_m: unknown, _c: unknown, _flag: string) => true) };
  // 4w: a fake load_skills handler that records its call like the real one (names only).
  const loadSkills = { execute: jest.fn(async (run: { calls: unknown[] }, _c: unknown, raw: { names?: string[] }) => (run.calls.push({ name: 'load_skills', outcome: 'ok', rows: raw?.names?.length ?? 0, kind: 'meta', skills: raw?.names ?? [] }), { notice: 'skill', data: { skills: [], missing: [] } })) };
  // 5b: fake write tools (name + permission + a strict input) and a proposal service that records createFromTool calls.
  const writes: Record<string, { permission: string; input: unknown }> = { create_draft_shift: { permission: 'schedule.create', input: z.strictObject({ venueId: z.string() }) }, add_staff_note: { permission: 'staff.edit', input: z.strictObject({ body: z.string() }) } };
  const proposals = {
    proposableTools: () => Object.entries(writes).map(([name, w]) => ({ name, ...w })),
    createFromTool: jest.fn(async () => ({ status: 'awaiting_user', proposalId: '00000000-0000-4000-8000-000000000001', summary: 'Draft a shift.' })),
  };
  const registry = new AiToolRegistry(toolInstances(svc), access as never, audit as never, tenant as never, permissions as never, loadSkills as never, proposals as never);
  return { registry, svc, access, audits, permissions, loadSkills, proposals };
}

export function fakeChecker(flags: PermissionFlagType[] = ALL_FLAGS): AiPermissionChecker & { assertStillAllowed: jest.Mock; fingerprint: jest.Mock } {
  const held = new Set(flags);
  return { principal: 'session', permissions: () => held, assertStillAllowed: jest.fn(async () => undefined), fingerprint: jest.fn(async () => 'fp-1') };
}

export function runContext(actor = fakeActor()): AiToolRunContextV2 & { aborts: string[]; plans: unknown[]; events: Array<[string, string, unknown?]> } {
  const aborts: string[] = [];
  const plans: unknown[] = [];
  const events: Array<[string, string, unknown?]> = [];
  const emit = {
    toolStarted: (name: string) => void events.push(['started', name]),
    toolFinished: (name: string, outcome: string) => void events.push(['finished', name, outcome]),
    offset: () => 0,
    plan: (steps: unknown) => void plans.push(steps),
  };
  return {
    actor, turnId: '55555555-5555-4555-8555-555555555555', conversationId: '66666666-6666-4666-8666-666666666666', abortTurn: (r) => void aborts.push(r),
    calls: [], emit, budget: { toolCalls: 0, learnCalls: 0, skillChars: 0 }, mode: 'interactive', aborts, plans, events,
  };
}

/** The wrapped data of a tool result. */
export const dataOf = (out: unknown) => (out as { data: Record<string, unknown> }).data;
