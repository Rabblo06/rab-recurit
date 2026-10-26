import './helpers/ai-env';

import { AI_READ_TOOL_NAMES, AiToolCallSummary, AiToolCallSummaryV2, PermissionFlag, PermissionFlagType } from '@rab/shared';
import { ForbiddenException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { ResourceScopeService } from '../../engine/core-modules/resource-scope/resource-scope.service';
import type { AiToolRunContextV2, AiTurnToolBinding } from '../../modules/ai/contracts/tools';
import { AiAccessService, AiActor, aiTenantContext } from '../../modules/ai/services/ai-access.service';
import { AI_OUTPUT_DENYLIST_KEY } from '../../modules/ai/tools/ai-output-guard';
import { AI_LEGACY_DIRECT_TOOL_NAMES, AiToolRegistry, AiToolRunContext } from '../../modules/ai/tools/ai-tool-registry.service';
import { AttendanceService } from '../../modules/attendance/services/attendance.service';
import { OfferAssistantService } from '../../modules/offer/services/offer-assistant.service';
import { OfferService } from '../../modules/offer/services/offer.service';
import { PayrollAssistantService } from '../../modules/payroll/services/payroll-assistant.service';
import { SchedulingAssistantService } from '../../modules/scheduling/services/scheduling-assistant.service';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { StaffAssistantService } from '../../modules/staff/services/staff-assistant.service';
import { INJECTION_TEXT, seedPayrollRuns, seedStaffing, StaffingFixture } from './helpers/ai-fixtures';
import { AiKit, aiOrganisation, bootAiKit, manager, setOrgAi } from './helpers/ai-test-kit';
import { TestIdentity } from './helpers/test-identities';

/**
 * AI read tools against real data under RLS (Phase 1 brief §15 "AI tools"; Phase 3 docs/ai/PHASE3_TWENTY_PLAN.md §7):
 *  - Phase 1 facts kept (the 5 direct tools through the `buildToolSet` facade the unchanged runner uses until 3w);
 *  - T-I1 every new tool on seeded data (facts, counts only, denylist scan, no staff email or name, bounds);
 *  - T-I2 foreign ids for every id-taking tool (another org, same-org colleague, random uuid → identical answers) and zero
 *    rows with no tenant context for every backing table;
 *  - T-I3 the permission matrix (flag removed → not catalogued, learn unknown, execute refused with no service call, audited);
 *  - T-I4 the 2 s fingerprint recheck (override insert, role permission revoke + version bump, org switch off, failures);
 *  - T-I5 the per-turn cap; T-I7 payroll integer pence, aggregate SQL only, venue manager refused; T-I8 the 5 s timeout.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const sidOf = (token: string): string => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
const ALL_TOOLS = [...AI_READ_TOOL_NAMES].sort();
const LEGACY = [...AI_LEGACY_DIRECT_TOOL_NAMES].sort();
const RANDOM_UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
type Wrapped = { notice: string; tool: string; data: Record<string, unknown> };
type SdkTool = { execute: (input: unknown, options: unknown) => Promise<unknown> };

function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) out.push(k), allKeys(v, out);
  return out;
}

describeIfDb('AI read tools (integration)', () => {
  jest.setTimeout(300_000);
  let kit: AiKit;
  let access: AiAccessService;
  let registry: AiToolRegistry;
  let ceo: TestIdentity;
  let token: string;
  let fx: StaffingFixture;
  let other: Awaited<ReturnType<typeof aiOrganisation>>;
  let otherFx: StaffingFixture;
  let colleagueFx: StaffingFixture;
  let today: string;
  let inAWeek: string;
  let yesterday: string;

  const day = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  const actorFor = async (identity: TestIdentity, tok: string): Promise<AiActor> =>
    access.rebuildForWorker({ organisationId: identity.organisationId, workspaceId: identity.workspaceId!, userId: identity.userId, sessionId: sidOf(tok) });
  const runCtx = (actor: AiActor, aborts: string[] = []): AiToolRunContext => ({ actor, turnId: crypto.randomUUID(), conversationId: crypto.randomUUID(), abortTurn: (r) => aborts.push(r), calls: [] as AiToolCallSummary[] });
  /** Phase 1 facade path (the runner until 3w). */
  const call = async (actor: AiActor, name: string, input: unknown, run = runCtx(actor)) => {
    const t = registry.buildToolSet(run)[name] as SdkTool | undefined;
    if (!t) throw new Error(`tool ${name} not offered`);
    return (await t.execute(input, { toolCallId: 'c1', messages: [] })) as Wrapped;
  };
  /** Phase 3 lazy path, exactly as 3w wires it: sessionChecker → forTurn → the SDK `execute_tool` / `learn_tools`. */
  const lazy = async (identity: TestIdentity, tok: string) => {
    const actor = await actorFor(identity, tok);
    const checker = await registry.sessionChecker(actor);
    const aborts: string[] = [];
    const run: AiToolRunContextV2 = {
      actor, turnId: crypto.randomUUID(), conversationId: crypto.randomUUID(), abortTurn: (r) => void aborts.push(r), calls: [] as AiToolCallSummaryV2[],
      emit: { toolStarted: () => undefined, toolFinished: () => undefined, offset: () => 0 }, budget: { toolCalls: 0, learnCalls: 0, skillChars: 0 }, mode: 'interactive',
    };
    const binding = await registry.forTurn(run, checker);
    const sdk = (name: string) => binding.toolSet[name] as unknown as SdkTool;
    const exec = async (name: string, args: unknown = {}) => (await sdk('execute_tool').execute({ name, args }, { toolCallId: 'x', messages: [] })) as Wrapped;
    const learn = async (names: string[]) => (await sdk('learn_tools').execute({ names }, { toolCallId: 'l', messages: [] })) as Wrapped;
    return { actor, checker, run, binding, exec, learn, aborts };
  };

  beforeAll(async () => {
    kit = await bootAiKit();
    access = kit.moduleRef.get(AiAccessService);
    registry = kit.moduleRef.get(AiToolRegistry);
    const org = await aiOrganisation(kit, 'ai-tools');
    ceo = org.ceo;
    token = org.token;
    fx = await seedStaffing(kit, ceo);
    await seedPayrollRuns(kit, ceo, fx);
    // Staff availability fixture: all four staff ACTIVE; staff 0 and 1 declare every weekday, 2 and 3 never declared.
    await kit.owner.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = ANY($1::uuid[])`, [fx.staff.map((s) => s.profileId)]);
    await kit.owner.query(`UPDATE core.staff_profile SET available_days = ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'] WHERE id = ANY($1::uuid[])`, [[fx.staff[0]!.profileId, fx.staff[1]!.profileId]]);
    // Foreign scopes: another organisation, and another Internal Manager of the SAME organisation, each with their own data.
    other = await aiOrganisation(kit, 'ai-tools-other');
    otherFx = await seedStaffing(kit, other.ceo);
    const colleague = await manager(kit, org.orgId);
    colleagueFx = await seedStaffing(kit, colleague.id);
    await kit.owner.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = ANY($1::uuid[])`, [[...otherFx.staff, ...colleagueFx.staff].map((s) => s.profileId)]);
    today = day(Date.now());
    inAWeek = day(Date.now() + 6 * 86_400_000);
    yesterday = day(Date.now() - 86_400_000 - 8 * 3600_000);
  });
  afterAll(async () => {
    await kit?.close();
  });

  // ------------------------------------------------------------------ registry, discovery, Phase 1 facts (kept)

  it('registry: exactly the 12 Phase 3 READ tools (no holiday tool), each with one flag, an allowlist, row and byte bounds', () => {
    expect(registry.catalogue().map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    expect(ALL_TOOLS).not.toContain('get_holiday_overlap');
    for (const t of registry.catalogue()) {
      expect(t.kind).toBe('read');
      expect(t.maxRows).toBeLessThanOrEqual(t.name === 'count_shifts' ? 62 : 25);
      expect(t.maxBytes).toBeLessThanOrEqual(16_384);
    }
    expect(() =>
      AiToolRegistry.validate([{ name: 'send_offers', kind: 'write' as never, description: 'd', summary: 's', permission: 'offer.send' as PermissionFlagType, input: null as never, outputKeys: ['x'], maxRows: 1, maxBytes: 1, limits: {}, run: async () => ({}) }]),
    ).toThrow(/read tools only/);
  });

  it('discovery (Phase 1 facade): a CEO sees the five direct tools; without payroll.view / attendance.view those are never offered', async () => {
    expect(registry.allowedToolNames(await actorFor(ceo, token)).sort()).toEqual(LEGACY);
    const org = await kit.factory.createOrganisation('ai-tools-narrow');
    await setOrgAi(kit, org.id, true);
    const narrow = await kit.factory.createCeo(org, { permissions: ['ai.use', 'schedule.view'] });
    const actor = await actorFor(narrow, await kit.factory.login(narrow));
    expect(registry.allowedToolNames(actor).sort()).toEqual(['get_fill_rate', 'get_offer_status', 'list_unfilled_shifts']);
    expect(Object.keys(registry.buildToolSet(runCtx(actor))).sort()).toEqual(['get_fill_rate', 'get_offer_status', 'list_unfilled_shifts']);
    const narrowLazy = await lazy(narrow, await kit.factory.login(narrow));
    expect(narrowLazy.binding.catalogue.map((l) => l.name)).toEqual(['count_shifts', 'find_shifts', 'get_fill_rate', 'get_offer_pipeline', 'get_offer_status', 'get_rota_coverage_gaps', 'list_unfilled_shifts']);
  });

  it('discovery (lazy): the catalogue = permitted read tools, name-sorted; the SDK set is only the fixed meta tools', async () => {
    const { binding } = await lazy(ceo, token);
    expect(binding.catalogue.map((l) => l.name)).toEqual(ALL_TOOLS);
    expect(Object.keys(binding.toolSet)).toEqual(['execute_tool', 'learn_tools', 'update_plan']);
  });

  it('list_unfilled_shifts: A (2 of 3) and D (1 of 1); drafts and full shifts excluded; injected names are plain bounded text', async () => {
    const out = await call(await actorFor(ceo, token), 'list_unfilled_shifts', { from: today, to: inAWeek });
    expect(out.notice).toMatch(/Untrusted record data/);
    expect(out.data).toMatchObject({ unfilledShiftCount: 2, listed: 2, truncated: false });
    const shifts = out.data.shifts as Array<Record<string, unknown>>;
    expect(shifts.map((s) => [s.shiftId, s.required, s.confirmed, s.vacancies])).toEqual([
      [fx.shifts.a, 3, 1, 2],
      [fx.shifts.d, 1, 0, 1],
    ]);
    expect(Object.keys(shifts[0]!).sort()).toEqual(['acceptedAwaitingConfirmation', 'confirmed', 'endsAt', 'jobRole', 'offersAwaitingReply', 'required', 'shiftId', 'startsAt', 'vacancies', 'venue']);
    const evil = String(shifts[1]!.venue);
    expect(evil.length).toBeLessThanOrEqual(160);
    expect(evil).not.toMatch(/[<>]/);
    expect(JSON.stringify(out)).not.toContain(INJECTION_TEXT); // shift notes / venue access notes are never read
  });

  it('get_fill_rate: 5 seats required, 2 filled → 40 %; 1 of 3 staffable shifts fully staffed', async () => {
    const out = await call(await actorFor(ceo, token), 'get_fill_rate', { from: today, to: inAWeek });
    expect(out.data).toMatchObject({ shifts: 3, fullyStaffedShifts: 1, shiftsWithVacancies: 2, seatsRequired: 5, seatsFilled: 2, seatsVacant: 3, seatFillRatePercent: 40, shiftFillRatePercent: 33.3 });
  });

  it('get_offer_status: the REAL statuses, counts only (pending 1, staff_accepted 1, declined 1)', async () => {
    const out = await call(await actorFor(ceo, token), 'get_offer_status', { from: today, to: inAWeek });
    expect(out.data).toMatchObject({ total: 3, awaitingStaffResponse: 1, awaitingManagerConfirmation: 1 });
    expect(out.data.byStatus).toEqual({ pending: 1, staff_accepted: 1, manager_confirmed: 0, manager_rejected: 0, declined: 1, expired: 0, withdrawn: 0 });
  });

  it('get_attendance_summary: 2 records, 1 late, 1 provisional no-show; + 3 booked assignments, 2 attended; no per-person data', async () => {
    const out = await call(await actorFor(ceo, token), 'get_attendance_summary', { from: yesterday, to: today });
    expect(out.data).toMatchObject({ records: 2, lateClockIns: 1, lateGraceMinutes: 10, noShows: { confirmed: 0, provisional: 1 }, assignmentsStarting: 3, attendedAssignments: 2 });
    expect(JSON.stringify(out.data)).not.toMatch(/staffId|minutes"?:\s*480|earn/i);
  });

  it('T-I7 compare_payroll_runs: integer pence + formatted string (£150.00 vs £120.00, +£30.00); never rates, names, payslips or per-person rows', async () => {
    const out = await call(await actorFor(ceo, token), 'compare_payroll_runs', {});
    expect(out.data).toMatchObject({
      available: true,
      current: { periodStart: '2026-09-15', grossTotalPence: 15000, grossTotalFormatted: '£150.00', shiftRecords: 1, staff: 1, hours: 8 },
      previous: { periodStart: '2026-09-01', grossTotalPence: 12000, grossTotalFormatted: '£120.00' },
      differences: { grossTotalPence: 3000, grossTotalFormatted: '£30.00', shiftRecords: 0 },
    });
    expect(Number.isInteger((out.data.current as Record<string, unknown>).grossTotalPence)).toBe(true);
    expect(JSON.stringify(out.data)).not.toMatch(/grossTotalPounds|1500\b|aistaff|@example\.test|payslip/i);
    expect(allKeys(out.data).filter((k) => AI_OUTPUT_DENYLIST_KEY.test(k))).toEqual([]);
  });

  it('T-I7 the payroll totals issue NO per-staff query (query-log spy): one aggregate over run lines, no names, no per-staff GROUP BY', async () => {
    const actor = await actorFor(ceo, token);
    const sql: string[] = [];
    const real = EntityManager.prototype.query;
    const spy = jest.spyOn(EntityManager.prototype, 'query').mockImplementation(function (this: EntityManager, q: string, p?: unknown[]) {
      sql.push(q);
      return real.call(this, q, p);
    });
    try {
      await kit.moduleRef.get(PayrollAssistantService).assistantRunTotals(aiTenantContext(actor), {});
    } finally {
      spy.mockRestore();
    }
    const lines = sql.filter((q) => /payroll_run_line/.test(q));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/sum\(l\.amount_pence\)/);
    expect(lines[0]).toMatch(/GROUP BY l\.run_id\s*$/);
    for (const q of sql) {
      expect(q).not.toMatch(/first_name|last_name|staff_ref|payslip|pay_rate_pence|net_pence/);
      expect(q).not.toMatch(/GROUP BY\s+l\.staff_profile_id/);
    }
  });

  it('T-I7 payroll is refused to a Venue Manager and without payroll.view (layer 2, direct service call)', async () => {
    const svc = kit.moduleRef.get(PayrollAssistantService);
    const vm = await kit.factory.createVenueManager({ id: ceo.organisationId }, { owner: ceo, venueIds: [fx.venueId] });
    const vmCtx = { organisationId: vm.organisationId, workspaceId: vm.workspaceId, userId: vm.userId, role: '' };
    await expect(svc.assistantRunTotals(vmCtx, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.assistantApprovalQueue(vmCtx, null, 'Europe/London')).rejects.toBeInstanceOf(ForbiddenException);
    const narrowOrg = await kit.factory.createOrganisation('ai-tools-nopay');
    const narrow = await kit.factory.createCeo(narrowOrg, { permissions: ['ai.use', 'schedule.view'] });
    await expect(svc.assistantRunTotals({ organisationId: narrow.organisationId, workspaceId: narrow.workspaceId, userId: narrow.userId, role: '' }, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ------------------------------------------------------------------ T-I1 new tools on seeded data

  it('T-I1 find_shifts: A, B and D (the draft C never); status and venue filters; operational fields only', async () => {
    const { exec } = await lazy(ceo, token);
    const all = await exec('find_shifts', { from: today, to: inAWeek, limit: 25 });
    expect(all.tool).toBe('find_shifts');
    expect(all.data).toMatchObject({ total: 3, listed: 3, truncated: false });
    const shifts = all.data.shifts as Array<Record<string, unknown>>;
    expect(shifts.map((s) => s.shiftId)).toEqual([fx.shifts.a, fx.shifts.b, fx.shifts.d]);
    expect(Object.keys(shifts[0]!).sort()).toEqual(['confirmed', 'endsAt', 'jobRole', 'required', 'shiftId', 'startsAt', 'status', 'vacancies', 'venue']);
    expect((await exec('find_shifts', { from: today, to: inAWeek, statuses: ['open'] })).data).toMatchObject({ total: 1 });
    const atEvil = await exec('find_shifts', { from: today, to: inAWeek, venueId: fx.injectionVenueId });
    expect((atEvil.data.shifts as Array<Record<string, unknown>>).map((s) => s.shiftId)).toEqual([fx.shifts.d]);
    expect((await exec('find_shifts', { from: today, to: inAWeek, limit: 1 })).data).toMatchObject({ total: 3, listed: 1, truncated: true });
  });

  it('T-I1 count_shifts: 3 shifts by status (draft not counted); per-day seats', async () => {
    const { exec } = await lazy(ceo, token);
    const out = await exec('count_shifts', { from: today, to: inAWeek });
    expect(out.data).toMatchObject({ total: 3, truncated: false });
    expect(out.data.byStatus).toMatchObject({ open: 1, partially_filled: 1, fully_filled: 1, cancelled: 0 });
    const days = out.data.byDay as Array<{ shifts: number; seatsRequired: number; seatsFilled: number }>;
    expect(days.reduce((n, d) => n + d.shifts, 0)).toBe(3);
    expect(days.reduce((n, d) => n + d.seatsRequired, 0)).toBe(5);
    expect(days.reduce((n, d) => n + d.seatsFilled, 0)).toBe(2);
  });

  it('T-I1 get_rota_coverage_gaps: 2 gap groups (A: 2 seats, D: 1 seat); venue names bounded', async () => {
    const { exec } = await lazy(ceo, token);
    const out = await exec('get_rota_coverage_gaps', { from: today, to: inAWeek });
    expect(out.data).toMatchObject({ gapGroups: 2, listed: 2, truncated: false });
    const gaps = out.data.gaps as Array<Record<string, unknown>>;
    expect(gaps.map((g) => g.seatsVacant).sort()).toEqual([1, 2]);
    for (const g of gaps) expect(String(g.venue).length).toBeLessThanOrEqual(160);
  });

  it('T-I1 get_venue_summary: the caller’s two venues (never the colleague’s), with shift figures', async () => {
    const { exec } = await lazy(ceo, token);
    const out = await exec('get_venue_summary', { from: today, to: inAWeek });
    const venues = out.data.venues as Array<Record<string, unknown>>;
    expect(venues.map((v) => v.venueId).sort()).toEqual([fx.venueId, fx.injectionVenueId].sort());
    expect(venues.find((v) => v.venueId === fx.venueId)).toMatchObject({ venue: 'Grand Hotel', venueStatus: 'active', shifts: 2, seatsRequired: 4, seatsFilled: 2, seatsVacant: 2, unfilledShifts: 1, offersAwaitingReply: 1 });
    expect(venues.map((v) => v.venueId)).not.toContain(colleagueFx.venueId);
    expect(JSON.stringify(out)).not.toContain(INJECTION_TEXT);
  });

  it('T-I1 get_offer_pipeline: status counts, 1 pending expiring within 24 h, no reasons or pay', async () => {
    const { exec } = await lazy(ceo, token);
    const out = await exec('get_offer_pipeline', { from: today, to: inAWeek });
    expect(out.data).toMatchObject({ total: 3, awaitingStaffResponse: 1, awaitingManagerConfirmation: 1, expiringWithin24h: 1, pendingOver24h: 0, medianResponseMinutes: null });
    expect(JSON.stringify(out.data)).not.toMatch(/reason|Pence|12000/i);
  });

  it('T-I1 get_staff_availability: weekday counts per day, advisory, never a name or id; range ≤ 14 days', async () => {
    const { exec } = await lazy(ceo, token);
    const aDay = day(Date.now() + 26 * 3600_000);
    const out = await exec('get_staff_availability', { from: aDay, to: aDay });
    expect(out.data).toMatchObject({ activeStaff: 4, truncated: false });
    // staff 0 is booked (confirmed on A) and declared; staff 1 declared and free; staff 2 / 3 never declared.
    expect((out.data.byDay as unknown[])[0]).toMatchObject({ date: aDay, declaredAvailable: 2, availableNotBooked: 1, booked: 1, notDeclared: 2 });
    expect(String(out.data.definition)).toMatch(/Advisory/);
    const text = JSON.stringify(out);
    for (const s of fx.staff) {
      expect(text).not.toContain(s.email);
      expect(text).not.toContain(s.profileId!);
    }
    expect((await exec('get_staff_availability', { from: today, to: day(Date.now() + 20 * 86_400_000) })).data).toMatchObject({ error: 'invalid_input' });
  });

  it('T-I1 get_timesheet_approval_queue: counts only (1 awaiting, oldest date) in a fresh organisation', async () => {
    const org = await aiOrganisation(kit, 'ai-tools-queue');
    const f = await seedStaffing(kit, org.ceo);
    await kit.owner.query(
      `INSERT INTO core.payroll_record (organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, status, worked_minutes, pay_rate_pence, amount_pence)
       VALUES ($1, $2, $3, $4, $5, 'pending_approval', 480, 1500, 12000)`,
      [org.orgId, org.ceo.workspaceId, f.attendance.onTime, f.shifts.e, f.staff[3]!.profileId],
    );
    const { exec } = await lazy(org.ceo, org.token);
    const out = await exec('get_timesheet_approval_queue', {});
    expect(out.data).toMatchObject({ range: null, awaitingApproval: 1, rejected: 0, ownHoursAwaiting: 0, oldestAwaitingShiftDate: day(Date.now() - 30 * 3600_000), attendanceUnderReview: 0, attendanceDisputed: 0, reportsNotFinalised: 0 });
    expect(JSON.stringify(out.data)).not.toMatch(/12000|amount|Pence/i);
  });

  it('T-I1 every tool output passes the denylist key scan and contains no staff email or name', async () => {
    const { exec } = await lazy(ceo, token);
    const emails = fx.staff.map((s) => s.email);
    const args: Record<string, unknown> = {
      compare_payroll_runs: {}, count_shifts: { from: today, to: inAWeek }, find_shifts: { from: today, to: inAWeek }, get_attendance_summary: { from: yesterday, to: today },
      get_fill_rate: { from: today, to: inAWeek }, get_offer_pipeline: { from: today, to: inAWeek }, get_offer_status: { from: today, to: inAWeek }, get_rota_coverage_gaps: { from: today, to: inAWeek },
      get_staff_availability: { from: today, to: inAWeek }, get_timesheet_approval_queue: {}, get_venue_summary: { from: today, to: inAWeek }, list_unfilled_shifts: { from: today, to: inAWeek },
    };
    for (const name of ALL_TOOLS) {
      const out = await exec(name, args[name]);
      expect({ name, error: out.data.error }).toEqual({ name, error: undefined });
      expect({ name, bad: allKeys(out.data).filter((k) => AI_OUTPUT_DENYLIST_KEY.test(k)) }).toEqual({ name, bad: [] });
      for (const e of emails) expect(JSON.stringify(out)).not.toContain(e);
    }
  });

  // ------------------------------------------------------------------ T-I2 foreign ids, no tenant context

  it('T-I2 foreign ids: another org’s ids, a same-org colleague’s ids and a random uuid give IDENTICAL empty answers for every id-taking tool', async () => {
    const cases: Array<[string, (id: { venue: string; role: string }) => Record<string, unknown>]> = [
      ['find_shifts', (id) => ({ from: today, to: inAWeek, venueId: id.venue })],
      ['find_shifts', (id) => ({ from: today, to: inAWeek, jobRoleId: id.role })],
      ['get_rota_coverage_gaps', (id) => ({ from: today, to: inAWeek, venueId: id.venue })],
      ['get_rota_coverage_gaps', (id) => ({ from: today, to: inAWeek, jobRoleId: id.role })],
      ['get_venue_summary', (id) => ({ from: today, to: inAWeek, venueId: id.venue })],
      ['get_staff_availability', (id) => ({ from: today, to: today, jobRoleId: id.role })],
    ];
    const ids = { orgB: { venue: otherFx.venueId, role: otherFx.jobRoleId }, colleague: { venue: colleagueFx.venueId, role: colleagueFx.jobRoleId }, random: { venue: RANDOM_UUID, role: RANDOM_UUID } };
    for (const [name, args] of cases) {
      const { exec } = await lazy(ceo, token); // one turn per case (3 calls; the 12-call cap is per turn)
      const a = await exec(name, args(ids.orgB));
      const b = await exec(name, args(ids.colleague));
      const c = await exec(name, args(ids.random));
      expect({ name, a: JSON.stringify(a) }).toEqual({ name, a: JSON.stringify(c) });
      expect({ name, b: JSON.stringify(b) }).toEqual({ name, b: JSON.stringify(c) });
      expect(a.data.error).toBeUndefined();
      expect((a.data.shifts ?? a.data.gaps ?? a.data.venues ?? []) as unknown[]).toEqual([]);
      if (name === 'get_staff_availability') expect(a.data).toMatchObject({ activeStaff: 0 });
    }
    // The tools that take no id: another organisation's CEO sees none of this organisation's records.
    const theirs = await lazy(other.ceo, other.token);
    for (const name of ['find_shifts', 'get_venue_summary', 'get_rota_coverage_gaps']) {
      const text = JSON.stringify(await theirs.exec(name, { from: today, to: inAWeek }));
      for (const id of [fx.shifts.a, fx.shifts.b, fx.shifts.d, fx.venueId]) expect(text).not.toContain(id);
    }
  });

  it('T-I2 every backing table returns ZERO rows to crewflow_app with no tenant context bound', async () => {
    const tables = ['shift', 'shift_assignment', 'job_offer', 'attendance', 'staff_profile', 'venue', 'job_role', 'manager_venue', 'payroll_record', 'payroll_run', 'payroll_run_line', 'payroll_calendar_period', 'shift_report', 'organisation_ai_setting', 'user_permission_override'];
    for (const t of tables) {
      const [row] = await kit.runtime.query(`SELECT count(*)::int AS n FROM core.${t}`);
      expect({ t, n: row.n }).toEqual({ t, n: 0 });
    }
  });

  // ------------------------------------------------------------------ T-I3 permission matrix

  it.each([PermissionFlag.SCHEDULE_VIEW, PermissionFlag.STAFF_VIEW, PermissionFlag.VENUE_VIEW, PermissionFlag.ATTENDANCE_VIEW, PermissionFlag.PAYROLL_VIEW])(
    'T-I3 %s removed: its tools are not catalogued, learn says unknown, execute is refused with no service call, audited denied',
    async (flag) => {
      const gated = registry.catalogue().filter((t) => t.permission === flag).map((t) => t.name);
      expect(gated.length).toBeGreaterThan(0);
      await kit.owner.query(
        `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3`,
        [ceo.userId, ceo.organisationId, flag],
      );
      const services = [SchedulingService, SchedulingAssistantService, OfferService, OfferAssistantService, AttendanceService, StaffAssistantService, PayrollAssistantService].map(
        (s) => kit.moduleRef.get(s as never) as object,
      );
      const spies = services.flatMap((svc) => Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).filter((k) => k.startsWith('assistant')).map((k) => jest.spyOn(svc as never, k as never)));
      try {
        const { binding, exec, learn, run } = await lazy(ceo, token);
        for (const name of gated) expect(binding.catalogue.map((l) => l.name)).not.toContain(name);
        const learned = await learn(gated.slice(0, 5));
        expect(learned.data).toMatchObject({ tools: [] });
        expect((learned.data.unknown as unknown[]).length).toBe(Math.min(5, gated.length));
        for (const name of gated) {
          const out = await exec(name, { from: today, to: today });
          expect(out.data).toMatchObject({ error: 'unknown_tool' });
          expect(JSON.stringify(out)).not.toContain(name);
        }
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        const denied = await kit.owner.query(`SELECT metadata->>'tool' AS tool, metadata->>'outcome' AS outcome FROM core.audit_log WHERE entity_id = $1 AND action = 'ai.tool_denied'`, [run.turnId]);
        expect(denied.filter((d: { outcome: string }) => d.outcome === 'denied').map((d: { tool: string }) => d.tool).sort()).toEqual([...gated].sort());
      } finally {
        for (const spy of spies) spy.mockRestore();
        await kit.owner.query(`DELETE FROM core.user_permission_override WHERE user_id = $1`, [ceo.userId]);
      }
    },
  );

  // ------------------------------------------------------------------ T-I4 the 2 s recheck (own timer harness until 3w)

  const harness = (binding: AiTurnToolBinding) => {
    const started = Date.now();
    const timer = setInterval(() => void binding.recheck().catch(() => undefined), 2_000);
    return { stop: () => clearInterval(timer), started };
  };
  const waitFor = async (cond: () => boolean, ms: number) => {
    const until = Date.now() + ms;
    while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  };

  it('T-I4 a direct user_permission_override insert (no version bump) changes the fingerprint and aborts the turn within 2.5 s', async () => {
    const org = await aiOrganisation(kit, 'ai-tools-fp1');
    const t = await lazy(org.ceo, org.token);
    const before = await access.fingerprint(t.actor);
    await kit.owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = 'payroll.view'`,
      [org.ceo.userId, org.orgId],
    );
    expect(await access.fingerprint(t.actor)).not.toBe(before);
    const h = harness(t.binding);
    await waitFor(() => t.aborts.length > 0, 3_000);
    const elapsed = Date.now() - h.started;
    h.stop();
    expect(t.aborts).toEqual(['access_revoked']);
    expect(elapsed).toBeLessThanOrEqual(2_500);
    await expect(t.exec('find_shifts', { from: today, to: today })).rejects.toThrow(); // no further tool runs
  });

  it('T-I4 a role permission revoked with a version bump, and the org AI switch turned off, are both caught by the fingerprint', async () => {
    const org = await aiOrganisation(kit, 'ai-tools-fp2');
    const t = await lazy(org.ceo, org.token);
    await kit.owner.query(
      `DELETE FROM core.role_permission rp USING core.user_role ur, core.permission p
        WHERE rp.role_id = ur.role_id AND ur.user_id = $1 AND p.id = rp.permission_id AND p.key = 'attendance.view'`,
      [org.ceo.userId],
    );
    await kit.owner.query(`UPDATE core.role SET permission_version = permission_version + 1 WHERE id IN (SELECT role_id FROM core.user_role WHERE user_id = $1)`, [org.ceo.userId]);
    await expect(t.binding.recheck()).rejects.toThrow();
    expect(t.aborts).toEqual(['access_revoked']);

    const org2 = await aiOrganisation(kit, 'ai-tools-fp3');
    const t2 = await lazy(org2.ceo, org2.token);
    await t2.binding.recheck(); // unchanged → nothing
    expect(t2.aborts).toEqual([]);
    await setOrgAi(kit, org2.orgId, false);
    await expect(t2.binding.recheck()).rejects.toThrow();
    expect(t2.aborts).toEqual(['access_revoked']);
  });

  it('T-I4 three consecutive fingerprint failures abort with service_unavailable (fail closed)', async () => {
    const t = await lazy(ceo, token);
    const spy = jest.spyOn(access, 'fingerprint').mockRejectedValue(new Error('connection lost'));
    try {
      await t.binding.recheck();
      await t.binding.recheck();
      expect(t.aborts).toEqual([]);
      await expect(t.binding.recheck()).rejects.toThrow();
      expect(t.aborts).toEqual(['service_unavailable']);
    } finally {
      spy.mockRestore();
    }
  });

  // ------------------------------------------------------------------ T-I5 per-turn cap, strict input, bounds

  it('T-I5 20 parallel execute_tool calls in one turn → 12 run, 8 tool_call_limit; the audit matches', async () => {
    const t = await lazy(ceo, token);
    const outs = await Promise.all(Array.from({ length: 20 }, () => t.exec('get_fill_rate', { from: today, to: inAWeek })));
    expect(outs.filter((o) => o.data.error === 'tool_call_limit')).toHaveLength(8);
    expect(t.run.calls.filter((c) => c.outcome === 'ok')).toHaveLength(12);
    const rows: Array<{ action: string; outcome: string }> = await kit.owner.query(`SELECT action, metadata->>'outcome' AS outcome FROM core.audit_log WHERE entity_id = $1`, [t.run.turnId]);
    expect(rows.filter((r) => r.action === 'ai.tool_called' && r.outcome === 'ok')).toHaveLength(12);
    expect(rows.filter((r) => r.action === 'ai.tool_denied' && r.outcome === 'tool_call_limit')).toHaveLength(8);
  });

  it('strict input: unknown fields (organisationId, workspaceId, staffId, sql) and out-of-range values are refused and never executed', async () => {
    const actor = await actorFor(ceo, token);
    const run = runCtx(actor);
    for (const input of [
      { from: today, to: inAWeek, organisationId: '00000000-0000-0000-0000-000000000000' },
      { from: today, to: inAWeek, workspaceId: ceo.workspaceId },
      { from: today, to: inAWeek, sql: 'SELECT * FROM core.user' },
      { from: today, to: inAWeek, limit: 500 },
      { from: '2026-01-01', to: '2026-12-31' },
      { from: 'yesterday', to: today },
    ]) {
      const out = await call(actor, 'list_unfilled_shifts', input, run);
      expect(out.data).toEqual({ error: 'invalid_input' });
    }
    expect(run.calls.every((c) => c.outcome === 'invalid_input')).toBe(true);
    const denied = await kit.owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE entity_id = $1 AND action = 'ai.tool_denied'`, [run.turnId]);
    expect(denied[0].n).toBe(6);
  });

  it('bounding: at most 25 rows reach the model whatever exists; the true total is reported', async () => {
    const org = await aiOrganisation(kit, 'ai-tools-bound');
    const f = await seedStaffing(kit, org.ceo);
    for (let i = 0; i < 30; i++) {
      await kit.owner.query(
        `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, pay_rate_pence, status, created_by, workspace_id)
         VALUES ($1, $2, $3, now() + interval '30 hours' + ($4 || ' minutes')::interval, now() + interval '38 hours', 0, 1, 1500, 'open', $5, $6)`,
        [org.orgId, f.venueId, f.jobRoleId, String(i), org.ceo.userId, org.ceo.workspaceId],
      );
    }
    const out = await call(await actorFor(org.ceo, org.token), 'list_unfilled_shifts', { from: today, to: inAWeek, limit: 25 });
    expect(out.data).toMatchObject({ unfilledShiftCount: 32, listed: 25 });
    expect((out.data.shifts as unknown[]).length).toBe(25);
    const { exec } = await lazy(org.ceo, org.token);
    expect((await exec('find_shifts', { from: today, to: inAWeek, limit: 25 })).data).toMatchObject({ total: 33, listed: 25, truncated: true });
  });

  it('execution-time recheck (facade): a flag revoked after discovery refuses the call and stops the turn', async () => {
    const actor = await actorFor(ceo, token);
    const aborts: string[] = [];
    const run = runCtx(actor, aborts);
    const tools = registry.buildToolSet(run); // offered while the flag was held
    await kit.owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = 'payroll.view'`,
      [ceo.userId, ceo.organisationId],
    );
    try {
      await expect((tools.compare_payroll_runs as unknown as SdkTool).execute({}, { toolCallId: 'c', messages: [] })).rejects.toThrow();
      expect(aborts).toEqual(['access_revoked']);
      expect(run.calls).toEqual([{ name: 'compare_payroll_runs', outcome: 'denied', rows: null }]);
      expect(registry.allowedToolNames(await actorFor(ceo, token))).not.toContain('compare_payroll_runs');
    } finally {
      await kit.owner.query(`DELETE FROM core.user_permission_override WHERE user_id = $1`, [ceo.userId]);
    }
  });

  // ------------------------------------------------------------------ T-I8 the 5 s statement timeout

  it('T-I8 an assistant read stuck in the database is cancelled at 5 s → tool_failed; the turn continues', async () => {
    const t = await lazy(ceo, token);
    const scope = kit.moduleRef.get(ResourceScopeService);
    const real = scope.resolveTx.bind(scope);
    const spy = jest.spyOn(scope, 'resolveTx').mockImplementationOnce(async (m, ctx) => {
      await m.query('SELECT pg_sleep(8)');
      return real(m, ctx);
    });
    try {
      const started = Date.now();
      const out = await t.exec('count_shifts', { from: today, to: inAWeek });
      const elapsed = Date.now() - started;
      expect(out.data).toEqual({ error: 'tool_failed' });
      expect(elapsed).toBeGreaterThanOrEqual(4_900);
      expect(elapsed).toBeLessThan(7_500);
      expect(t.aborts).toEqual([]);
      expect((await t.exec('count_shifts', { from: today, to: inAWeek })).data).toMatchObject({ total: 3 }); // the next call works
    } finally {
      spy.mockRestore();
    }
  });

  it('tenant isolation: another organisation’s CEO asking the same tool sees none of these shifts', async () => {
    const out = await call(await actorFor(other.ceo, other.token), 'list_unfilled_shifts', { from: today, to: inAWeek });
    expect((out.data.shifts as Array<Record<string, unknown>>).map((s) => s.shiftId)).not.toContain(fx.shifts.a);
    expect((out.data.shifts as Array<Record<string, unknown>>).map((s) => s.shiftId)).toEqual([otherFx.shifts.a, otherFx.shifts.d]);
  });
});
