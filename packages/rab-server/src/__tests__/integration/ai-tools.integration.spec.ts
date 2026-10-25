import './helpers/ai-env';

import { AiToolCallSummary } from '@rab/shared';

import { AiAccessService, AiActor } from '../../modules/ai/services/ai-access.service';
import { AI_OUTPUT_DENYLIST_KEY } from '../../modules/ai/tools/ai-output-guard';
import { AiToolRegistry, AiToolRunContext } from '../../modules/ai/tools/ai-tool-registry.service';
import { INJECTION_TEXT, seedPayrollRuns, seedStaffing, StaffingFixture } from './helpers/ai-fixtures';
import { AiKit, aiOrganisation, bootAiKit } from './helpers/ai-test-kit';
import { TestIdentity } from './helpers/test-identities';

/**
 * AI Phase 1 — the five read tools against real data under RLS (brief §15 "AI tools"): discovery filtered by permission,
 * the real numbers, strict input (unknown fields refused, never executed), the execution-time recheck, row bounds, the
 * sensitive-field denylist scan of every output, payroll gating and tenant isolation.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const sidOf = (token: string): string => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
const ALL_TOOLS = ['compare_payroll_runs', 'get_attendance_summary', 'get_fill_rate', 'get_offer_status', 'list_unfilled_shifts'];

function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) out.push(k), allKeys(v, out);
  return out;
}

describeIfDb('AI read tools (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let access: AiAccessService;
  let registry: AiToolRegistry;
  let ceo: TestIdentity;
  let token: string;
  let fx: StaffingFixture;
  let today: string;
  let inAWeek: string;
  let yesterday: string;

  const actorFor = async (identity: TestIdentity, tok: string): Promise<AiActor> =>
    access.rebuildForWorker({ organisationId: identity.organisationId, workspaceId: identity.workspaceId!, userId: identity.userId, sessionId: sidOf(tok) });
  const runCtx = (actor: AiActor, aborts: string[] = []): AiToolRunContext => ({ actor, turnId: crypto.randomUUID(), conversationId: crypto.randomUUID(), abortTurn: (r) => aborts.push(r), calls: [] as AiToolCallSummary[] });
  const call = async (actor: AiActor, name: string, input: unknown, run = runCtx(actor)) => {
    const tools = registry.buildToolSet(run);
    const t = tools[name] as { execute: (i: unknown, o: unknown) => Promise<{ notice: string; tool: string; data: Record<string, unknown> }> } | undefined;
    if (!t) throw new Error(`tool ${name} not offered`);
    return t.execute(input, { toolCallId: 'c1', messages: [] });
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
    const day = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    today = day(Date.now());
    inAWeek = day(Date.now() + 6 * 86_400_000);
    yesterday = day(Date.now() - 86_400_000 - 8 * 3600_000);
  });
  afterAll(async () => {
    await kit?.close();
  });

  it('registry: exactly the five READ tools, each with a permission, an output allowlist and a row bound', () => {
    expect(registry.catalogue().map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    for (const t of registry.catalogue()) expect(t).toMatchObject({ kind: 'read', maxRows: 25 });
    expect(() => AiToolRegistry.validate([{ name: 'send_offers', kind: 'write' as never, description: '', permission: 'offer.send', input: null as never, outputKeys: ['x'], maxRows: 1, run: async () => ({}) }])).toThrow(/read tools only/);
  });

  it('discovery: a CEO with every flag sees all five; without payroll.view / attendance.view those tools are never offered', async () => {
    expect(registry.allowedToolNames(await actorFor(ceo, token)).sort()).toEqual(ALL_TOOLS);
    const org = await kit.factory.createOrganisation('ai-tools-narrow');
    await kit.owner.query(`INSERT INTO core.organisation_ai_setting (organisation_id, enabled) VALUES ($1, true)`, [org.id]);
    const narrow = await kit.factory.createCeo(org, { permissions: ['ai.use', 'schedule.view'] });
    const actor = await actorFor(narrow, await kit.factory.login(narrow));
    expect(registry.allowedToolNames(actor).sort()).toEqual(['get_fill_rate', 'get_offer_status', 'list_unfilled_shifts']);
    expect(Object.keys(registry.buildToolSet(runCtx(actor))).sort()).toEqual(['get_fill_rate', 'get_offer_status', 'list_unfilled_shifts']);
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

  it('get_attendance_summary: 2 records, 1 late clock-in (> grace), 1 provisional no-show; no per-person data', async () => {
    const out = await call(await actorFor(ceo, token), 'get_attendance_summary', { from: yesterday, to: today });
    expect(out.data).toMatchObject({ records: 2, lateClockIns: 1, lateGraceMinutes: 10, noShows: { confirmed: 0, provisional: 1 } });
    expect(JSON.stringify(out.data)).not.toMatch(/staff|name|minutes"?:\s*480|earn/i);
  });

  it('compare_payroll_runs: totals and differences only (£150 vs £120); never rates, names, payslips or per-person rows', async () => {
    const out = await call(await actorFor(ceo, token), 'compare_payroll_runs', {});
    expect(out.data).toMatchObject({
      available: true,
      current: { periodStart: '2026-09-15', grossTotalPounds: 150, shiftRecords: 1, staff: 1, hours: 8 },
      previous: { periodStart: '2026-09-01', grossTotalPounds: 120 },
      differences: { grossTotalPounds: 30, shiftRecords: 0 },
    });
    const keys = allKeys(out.data);
    expect(keys.filter((k) => AI_OUTPUT_DENYLIST_KEY.test(k))).toEqual([]);
    expect(JSON.stringify(out.data)).not.toMatch(/1500|aistaff|@example\.test|payslip/i);
  });

  it('every tool output passes the sensitive-key denylist scan and contains no staff email or name', async () => {
    const actor = await actorFor(ceo, token);
    const emails = fx.staff.map((s) => s.email);
    for (const [name, input] of [
      ['list_unfilled_shifts', { from: today, to: inAWeek }],
      ['get_fill_rate', { from: today, to: inAWeek }],
      ['get_offer_status', { from: today, to: inAWeek }],
      ['get_attendance_summary', { from: yesterday, to: today }],
      ['compare_payroll_runs', {}],
    ] as const) {
      const out = await call(actor, name, input);
      expect({ name, bad: allKeys(out.data).filter((k) => AI_OUTPUT_DENYLIST_KEY.test(k)) }).toEqual({ name, bad: [] });
      for (const e of emails) expect(JSON.stringify(out)).not.toContain(e);
    }
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
  });

  it('execution-time recheck: a flag revoked after discovery refuses the call and stops the turn; payroll is never readable without payroll.view', async () => {
    const actor = await actorFor(ceo, token);
    const aborts: string[] = [];
    const run = runCtx(actor, aborts);
    const tools = registry.buildToolSet(run); // offered while the flag was held
    await kit.owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = 'payroll.view'`,
      [ceo.userId, ceo.organisationId],
    );
    try {
      await expect((tools.compare_payroll_runs as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute({}, { toolCallId: 'c', messages: [] })).rejects.toThrow();
      expect(aborts).toEqual(['access_revoked']);
      expect(run.calls).toEqual([{ name: 'compare_payroll_runs', outcome: 'denied', rows: null }]);
      expect(registry.allowedToolNames(await actorFor(ceo, token))).not.toContain('compare_payroll_runs');
    } finally {
      await kit.owner.query(`DELETE FROM core.user_permission_override WHERE user_id = $1`, [ceo.userId]);
    }
  });

  it('tenant isolation: another organisation’s CEO asking the same tool sees none of these shifts', async () => {
    const other = await aiOrganisation(kit, 'ai-tools-other');
    const out = await call(await actorFor(other.ceo, other.token), 'list_unfilled_shifts', { from: today, to: inAWeek });
    expect(out.data).toMatchObject({ unfilledShiftCount: 0, shifts: [] });
    const offers = await call(await actorFor(other.ceo, other.token), 'get_offer_status', { from: today, to: inAWeek });
    expect(offers.data).toMatchObject({ total: 0 });
  });
});
