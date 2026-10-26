import { stepCountIs, streamText, tool, jsonSchema } from 'ai';

import { DeterministicMockModel } from '../../../__tests__/support/ai/deterministic-mock-model';
import { scanOutgoingPayload } from '../gateway/outgoing-payload-guard';
import { buildSystemPrompt, wrapToolData } from '../prompt/system-prompt';
import { EXECUTE_TOOL_JSON_SCHEMA, LEARN_TOOLS_JSON_SCHEMA, renderToolCatalogue, UPDATE_PLAN_JSON_SCHEMA } from '../tools/ai-meta-tools';
import { AI_OUTPUT_DENYLIST_KEY } from '../tools/ai-output-guard';
import { buildRegistry, dataOf, fakeChecker, runContext } from '../../../__tests__/support/ai/tool-fakes';

/**
 * T-L3 (docs/ai/PHASE3_TWENTY_PLAN.md §2.2 / §7, B12): the EX-1 outgoing-payload guard must not false-positive on the
 * lazy-loading machinery — the full catalogue prompt, every `learn_tools` output, the meta schemas and every tool's
 * fixture output built from seed-like synthetic data all scan to [] — while a sensitive value seeded into a venue name
 * still never leaves: an email / NI number is masked by the output guard, a postcode is caught by the payload scan.
 * T-M1: the deterministic mock routes through the catalogue to `execute_tool` and never names a tool outside it.
 */

const FIXTURE_ARGS: Record<string, Record<string, unknown>> = {
  compare_payroll_runs: {},
  count_shifts: { from: '2026-10-26', to: '2026-11-01' },
  find_shifts: { from: '2026-10-26', to: '2026-11-01' },
  get_attendance_summary: { from: '2026-10-01', to: '2026-10-25' },
  get_fill_rate: { from: '2026-10-26', to: '2026-11-01' },
  get_offer_pipeline: { from: '2026-10-26', to: '2026-11-01' },
  get_offer_status: { from: '2026-10-26', to: '2026-11-01' },
  get_rota_coverage_gaps: { from: '2026-10-26', to: '2026-11-01' },
  get_staff_availability: { from: '2026-10-26', to: '2026-11-01' },
  get_timesheet_approval_queue: {},
  get_venue_summary: { from: '2026-10-26', to: '2026-11-01' },
  list_unfilled_shifts: { from: '2026-10-26', to: '2026-11-01' },
};

async function allOutputs(venueName?: string) {
  const { registry } = buildRegistry({ venueName });
  const run = runContext();
  const checker = fakeChecker();
  const binding = await registry.forTurn(run, checker);
  const outputs: Record<string, unknown> = {};
  for (const line of binding.catalogue) outputs[line.name] = await registry.executeByName(run, checker, binding.permitted, { name: line.name, args: FIXTURE_ARGS[line.name] });
  // learn_tools outputs: every tool, in groups of ≤ 5 (≤ 3 calls per turn → a fresh run per group).
  const names = binding.catalogue.map((l) => l.name);
  const learned: unknown[] = [];
  for (let i = 0; i < names.length; i += 5) {
    const r = runContext();
    learned.push(await registry.learn(r, checker, binding.permitted, { names: names.slice(i, i + 5) }));
  }
  return { binding, outputs, learned };
}

const scan = (system: string, toolResults: unknown[]) =>
  scanOutgoingPayload({ system, messages: toolResults.map((value, i) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'execute_tool', output: { type: 'json', value } }] })) });

describe('T-L3 payload guard vs lazy loading', () => {
  it('the full catalogue system prompt, the meta schemas and every learn_tools output scan to []', async () => {
    const { binding, learned } = await allOutputs();
    const system = `${buildSystemPrompt('2026-10-25')}\n${renderToolCatalogue(binding.catalogue)}`;
    expect(binding.catalogue).toHaveLength(12);
    expect(scan(system, [])).toEqual([]);
    expect(scan(system, learned)).toEqual([]);
    expect(scan(JSON.stringify([EXECUTE_TOOL_JSON_SCHEMA, LEARN_TOOLS_JSON_SCHEMA, UPDATE_PLAN_JSON_SCHEMA]), [])).toEqual([]);
    for (const l of learned) expect((dataOf(l).tools as unknown[]).length).toBeGreaterThan(0);
  });

  it('every tool fixture output (seed-like synthetic data) is ok, has no denylisted key and scans to []', async () => {
    const { outputs } = await allOutputs();
    for (const [name, out] of Object.entries(outputs)) {
      expect({ name, error: dataOf(out).error }).toEqual({ name, error: undefined });
      const keys: string[] = [];
      const walk = (v: unknown) => (Array.isArray(v) ? v.forEach(walk) : v && typeof v === 'object' ? Object.entries(v).forEach(([k, x]) => (keys.push(k), walk(x))) : undefined);
      walk(dataOf(out));
      expect({ name, bad: keys.filter((k) => AI_OUTPUT_DENYLIST_KEY.test(k)) }).toEqual({ name, bad: [] });
      expect({ name, found: scan('x', [out]) }).toEqual({ name, found: [] });
    }
  });

  it('a seeded email / NI number in a venue name is masked before it can leave; a seeded postcode is refused by the scan', async () => {
    const masked = await allOutputs('Grand Hotel ops@realcorp.co.uk AB123456C');
    const text = JSON.stringify(Object.values(masked.outputs));
    expect(text).not.toContain('ops@realcorp.co.uk');
    expect(text).not.toContain('AB123456C');
    expect(text).toContain('[email removed]');
    // The raw value, had it not been masked, is refused by the scan (defence in depth).
    expect(scan('x', [wrapToolData('find_shifts', { venue: 'Grand Hotel ops@realcorp.co.uk AB123456C' })])).toEqual(expect.arrayContaining(['email', 'ni_number']));
    const postcode = await allOutputs('Grand Hotel SW1A 1AA');
    expect(scan('x', [postcode.outputs.find_shifts])).toEqual(['postcode']);
  });
});

describe('T-M1 deterministic mock: catalogue routing', () => {
  const catalogue = (names: string[]) => renderToolCatalogue(names.map((name) => ({ name, summary: 'Fixed summary.' })));
  const lazyTools = (seen: unknown[]) => ({
    execute_tool: tool({
      description: 'x',
      inputSchema: jsonSchema(structuredClone(EXECUTE_TOOL_JSON_SCHEMA) as never),
      execute: async (input: unknown) => {
        seen.push(['execute_tool', input]);
        const name = (input as { name: string }).name;
        return wrapToolData(name, { unfilledShiftCount: 0, range: { from: 'a', to: 'b' }, shifts: [] });
      },
    }),
    learn_tools: tool({
      description: 'x',
      inputSchema: jsonSchema(structuredClone(LEARN_TOOLS_JSON_SCHEMA) as never),
      execute: async (input: unknown) => {
        seen.push(['learn_tools', input]);
        return wrapToolData('learn_tools', { tools: (input as { names: string[] }).names.map((name) => ({ name })), unknown: [] });
      },
    }),
  });
  const ask = async (question: string, names: string[], opts: { learnFirst?: boolean } = {}) => {
    const seen: unknown[] = [];
    const r = streamText({
      model: new DeterministicMockModel('crewflow-mock-1', opts),
      system: `${buildSystemPrompt('2026-10-25')}\n${catalogue(names)}`,
      prompt: question,
      tools: lazyTools(seen),
      stopWhen: stepCountIs(4),
    });
    await r.consumeStream();
    return { seen, text: await r.text, calls: (await r.steps).flatMap((s) => s.toolCalls.map((c) => c.toolName)) };
  };

  it('"Which shifts this weekend are unfilled?" → execute_tool(list_unfilled_shifts) with explicit dates; deterministic', async () => {
    const a = await ask('Which shifts this weekend are unfilled?', ['get_fill_rate', 'list_unfilled_shifts']);
    expect(a.seen).toEqual([['execute_tool', { name: 'list_unfilled_shifts', args: { from: '2026-10-24', to: '2026-10-25' } }]]);
    expect(a.calls).toEqual(['execute_tool']);
    expect(a.text).toMatch(/No shifts still need staff/);
    expect(await ask('Which shifts this weekend are unfilled?', ['get_fill_rate', 'list_unfilled_shifts'])).toEqual(a);
  });

  it('never names a tool outside the catalogue (payroll not catalogued → no call, a refusal text)', async () => {
    const r = await ask('Compare the payroll runs', ['list_unfilled_shifts']);
    expect(r.seen).toEqual([]);
    expect(r.text).toMatch(/cannot access that information/);
  });

  it('learnFirst: learn_tools → execute_tool → answer', async () => {
    const r = await ask('What is our fill rate this week?', ['get_fill_rate'], { learnFirst: true });
    expect(r.calls).toEqual(['learn_tools', 'execute_tool']);
    expect(r.seen[0]).toEqual(['learn_tools', { names: ['get_fill_rate'] }]);
  });

  it('new tools are routed by keyword (coverage gaps, availability capped at 14 days, timesheets, venues, pipeline)', async () => {
    const all = ['get_rota_coverage_gaps', 'get_staff_availability', 'get_timesheet_approval_queue', 'get_venue_summary', 'get_offer_pipeline'];
    expect((await ask('Where are the coverage gaps this week?', all)).seen[0]).toEqual(['execute_tool', { name: 'get_rota_coverage_gaps', args: { from: '2026-10-19', to: '2026-10-25' } }]);
    const avail = (await ask('Staff availability this month?', all)).seen[0] as [string, { args: { from: string; to: string } }];
    expect(avail[1].args).toEqual({ from: '2026-10-01', to: '2026-10-14' });
    expect((await ask('How many timesheets are awaiting approval?', all)).seen[0]).toEqual(['execute_tool', { name: 'get_timesheet_approval_queue', args: {} }]);
    expect(((await ask('Summarise my venues', all)).seen[0] as [string, { name: string }])[1].name).toBe('get_venue_summary');
    expect(((await ask('Which offers are expiring?', all)).seen[0] as [string, { name: string }])[1].name).toBe('get_offer_pipeline');
  });
});
