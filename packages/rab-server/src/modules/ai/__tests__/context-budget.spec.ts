import type { ModelMessage } from 'ai';

import { AI_CONTEXT_BUDGET_RATIO, AiContextBudgetInput } from '../contracts/usage';
import { AI_CONTEXT_OMITTED_MARKER, applyContextBudget, contextBudgetLimit, estimateInputTokens, omittedToolOutput } from '../gateway/context-budget';

/**
 * T7-C1 (PHASE7_TWENTY_PLAN §5): the pure context budget. Trims the oldest tool results first and keeps every
 * tool-call / tool-result pair; `load_skills` content is trimmed last; the newest tool results are never removed; still
 * over the limit → `context_full`; never adds text; idempotent; never mutates its input.
 */
const big = (label: string, n: number) => ({ rows: Array.from({ length: n }, (_, i) => ({ label, i, note: 'x'.repeat(40) })) });

function call(id: string, toolName: string): ModelMessage {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input: {} }] };
}
function result(id: string, toolName: string, value: unknown): ModelMessage {
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'json', value: value as never } }] };
}

/** A turn mid-loop: user question, then three tool round trips (one of them a skill load), the last one newest. */
function conversation(rows = 60): ModelMessage[] {
  return [
    { role: 'user', content: 'How are we doing this week?' },
    call('c1', 'list_open_shifts'),
    result('c1', 'list_open_shifts', big('shift', rows)),
    call('c2', 'load_skills'),
    result('c2', 'load_skills', big('skill', rows)),
    call('c3', 'count_offers'),
    result('c3', 'count_offers', big('offer', rows)),
    call('c4', 'payroll_totals'),
    result('c4', 'payroll_totals', big('payroll', rows)),
  ];
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

function input(messages: ModelMessage[], over: Partial<AiContextBudgetInput> = {}): AiContextBudgetInput {
  return { messages, previousStepInputTokens: null, appendedBytesSincePrevious: 0, contextWindowTokens: 1_000_000, turnCeilingTokens: 44_000, maxOutputTokens: 4_000, ...over };
}

/** A turn ceiling whose limit lands exactly at `limit` tokens (maxOutput 0, window large). */
const withLimit = (messages: ModelMessage[], limit: number) => input(messages, { turnCeilingTokens: Math.ceil(limit / AI_CONTEXT_BUDGET_RATIO), maxOutputTokens: 0 });

function toolOutputs(messages: readonly ModelMessage[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<Record<string, unknown>>) if (p.type === 'tool-result') out[p.toolCallId as string] = p.output;
  }
  return out;
}

describe('context budget (T7-C1)', () => {
  it('limit = floor(0.8 × min(window, turnCeiling − maxOutput)); a non-finite or negative input is a zero limit (context_full)', () => {
    expect(contextBudgetLimit({ contextWindowTokens: 1_000_000, turnCeilingTokens: 44_000, maxOutputTokens: 4_000 })).toBe(32_000);
    expect(contextBudgetLimit({ contextWindowTokens: 10_000, turnCeilingTokens: 44_000, maxOutputTokens: 4_000 })).toBe(8_000);
    expect(contextBudgetLimit({ contextWindowTokens: 1_000_000, turnCeilingTokens: 4_000, maxOutputTokens: 5_000 })).toBe(0);
    expect(contextBudgetLimit({ contextWindowTokens: Number.NaN, turnCeilingTokens: 44_000, maxOutputTokens: 4_000 })).toBe(0);
    expect(applyContextBudget(input([{ role: 'user', content: 'hi' }], { turnCeilingTokens: 1_000, maxOutputTokens: 4_000 }))).toEqual({ action: 'context_full' });
  });

  it('under the limit: unchanged, the same array (nothing copied, nothing added)', () => {
    const messages = conversation(2);
    const r = applyContextBudget(input(messages));
    expect(r).toEqual({ action: 'unchanged', messages });
    if (r.action !== 'unchanged') throw new Error('expected unchanged');
    expect(r.messages).toBe(messages);
  });

  it('the estimate is the smaller of two upper bounds: previous step tokens + appended bytes, or the byte bound', () => {
    const messages = conversation(10);
    const byteBound = estimateInputTokens(messages, { previousStepInputTokens: null, appendedBytesSincePrevious: 0 });
    expect(byteBound).toBe(bytes(messages) + 2_048);
    expect(estimateInputTokens(messages, { previousStepInputTokens: 500, appendedBytesSincePrevious: 300 })).toBe(800);
    expect(estimateInputTokens(messages, { previousStepInputTokens: 10_000_000, appendedBytesSincePrevious: 0 })).toBe(byteBound);
    expect(estimateInputTokens(messages, { previousStepInputTokens: null, appendedBytesSincePrevious: 0 }, { prefixBytes: 1_000 })).toBe(byteBound + 1_000);
  });

  it('over the limit: the OLDEST non-skill result goes first, pairing kept, nothing else changes', () => {
    const messages = conversation();
    const full = estimateInputTokens(messages, { previousStepInputTokens: null, appendedBytesSincePrevious: 0 });
    const firstResultBytes = bytes((messages[2] as { content: Array<{ output: unknown }> }).content[0]!.output);
    const r = applyContextBudget(withLimit(messages, full - Math.floor(firstResultBytes / 2)));
    expect(r.action).toBe('trimmed');
    if (r.action !== 'trimmed') throw new Error('expected trimmed');
    expect(r.removedResults).toBe(1);
    const outputs = toolOutputs(r.messages);
    expect(outputs.c1).toEqual(omittedToolOutput('list_open_shifts'));
    expect(JSON.stringify(outputs.c1)).toContain(AI_CONTEXT_OMITTED_MARKER);
    for (const id of ['c2', 'c3', 'c4']) expect(outputs[id]).toEqual(toolOutputs(messages)[id]);
    // Same number of messages and parts, same roles, same call ids: no orphaned tool_use.
    expect(r.messages.map((m) => m.role)).toEqual(messages.map((m) => m.role));
    expect(r.messages.map((m) => JSON.stringify(m.content).match(/"toolCallId":"c\d"/g))).toEqual(messages.map((m) => JSON.stringify(m.content).match(/"toolCallId":"c\d"/g)));
    // Untouched messages are the same objects; the input array and messages were not mutated.
    expect(r.messages[0]).toBe(messages[0]);
    expect(r.messages[4]).toBe(messages[4]);
    expect(toolOutputs(messages).c1).not.toEqual(omittedToolOutput('list_open_shifts'));
  });

  it('skill content (load_skills) is trimmed only after every other older result; the newest result is never trimmed', () => {
    const messages = conversation();
    const totalOf = (ids: string[]) => ids.reduce((s, id) => s + bytes(toolOutputs(messages)[id]), 0);
    const full = estimateInputTokens(messages, { previousStepInputTokens: null, appendedBytesSincePrevious: 0 });
    // Needs more than the two older non-skill results (c1, c3) can give back → the skill result (c2) goes too.
    const r = applyContextBudget(withLimit(messages, full - totalOf(['c1', 'c3']) - 10));
    expect(r.action).toBe('trimmed');
    if (r.action !== 'trimmed') throw new Error('expected trimmed');
    const outputs = toolOutputs(r.messages);
    expect(r.removedResults).toBe(3);
    expect(outputs.c1).toEqual(omittedToolOutput('list_open_shifts'));
    expect(outputs.c3).toEqual(omittedToolOutput('count_offers'));
    expect(outputs.c2).toEqual(omittedToolOutput('load_skills'));
    expect(outputs.c4).toEqual(toolOutputs(messages).c4); // newest: kept
    // Asking for just the two non-skill results keeps the skill content.
    const r2 = applyContextBudget(withLimit(messages, full - totalOf(['c1']) - 10));
    if (r2.action !== 'trimmed') throw new Error('expected trimmed');
    expect(toolOutputs(r2.messages).c2).toEqual(toolOutputs(messages).c2);
    expect(toolOutputs(r2.messages).c3).toEqual(omittedToolOutput('count_offers'));
  });

  it('still over the limit after every older result is a stub → context_full (no request is built)', () => {
    const messages = conversation();
    expect(applyContextBudget(withLimit(messages, 3_000))).toEqual({ action: 'context_full' });
    // A plain text history that is simply too long has nothing to trim either.
    expect(applyContextBudget(withLimit([{ role: 'user', content: 'y'.repeat(20_000) }], 5_000))).toEqual({ action: 'context_full' });
  });

  it('never adds text: the trimmed request is never longer, and a result shorter than the stub is left alone', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'q' }, call('s1', 'tiny'), result('s1', 'tiny', 1), call('s2', 'list_open_shifts'), result('s2', 'list_open_shifts', big('shift', 60)), call('s3', 'x'), result('s3', 'x', 2)];
    const full = estimateInputTokens(messages, { previousStepInputTokens: null, appendedBytesSincePrevious: 0 });
    const r = applyContextBudget(withLimit(messages, full - 100));
    if (r.action !== 'trimmed') throw new Error('expected trimmed');
    expect(bytes(r.messages)).toBeLessThan(bytes(messages));
    expect(toolOutputs(r.messages).s1).toEqual(toolOutputs(messages).s1); // 1 is shorter than any stub
    expect(r.removedResults).toBe(1);
  });

  it('idempotent: applying the budget to its own output changes nothing', () => {
    const messages = conversation();
    const full = estimateInputTokens(messages, { previousStepInputTokens: null, appendedBytesSincePrevious: 0 });
    const budget = withLimit(messages, full - bytes(toolOutputs(messages).c1) - bytes(toolOutputs(messages).c3) - 10);
    const once = applyContextBudget(budget);
    if (once.action !== 'trimmed') throw new Error('expected trimmed');
    const twice = applyContextBudget({ ...budget, messages: once.messages });
    expect(twice.action).toBe('unchanged');
    if (twice.action !== 'unchanged') throw new Error('expected unchanged');
    expect(twice.messages).toEqual(once.messages);
  });

  it('with the previous step reported, trimming is driven by the byte bound of what remains (an upper bound, fails early)', () => {
    const messages = conversation();
    const full = estimateInputTokens(messages, { previousStepInputTokens: null, appendedBytesSincePrevious: 0 });
    // Reported tokens + appended bytes are under the limit → unchanged even though the byte bound is over it.
    expect(applyContextBudget({ ...withLimit(messages, 10_000), previousStepInputTokens: 9_000, appendedBytesSincePrevious: 500 }).action).toBe('unchanged');
    // Over: the byte bound of the trimmed messages must come under the limit.
    const r = applyContextBudget({ ...withLimit(messages, full - 100), previousStepInputTokens: full, appendedBytesSincePrevious: 0 });
    expect(r.action).toBe('trimmed');
  });
});
