import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { AI_PLAN_LIMITS, AI_READ_TOOL_NAMES, AI_TOOL_LIMITS, PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AiAccessRevokedError } from '../exceptions/ai.exceptions';
import { PLATFORM_NOT_READY } from '../services/ai-access.service';
import { AI_TOOL_CATALOGUE_HEADER, renderToolCatalogue } from '../tools/ai-meta-tools';
import { guardToolOutput, redactForModel } from '../tools/ai-output-guard';
import { AI_LEGACY_DIRECT_TOOL_NAMES, AiToolRegistry } from '../tools/ai-tool-registry.service';
import { suggestTools } from '../tools/ai-tool-suggest';
import * as C from '../tools/ai-tool.constants';
import { AiToolDefinition } from '../tools/ai-tool.types';
import { DefineTool, toToolDefinition } from '../tools/define-tool.decorator';
import { AI_READ_TOOLS } from '../tools';
import { ALL_FLAGS, buildRegistry, dataOf, fakeActor, fakeChecker, runContext } from '../../../__tests__/support/ai/tool-fakes';

/**
 * AI Phase 3 tool layer, unit level (docs/ai/PHASE3_TWENTY_PLAN.md §7): T-D1 (decorator + validate + the reviewed
 * array), T-L1 / T-L2 (meta tools, 404-not-403), T-S1 (suggestions from permitted names only), T-R1 (redactForModel),
 * the per-turn caps (T-I5 at unit level), the 2 s recheck with its own timer harness (T-I4 until 3w), update_plan (CD-7)
 * and the derived parameters (CD-9). No database, no model.
 */

const fileToName = (file: string) => file.replace(/\.tool\.ts$/, '').replace(/-/g, '_');

describe('T-D1 @DefineTool → definition; validate(); the reviewed array', () => {
  it('the reviewed AI_READ_TOOLS array, the files under tools/read/ and the C0 AI_READ_TOOL_NAMES are the same 12 names (no holiday tool)', () => {
    const files = readdirSync(join(__dirname, '..', 'tools', 'read')).filter((f) => f.endsWith('.ts')).map(fileToName).sort();
    const { registry } = buildRegistry();
    const fromArray = AI_READ_TOOLS.map((cls) => (Reflect.getOwnMetadata('crewflow:ai:tool-definition', cls) as { name: string }).name).sort();
    expect(files).toEqual([...AI_READ_TOOL_NAMES].sort());
    expect(fromArray).toEqual(files);
    expect(registry.catalogue().map((t) => t.name).sort()).toEqual(files);
    expect(files).not.toContain('get_holiday_overlap');
    expect(AI_READ_TOOLS).toHaveLength(12);
  });

  it('the decorator stores the options; the definition carries summary, maxBytes (default 8 KB) and frozen allowlist', () => {
    @Injectable()
    @DefineTool({ name: 'demo_tool', description: 'Demo.', summary: 'Demo summary.', kind: 'read', permission: PermissionFlag.SCHEDULE_VIEW, input: z.strictObject({}), output: { keys: ['a'], maxRows: 5 } })
    class DemoTool {
      async run() {
        return { a: 1 };
      }
    }
    const def = toToolDefinition(new DemoTool());
    expect(def).toMatchObject({ name: 'demo_tool', summary: 'Demo summary.', kind: 'read', maxRows: 5, maxBytes: AI_TOOL_LIMITS.defaultOutputBytes, limits: {} });
    expect(Object.isFrozen(def.outputKeys)).toBe(true);
    class Plain {
      async run() {
        return {};
      }
    }
    expect(() => toToolDefinition(new Plain())).toThrow(/no @DefineTool/);
  });

  const base = (): AiToolDefinition => ({
    name: 'ok_tool', description: 'd', summary: 's', kind: 'read', permission: PermissionFlag.SCHEDULE_VIEW, input: z.strictObject({ from: z.string() }),
    outputKeys: ['x'], maxRows: 5, maxBytes: 8192, limits: {}, run: async () => ({}),
  });
  it.each<[string, Partial<AiToolDefinition>, RegExp]>([
    ['a write tool', { kind: 'write' }, /read tools only/],
    ['a pause tool', { kind: 'pause' }, /read tools only/],
    ['a meta tool (built in, never decorated)', { kind: 'meta' }, /read tools only/],
    ['an approval template on a read tool', { approval: { summaryTemplate: 'x', fields: [], stepUp: 'never', maxTargets: 1 } }, /approval/],
    ['a missing allowlist', { outputKeys: [] }, /allowlist/],
    ['a missing permission', { permission: null }, /permission/],
    ['an unknown flag', { permission: 'nope.view' as never }, /unknown permission/],
    ['maxBytes over 16 KB', { maxBytes: 16_385 }, /maxBytes/],
    ['maxRows over 25 without a documented exception', { maxRows: 26 }, /maxRows/],
    ['a description over 400 characters', { description: 'x'.repeat(401) }, /description/],
    ['a multi-line summary', { summary: 'a\nb' }, /summary/],
    ['a non-strict input', { input: z.object({ from: z.string() }) }, /strict/],
    ['an input declaring organisationId', { input: z.strictObject({ organisationId: z.string() }) }, /organisationId/],
    ['an input declaring status', { input: z.strictObject({ status: z.string() }) }, /status/],
    ['an input declaring sql', { input: z.strictObject({ sql: z.string() }) }, /sql/],
    ['a bad name', { name: 'Bad Name' }, /name invalid/],
  ])('refuses %s at boot', (_label, patch, message) => {
    expect(() => AiToolRegistry.validate([{ ...base(), ...patch } as AiToolDefinition])).toThrow(message);
  });
  it('refuses a duplicate name; accepts the documented count_shifts 62-row exception only for that name', () => {
    expect(() => AiToolRegistry.validate([base(), base()])).toThrow(/duplicated/);
    expect(() => AiToolRegistry.validate([{ ...base(), name: 'count_shifts', maxRows: 62 }])).not.toThrow();
    expect(() => AiToolRegistry.validate([{ ...base(), name: 'find_shifts', maxRows: 62 }])).toThrow(/maxRows/);
  });

  it('tool-layer constants equal the C0 AI_TOOL_LIMITS', () => {
    expect({
      maxStringChars: C.AI_TOOL_MAX_STRING_CHARS, maxRows: C.AI_TOOL_DEFAULT_MAX_ROWS, defaultOutputBytes: C.AI_TOOL_DEFAULT_OUTPUT_BYTES, maxOutputBytes: C.AI_TOOL_MAX_OUTPUT_BYTES,
      maxCallsPerTurn: C.AI_MAX_TOOL_CALLS_PER_TURN, maxLearnCallsPerTurn: C.AI_MAX_LEARN_CALLS_PER_TURN, maxNamesPerLearn: C.AI_LEARN_MAX_NAMES, maxExecuteArgsBytes: C.AI_EXECUTE_MAX_ARGS_BYTES,
      statementTimeoutMs: C.AI_TOOL_STATEMENT_TIMEOUT_MS, accessRecheckMs: C.AI_ACCESS_RECHECK_MS, fullRecheckMs: C.AI_ACCESS_FULL_RECHECK_MS, maxRecheckFailures: C.AI_ACCESS_MAX_RECHECK_FAILURES,
      maxDescriptionChars: C.AI_TOOL_MAX_DESCRIPTION_CHARS, maxSuggestions: C.AI_TOOL_MAX_SUGGESTIONS,
    }).toEqual(AI_TOOL_LIMITS);
  });

  it('every registered tool: one flag, strict input, allowlist free of denylisted keys, summary/description ≤ 400', () => {
    const { registry } = buildRegistry();
    for (const t of registry.catalogue()) {
      expect(t.kind).toBe('read');
      expect(t.permission).toBeTruthy();
      expect(t.summary.length).toBeLessThanOrEqual(400);
      expect(t.maxBytes).toBeLessThanOrEqual(16_384);
    }
  });
});

describe('forTurn binding: catalogue, fixed SDK set, Phase 1 facade', () => {
  it('the SDK set is exactly the fixed name-sorted meta tools; the catalogue lists only permitted read tools, name-sorted', async () => {
    const { registry } = buildRegistry();
    const binding = await registry.forTurn(runContext(), fakeChecker([PermissionFlag.SCHEDULE_VIEW]));
    expect(Object.keys(binding.toolSet)).toEqual(['execute_tool', 'learn_tools', 'update_plan']);
    expect(Object.keys(binding.toolSet).length).toBeLessThanOrEqual(7);
    expect(binding.catalogue.map((l) => l.name)).toEqual(['count_shifts', 'find_shifts', 'get_fill_rate', 'get_offer_pipeline', 'get_offer_status', 'get_rota_coverage_gaps', 'list_unfilled_shifts']);
    expect([...binding.permitted].sort()).toEqual(binding.catalogue.map((l) => l.name));
    const block = renderToolCatalogue(binding.catalogue);
    expect(block.startsWith(AI_TOOL_CATALOGUE_HEADER)).toBe(true);
    expect(block).not.toMatch(/compare_payroll_runs|get_staff_availability|get_venue_summary|get_timesheet/);
    expect(renderToolCatalogue(binding.catalogue)).toBe(block); // byte-stable
  });

  it('CD-8 permittedCatalogue = forTurn filter, read fresh (no payroll.view → no payroll tool)', async () => {
    const { registry, permissions } = buildRegistry();
    permissions.userHasPermissionTx.mockImplementation(async (_m: unknown, _c: unknown, flag: string) => flag !== PermissionFlag.PAYROLL_VIEW);
    const lines = await registry.permittedCatalogue(fakeActor());
    expect(lines.map((l) => l.name)).not.toContain('compare_payroll_runs');
    expect(lines.map((l) => l.name)).toContain('get_staff_availability');
    expect(lines.every((l) => l.label && l.summary)).toBe(true);
  });

  it('the Phase 1 facade still offers only the five Phase 1 direct tools', () => {
    const { registry } = buildRegistry();
    expect([...AI_LEGACY_DIRECT_TOOL_NAMES].sort()).toEqual(['compare_payroll_runs', 'get_attendance_summary', 'get_fill_rate', 'get_offer_status', 'list_unfilled_shifts']);
    expect(Object.keys(registry.buildToolSet(runContext())).sort()).toEqual([...AI_LEGACY_DIRECT_TOOL_NAMES].sort());
    expect(Object.keys(registry.buildToolSet(runContext(fakeActor([PermissionFlag.SCHEDULE_VIEW])))).sort()).toEqual(['get_fill_rate', 'get_offer_status', 'list_unfilled_shifts']);
  });

  it('CD-9 parameters are derived from the strict zod schema (types, required, bounds, enum values)', () => {
    const { registry } = buildRegistry();
    const find = registry.catalogue().find((t) => t.name === 'find_shifts')!;
    const byName = Object.fromEntries(find.parameters.map((p) => [p.name, p]));
    expect(byName.from).toMatchObject({ type: 'date', required: true, limits: 'range at most 31 days' });
    expect(byName.venueId).toMatchObject({ type: 'uuid', required: false });
    expect(byName.statuses).toMatchObject({ type: 'array', limits: 'up to 6 values' });
    expect(byName.statuses!.enumValues).toContain('open');
    expect(byName.statuses!.enumValues).not.toContain('draft');
    expect(byName.limit).toMatchObject({ type: 'integer', limits: '1–25' });
    expect(registry.catalogue().find((t) => t.name === 'compare_payroll_runs')!.parameters.map((p) => p.name)).toEqual(['periodStart', 'comparePeriodStart']);
  });
});

describe('T-L1 learn_tools', () => {
  const learn = async (names: unknown, flags = ALL_FLAGS, extra: Record<string, unknown> = {}) => {
    const { registry, audits } = buildRegistry();
    const run = runContext();
    const binding = await registry.forTurn(run, fakeChecker(flags));
    const out = await registry.learn(run, fakeChecker(flags), binding.permitted, { names, ...extra });
    return { out, run, audits };
  };

  it.each([
    ['more than 5 names', ['find_shifts', 'count_shifts', 'get_fill_rate', 'get_offer_status', 'get_offer_pipeline', 'get_venue_summary']],
    ['a name failing the pattern', ['DROP TABLE users']],
    ['no names', []],
  ])('refuses %s (invalid_input, recorded and audited)', async (_label, names) => {
    const { out, run, audits } = await learn(names);
    expect(dataOf(out)).toMatchObject({ error: 'invalid_input' });
    expect(run.calls).toEqual([expect.objectContaining({ name: 'learn_tools', outcome: 'invalid_input' })]);
    expect(audits).toEqual([expect.objectContaining({ action: 'ai.tool_denied' })]);
  });

  it('refuses extra keys', async () => {
    expect(dataOf((await learn(['find_shifts'], ALL_FLAGS, { organisationId: 'x' })).out)).toMatchObject({ error: 'invalid_input' });
  });

  it('returns frozen schemas for permitted names only, with every `pattern` stripped and `format` kept', async () => {
    const { out } = await learn(['find_shifts', 'get_staff_availability']);
    const data = dataOf(out) as { tools: Array<{ name: string; inputSchema: Record<string, unknown>; outputFields: string[] }>; unknown: unknown[] };
    expect(data.tools.map((t) => t.name)).toEqual(['find_shifts', 'get_staff_availability']);
    expect(JSON.stringify(data)).not.toMatch(/"pattern"|\$schema/);
    expect(JSON.stringify(data.tools[0]!.inputSchema)).toMatch(/"format":"date"/);
    expect(JSON.stringify(data.tools[0]!.inputSchema)).toMatch(/"format":"uuid"/);
    expect(data.unknown).toEqual([]);
  });

  it('an unpermitted name and a name that does not exist get byte-identical answers; the string is never echoed', async () => {
    const flags = [PermissionFlag.SCHEDULE_VIEW];
    const unpermitted = await learn(['compare_payroll_runs'], flags);
    const missing = await learn(['qqq_zzz_nothing'], flags);
    expect(JSON.stringify(unpermitted.out)).toBe(JSON.stringify(missing.out));
    expect(dataOf(unpermitted.out)).toEqual({ tools: [], unknown: [{ index: 0, suggestions: [] }] });
    expect(JSON.stringify(unpermitted.out)).not.toContain('compare_payroll_runs');
    // The audit (server side) keeps the detail.
    expect(unpermitted.audits[0]!.metadata).toMatchObject({ tool: 'learn_tools', unknown: ['compare_payroll_runs:denied'] });
    expect(missing.audits[0]!.metadata).toMatchObject({ unknown: ['qqq_zzz_nothing:not_offered'] });
  });

  it('at most 3 learn_tools calls per turn', async () => {
    const { registry } = buildRegistry();
    const run = runContext();
    const checker = fakeChecker();
    const binding = await registry.forTurn(run, checker);
    const outs = [];
    for (let i = 0; i < 4; i++) outs.push(dataOf(await registry.learn(run, checker, binding.permitted, { names: ['find_shifts'] })));
    expect(outs.slice(0, 3).every((o) => Array.isArray(o.tools))).toBe(true);
    expect(outs[3]).toEqual({ error: 'tool_call_limit' });
  });
});

describe('T-L2 execute_tool', () => {
  const setup = async (flags = ALL_FLAGS) => {
    const ctx = buildRegistry();
    const run = runContext();
    const checker = fakeChecker(flags);
    const binding = await ctx.registry.forTurn(run, checker);
    const exec = (raw: unknown) => ctx.registry.executeByName(run, checker, binding.permitted, raw);
    return { ...ctx, run, checker, binding, exec };
  };

  it('runs a permitted tool: fresh flag re-check, inner name recorded and emitted, wrapped untrusted data', async () => {
    const { exec, run, checker, svc } = await setup();
    const out = await exec({ name: 'find_shifts', args: { from: '2026-10-26', to: '2026-10-31' } });
    expect((out as { tool: string }).tool).toBe('find_shifts');
    expect(dataOf(out)).toMatchObject({ total: 2, listed: 2 });
    expect(checker.assertStillAllowed).toHaveBeenCalledWith(PermissionFlag.SCHEDULE_VIEW);
    expect(svc.calls).toEqual(['assistantFindShifts']);
    expect(run.calls).toEqual([expect.objectContaining({ name: 'find_shifts', outcome: 'ok', rows: 2, kind: 'read' })]);
    expect(run.events).toEqual([['started', 'find_shifts'], ['finished', 'find_shifts', 'ok']]);
  });

  it('args over 2 KB, unknown outer keys and smuggled inner keys are invalid_input and never run', async () => {
    const { exec, svc, run } = await setup();
    for (const raw of [
      { name: 'find_shifts', args: { from: '2026-10-26', to: '2026-10-31', pad: 'x'.repeat(2100) } },
      { name: 'find_shifts', args: {}, organisationId: 'x' },
      { name: 'find_shifts', args: { from: '2026-10-26', to: '2026-10-31', organisationId: '11111111-1111-4111-8111-111111111111' } },
      { name: 'find_shifts', args: { from: '2026-10-26', to: '2026-10-31', status: 'open' } },
      { name: 'find_shifts', args: { from: '2026-10-26', to: '2026-12-31' } },
      { name: 'find_shifts', args: { from: '2026-10-26', to: '2026-10-31', venueId: 'not-a-uuid' } },
    ]) {
      expect(dataOf(await exec(raw))).toMatchObject({ error: 'invalid_input' });
    }
    expect(svc.calls).toEqual([]);
    expect(run.calls.every((c) => c.outcome === 'invalid_input')).toBe(true);
    expect(JSON.stringify(run.calls)).not.toContain('organisationId');
  });

  it('a similar forbidden name gets suggestions from PERMITTED names only', async () => {
    const { exec } = await setup([PermissionFlag.SCHEDULE_VIEW]);
    const out = dataOf(await exec({ name: 'send_offers', args: {} }));
    expect(out.error).toBe('unknown_tool');
    for (const s of out.suggestions as string[]) expect(['get_offer_pipeline', 'get_offer_status']).toContain(s);
    expect(dataOf(await exec({ name: 'compare_payroll_run', args: {} })).suggestions).toEqual([]);
  });

  it('T-I3 (unit): an unpermitted tool and a nonexistent one get the SAME unknown_tool answer, no service call, audited denied / not_offered', async () => {
    const { exec, svc, run, audits } = await setup([PermissionFlag.SCHEDULE_VIEW]);
    const a = await exec({ name: 'compare_payroll_runs', args: {} });
    const b = await exec({ name: 'xyzzy_nothing', args: {} });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(dataOf(a)).toEqual({ error: 'unknown_tool', suggestions: [] });
    expect(svc.calls).toEqual([]);
    expect(run.calls).toEqual([
      { name: 'unavailable_tool', outcome: 'unknown_tool', rows: null, offset: 0 },
      { name: 'unavailable_tool', outcome: 'unknown_tool', rows: null, offset: 0 },
    ]);
    expect(audits.map((x) => [x.action, x.metadata.tool, x.metadata.outcome])).toEqual([
      ['ai.tool_denied', 'compare_payroll_runs', 'denied'],
      ['ai.tool_denied', 'xyzzy_nothing', 'not_offered'],
    ]);
  });

  it('a revoked flag at execution: the turn is aborted, the call is denied and nothing runs', async () => {
    const { exec, svc, run, checker } = await setup();
    checker.assertStillAllowed.mockRejectedValueOnce(new AiAccessRevokedError('tool_permission'));
    await expect(exec({ name: 'compare_payroll_runs', args: {} })).rejects.toThrow(/not permitted/);
    expect(run.aborts).toEqual(['access_revoked']);
    expect(svc.calls).toEqual([]);
    expect(run.calls).toEqual([expect.objectContaining({ name: 'compare_payroll_runs', outcome: 'denied' })]);
  });

  it('a failing service answers the fixed tool_failed (no error text) and the turn continues', async () => {
    const { exec, svc, run } = await setup();
    svc.schedulingAssistant.assistantShiftCounts = async () => {
      throw new Error('canceling statement due to statement timeout: SELECT secret FROM somewhere');
    };
    const out = await exec({ name: 'count_shifts', args: { from: '2026-10-26', to: '2026-10-31' } });
    expect(dataOf(out)).toEqual({ error: 'tool_failed' });
    expect(JSON.stringify(out)).not.toMatch(/secret|statement/);
    expect(run.aborts).toEqual([]);
  });

  it('T-I5 (unit): 20 parallel calls in one step → 12 run, 8 tool_call_limit; the audit matches', async () => {
    const { exec, run, audits, svc } = await setup();
    const outs = await Promise.all(Array.from({ length: 20 }, () => exec({ name: 'get_fill_rate', args: { from: '2026-10-26', to: '2026-10-31' } })));
    expect(outs.filter((o) => dataOf(o).error === 'tool_call_limit')).toHaveLength(8);
    expect(svc.calls).toHaveLength(12);
    expect(run.calls.filter((c) => c.outcome === 'ok')).toHaveLength(12);
    expect(run.calls.filter((c) => c.outcome === 'tool_call_limit')).toHaveLength(8);
    expect(audits.filter((a) => a.metadata.outcome === 'tool_call_limit')).toHaveLength(8);
  });

  it('the Phase 1 direct path is capped too (12 per turn)', async () => {
    const { registry, svc } = buildRegistry();
    const run = runContext();
    delete (run as { budget?: unknown }).budget;
    const tools = registry.buildToolSet(run) as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
    const outs = await Promise.all(Array.from({ length: 14 }, () => tools.get_fill_rate!.execute({ from: '2026-10-26', to: '2026-10-31' }, { toolCallId: 'c', messages: [] })));
    expect(outs.filter((o) => dataOf(o).error === 'tool_call_limit')).toHaveLength(2);
    expect(svc.calls).toHaveLength(12);
  });
});

describe('update_plan (C1 CD-7)', () => {
  const setup = async () => {
    const ctx = buildRegistry();
    const run = runContext();
    return { ...ctx, run, plan: (raw: unknown) => ctx.registry.updatePlan(run, raw) };
  };
  it('masks labels, stores them on the call summary, emits a plan event; information only', async () => {
    const { plan, run, svc } = await setup();
    const out = await plan({ steps: [{ label: 'Email jo@corp.co.uk and call 07700 900123', status: 'in_progress' }, { label: 'Check <b>gaps</b>', status: 'pending' }] });
    expect(dataOf(out)).toEqual({ recorded: true, steps: 2 });
    expect(JSON.stringify(out)).not.toMatch(/approved/i);
    const steps = run.calls[0]!.plan!;
    expect(steps[0]!.label).toBe('Email [email removed] and call [number removed]');
    expect(steps[1]!.label).not.toMatch(/[<>]/);
    expect(run.plans).toEqual([steps]);
    expect(svc.calls).toEqual([]); // no data access
  });
  it('strict input: > 8 steps, label > 100 chars, unknown status, extra keys, an approval claim → invalid_input', async () => {
    const { plan } = await setup();
    const step = { label: 'x', status: 'pending' };
    for (const raw of [
      { steps: Array.from({ length: AI_PLAN_LIMITS.maxSteps + 1 }, () => step) },
      { steps: [{ label: 'x'.repeat(101), status: 'pending' }] },
      { steps: [{ label: 'x', status: 'approved' }] },
      { steps: [step], extra: 1 },
      { steps: [{ label: 'Plan approved by the manager', status: 'done' }] },
    ]) {
      expect(dataOf(await plan(raw))).toMatchObject({ error: 'invalid_input' });
    }
  });
  it('at most 6 updates per turn, each counted in the 12-call cap', async () => {
    const { plan, run } = await setup();
    const outs = [];
    for (let i = 0; i < 7; i++) outs.push(dataOf(await plan({ steps: [{ label: 'Check shifts', status: 'pending' }] })));
    expect(outs.slice(0, 6).every((o) => o.recorded === true)).toBe(true);
    expect(outs[6]).toEqual({ error: 'tool_call_limit' });
    expect(run.budget.toolCalls).toBe(7);
  });
});

describe('T-S1 suggestTools: permitted names only', () => {
  const permitted = ['find_shifts', 'get_fill_rate', 'list_unfilled_shifts', 'count_shifts'];
  it('suggests a close permitted name', () => {
    expect(suggestTools('get_fill_rat', permitted)).toEqual(['get_fill_rate']);
    expect(suggestTools('unfilled', permitted)).toEqual(['list_unfilled_shifts']);
  });
  it('never suggests an unpermitted tool, even one edit away', () => {
    expect(suggestTools('compare_payroll_run', permitted)).toEqual([]);
    expect(suggestTools('get_venue_sumary', permitted)).not.toContain('get_venue_summary');
  });
  it('≤ 3, invalid pattern → [], non-string → [], the input never echoed', () => {
    expect(suggestTools('shifts', [...permitted, 'shift_a_b', 'shifts_b', 'shifts_c']).length).toBeLessThanOrEqual(3);
    expect(suggestTools('DROP TABLE x;', permitted)).toEqual([]);
    expect(suggestTools({ name: 'x' }, permitted)).toEqual([]);
    for (const raw of ['get_fill_rat', 'zzz_shifts', 'unfilled']) for (const s of suggestTools(raw, permitted)) expect(permitted).toContain(s);
  });
});

describe('T-R1 redactForModel', () => {
  const def = { name: 'big', outputKeys: ['rows', 'label', 'listed', 'truncated', 'blob'], maxRows: 25, maxBytes: 8192 };
  it('drops trailing rows to fit 8 KB (truncated, listed updated), never cutting a string', () => {
    const label = 'Hotel '.repeat(25).trim(); // 149 chars, under the 160 cap
    const value = { listed: 25, rows: Array.from({ length: 25 }, () => ({ label: `${label} ${'y'.repeat(9)}`, blob: 'b'.repeat(150) })) };
    const out = redactForModel(value, { ...def, outputKeys: [...def.outputKeys] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const data = out.payload.data as { rows: Array<{ label: string }>; listed: number; truncated: boolean };
    expect(out.bytes).toBeLessThanOrEqual(8192);
    expect(data.truncated).toBe(true);
    expect(data.rows.length).toBeLessThan(25);
    expect(data.listed).toBe(data.rows.length);
    for (const r of data.rows) expect(r.label).toBe(`${label} ${'y'.repeat(9)}`);
    expect(redactForModel(value, { ...def, maxBytes: 16_384 })).toMatchObject({ ok: true, truncated: false });
  });
  it('16 KB is the hard maximum whatever the tool declares', () => {
    const value = { rows: Array.from({ length: 25 }, () => ({ label: 'z'.repeat(150) })) };
    const out = redactForModel(value, { ...def, maxBytes: 64_000 });
    expect(out.ok && out.bytes).toBeLessThanOrEqual(16_384);
  });
  it('a result over the cap with no array to cut → output_too_large', () => {
    const value = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, 'v'.repeat(150)]));
    expect(redactForModel(value, { name: 't', outputKeys: Object.keys(value), maxRows: 25, maxBytes: 4096 })).toEqual({ ok: false, error: 'output_too_large' });
  });
  it('keeps the Phase 1 guarantees: 160-char strings, 25 rows, allowlist, denylist refusal', () => {
    const out = redactForModel({ rows: Array.from({ length: 40 }, () => ({ label: 'q'.repeat(400), internalKey: 1 })) }, { ...def, maxBytes: 16_384 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const rows = (out.payload.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows.length).toBeLessThanOrEqual(25);
    expect(String(rows[0]!.label)).toHaveLength(160);
    expect(rows[0]).not.toHaveProperty('internalKey');
    expect(() => redactForModel({ email: 'x' }, { name: 't', outputKeys: ['email'], maxRows: 5 })).toThrow();
    expect(guardToolOutput).toBeDefined();
  });
});

describe('T-I4 (harness until 3w) binding.recheck: 2 s fingerprint, full check on change, fail closed after 3 errors', () => {
  afterEach(() => jest.useRealTimers());

  it('an unchanged fingerprint costs one statement; a change runs the full check per catalogued flag', async () => {
    const { registry } = buildRegistry();
    const run = runContext();
    const checker = fakeChecker([PermissionFlag.SCHEDULE_VIEW, PermissionFlag.PAYROLL_VIEW]);
    const binding = await registry.forTurn(run, checker);
    await binding.recheck();
    expect(checker.assertStillAllowed).not.toHaveBeenCalled();
    checker.fingerprint.mockResolvedValue('fp-2');
    await binding.recheck();
    expect(checker.assertStillAllowed.mock.calls.map((c) => c[0]).sort()).toEqual([PermissionFlag.PAYROLL_VIEW, PermissionFlag.SCHEDULE_VIEW].sort());
    expect(run.aborts).toEqual([]);
  });

  it('timer harness: a direct user_permission_override (fingerprint change) revoking a catalogued flag aborts within 2.5 s', async () => {
    jest.useFakeTimers();
    const { registry } = buildRegistry();
    const run = runContext();
    const checker = fakeChecker();
    const binding = await registry.forTurn(run, checker);
    const timer = setInterval(() => void binding.recheck().catch(() => undefined), C.AI_ACCESS_RECHECK_MS);
    checker.fingerprint.mockResolvedValue('fp-after-override');
    checker.assertStillAllowed.mockImplementation(async (flag?: string) => {
      if (flag === PermissionFlag.PAYROLL_VIEW) throw new AiAccessRevokedError('tool_permission');
    });
    await jest.advanceTimersByTimeAsync(2_500);
    clearInterval(timer);
    expect(run.aborts).toEqual(['access_revoked']);
    await expect(binding.recheck()).rejects.toThrow(); // stopped for good
  });

  it('three consecutive fingerprint failures → service_unavailable; a success in between resets the count', async () => {
    const { registry } = buildRegistry();
    const run = runContext();
    const checker = fakeChecker();
    const binding = await registry.forTurn(run, checker);
    checker.fingerprint.mockRejectedValueOnce(new Error('db')).mockRejectedValueOnce(new Error('db')).mockResolvedValueOnce('fp-1');
    await binding.recheck();
    await binding.recheck();
    await binding.recheck();
    expect(run.aborts).toEqual([]);
    checker.fingerprint.mockRejectedValue(new Error('db'));
    await binding.recheck();
    await binding.recheck();
    await expect(binding.recheck()).rejects.toMatchObject({ reason: PLATFORM_NOT_READY });
    expect(run.aborts).toEqual(['service_unavailable']);
  });

  it('never overlaps itself: a tick in flight makes the next one a no-op', async () => {
    const { registry } = buildRegistry();
    const run = runContext();
    const checker = fakeChecker();
    const binding = await registry.forTurn(run, checker);
    let release!: () => void;
    checker.fingerprint.mockImplementationOnce(() => new Promise<string>((r) => (release = () => r('fp-1'))));
    const first = binding.recheck();
    await binding.recheck();
    expect(checker.fingerprint).toHaveBeenCalledTimes(2); // baseline + the in-flight one
    release();
    await first;
  });

  it('the turn cannot start without a baseline fingerprint (fail closed)', async () => {
    const { registry } = buildRegistry();
    const checker = fakeChecker();
    checker.fingerprint.mockRejectedValueOnce(new Error('db'));
    await expect(registry.forTurn(runContext(), checker)).rejects.toThrow();
  });
});
