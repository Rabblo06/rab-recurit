import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';

import { AI_TOOL_CATALOGUE_HEADER } from '../../../modules/ai/tools/ai-meta-tools';

/**
 * TEST-ONLY (docs/ai/PHASE1_TWENTY_PLAN.md §5, C6; Phase 3 catalogue routing, PHASE3_TWENTY_PLAN.md §2.2): a DETERMINISTIC,
 * rule-based language model implementing the AI SDK's LanguageModelV3 spec. It makes no network call and has no
 * randomness: the same prompt always produces the same tool call and the same reply. It lives under src/__tests__
 * (excluded by tsconfig.app.json), so it is NOT in `dist` or the built image; test modules inject it through
 * AI_LANGUAGE_MODEL_FACTORY + AI_TEST_MODEL_CATALOGUE (see ./test-catalogue.ts), which the server honours only when
 * NODE_ENV=test. `ai-mock-exclusion.spec.ts` proves it never reaches production code.
 *
 * Behaviour:
 *   - last message is a user question → pick ONE tool by keywords with explicit dates derived from the question and
 *     "today" (read from the system prompt):
 *       · LAZY (Phase 3, after 3w): the system prompt carries the "Tools you may use" catalogue and `execute_tool` is
 *         offered → the tool is called as `execute_tool({name, args})`, and ONLY if its name is in the catalogue (it
 *         never names a tool outside it); with `learnFirst` it calls `learn_tools({names:[name]})` first;
 *       · DIRECT (Phase 1 runner, until 3w): the tool itself, only if it is among the offered SDK tools;
 *     otherwise it answers that the data is not available to the user;
 *   - last message is a `learn_tools` result → the `execute_tool` call it was preparing;
 *   - last message is any other tool result → summarise the returned numbers by the wrapped `data.tool` (it never adds a
 *     number that is not in the tool result).
 * Token usage is estimated as ⌈characters / 4⌉ for input and output (deterministic, documented as an estimate).
 */
export class DeterministicMockModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider = 'crewflow-mock';
  readonly supportedUrls = {};

  constructor(
    readonly modelId: string,
    private readonly options: { learnFirst?: boolean } = {},
  ) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const plan = planResponse(options, this.options);
    const content: LanguageModelV3Content[] = plan.kind === 'tool'
      ? [{ type: 'tool-call', toolCallId: plan.toolCallId, toolName: plan.toolName, input: JSON.stringify(plan.input) }]
      : [{ type: 'text', text: plan.text }];
    return { content, finishReason: plan.finishReason, usage: plan.usage, warnings: [] };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const plan = planResponse(options, this.options);
    const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
    if (plan.kind === 'tool') {
      parts.push({ type: 'tool-call', toolCallId: plan.toolCallId, toolName: plan.toolName, input: JSON.stringify(plan.input) });
    } else {
      parts.push({ type: 'text-start', id: 'text-1' });
      for (const chunk of plan.text.match(/\S+\s*/g) ?? [plan.text]) parts.push({ type: 'text-delta', id: 'text-1', delta: chunk });
      parts.push({ type: 'text-end', id: 'text-1' });
    }
    parts.push({ type: 'finish', finishReason: plan.finishReason, usage: plan.usage });
    const signal = options.abortSignal;
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        for (const part of parts) {
          if (signal?.aborted) {
            controller.error(signal.reason ?? new Error('aborted'));
            return;
          }
          controller.enqueue(part);
          // Yield between parts so the stream behaves like a network stream (cancellation can interleave).
          await new Promise((resolve) => setImmediate(resolve));
        }
        controller.close();
      },
    });
    return { stream };
  }
}

type Plan =
  | { kind: 'tool'; toolCallId: string; toolName: string; input: Record<string, unknown>; finishReason: LanguageModelV3FinishReason; usage: LanguageModelV3Usage }
  | { kind: 'text'; text: string; finishReason: LanguageModelV3FinishReason; usage: LanguageModelV3Usage };

function usageOf(promptChars: number, outputChars: number): LanguageModelV3Usage {
  const input = Math.ceil(promptChars / 4);
  const output = Math.max(1, Math.ceil(outputChars / 4));
  return { inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: output, text: output, reasoning: undefined } };
}

function textOf(message: LanguageModelV3Message): string {
  if (message.role === 'system') return message.content;
  return message.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ');
}

/** The permitted tool names listed in the system prompt's catalogue block (empty when there is no block). */
export function catalogueNames(system: string): Set<string> {
  const at = system.indexOf(AI_TOOL_CATALOGUE_HEADER);
  if (at < 0) return new Set();
  const names = new Set<string>();
  for (const line of system.slice(at + AI_TOOL_CATALOGUE_HEADER.length).split('\n')) {
    const m = /^- ([a-z][a-z0-9_]{2,63}): /.exec(line);
    if (m) names.add(m[1]!);
    else if (line.trim() && !line.startsWith('- ')) break;
  }
  return names;
}

const toolCall = (toolName: string, input: Record<string, unknown>, promptLength: number, promptChars: number): Plan => ({
  kind: 'tool',
  toolCallId: `call_${toolName}_${promptLength}`,
  toolName,
  input,
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
  usage: usageOf(promptChars, JSON.stringify(input).length),
});

function planResponse(options: LanguageModelV3CallOptions, settings: { learnFirst?: boolean }): Plan {
  const prompt = options.prompt;
  const promptChars = JSON.stringify(prompt).length;
  const last = prompt[prompt.length - 1];
  const offered = new Set((options.tools ?? []).map((t) => t.name));
  const system = prompt.find((m) => m.role === 'system');
  const systemText = system && system.role === 'system' ? system.content : '';
  const catalogue = catalogueNames(systemText);
  const lazy = catalogue.size > 0 && offered.has('execute_tool');
  const firstUser = [...prompt].reverse().find((m) => m.role === 'user');
  const question = firstUser ? textOf(firstUser).toLowerCase() : '';
  const today = systemText.match(/Today is (\d{4}-\d{2}-\d{2})/)?.[1] ?? new Date().toISOString().slice(0, 10);

  if (last?.role === 'tool') {
    const result = last.content.find((p) => p.type === 'tool-result');
    if (result && result.type === 'tool-result' && result.toolName === 'learn_tools') {
      const choice = chooseTool(question, today);
      const learned = unwrap(result.output)?.data as { tools?: Array<{ name?: string }> } | undefined;
      if (choice && lazy && learned?.tools?.some((t) => t.name === choice.toolName)) {
        return toolCall('execute_tool', { name: choice.toolName, args: choice.input }, prompt.length, promptChars);
      }
      const text = 'I cannot access that information with your current permissions.';
      return { kind: 'text', text, finishReason: { unified: 'stop', raw: 'stop' }, usage: usageOf(promptChars, text.length) };
    }
    const text = result && result.type === 'tool-result' ? summarise(result.output, result.toolName) : 'I could not read that information.';
    return { kind: 'text', text, finishReason: { unified: 'stop', raw: 'stop' }, usage: usageOf(promptChars, text.length) };
  }
  const choice = chooseTool(last ? textOf(last).toLowerCase() : '', today);
  if (choice && lazy && catalogue.has(choice.toolName)) {
    if (settings.learnFirst && offered.has('learn_tools')) return toolCall('learn_tools', { names: [choice.toolName] }, prompt.length, promptChars);
    return toolCall('execute_tool', { name: choice.toolName, args: choice.input }, prompt.length, promptChars);
  }
  if (choice && !lazy && offered.has(choice.toolName)) return toolCall(choice.toolName, choice.input, prompt.length, promptChars);
  const text = choice
    ? 'I cannot access that information with your current permissions.'
    : 'I can help with shifts and unfilled shifts, fill rates, coverage gaps, venues, staff availability counts, attendance, offers, timesheets awaiting approval and payroll run totals. What would you like to know?';
  return { kind: 'text', text, finishReason: { unified: 'stop', raw: 'stop' }, usage: usageOf(promptChars, text.length) };
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function rangeFor(question: string, today: string): { from: string; to: string } {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  if (question.includes('weekend')) {
    const saturday = addDays(today, dow === 0 ? -1 : (6 - dow + 7) % 7);
    return { from: saturday, to: addDays(saturday, 1) };
  }
  if (question.includes('today')) return { from: today, to: today };
  if (question.includes('month')) return { from: `${today.slice(0, 8)}01`, to: today };
  if (question.includes('week')) {
    const monday = addDays(today, -((dow + 6) % 7));
    return { from: monday, to: addDays(monday, 6) };
  }
  return { from: today, to: addDays(today, 6) };
}

function chooseTool(question: string, today: string): { toolName: string; input: Record<string, unknown> } | null {
  if (/timesheet|awaiting approval|approval queue/.test(question)) return { toolName: 'get_timesheet_approval_queue', input: {} };
  if (/payroll|pay run|payrun|wage|more expensive/.test(question)) return { toolName: 'compare_payroll_runs', input: {} };
  if (/coverage|gaps?\b|rota/.test(question)) return { toolName: 'get_rota_coverage_gaps', input: rangeFor(question, today) };
  if (/availab/.test(question)) {
    const r = rangeFor(question, today);
    return { toolName: 'get_staff_availability', input: { from: r.from, to: r.to < addDays(r.from, 13) ? r.to : addDays(r.from, 13) } };
  }
  if (/fill rate|(?<!un)filled|percentage|% of/.test(question)) return { toolName: 'get_fill_rate', input: rangeFor(question, today) };
  if (/unfilled|need staff|needs staff|vacan|understaffed|under-filled|still need/.test(question)) return { toolName: 'list_unfilled_shifts', input: rangeFor(question, today) };
  if (/venue/.test(question)) return { toolName: 'get_venue_summary', input: rangeFor(question, today) };
  if (/pipeline|expiring/.test(question)) return { toolName: 'get_offer_pipeline', input: rangeFor(question, today) };
  if (/offer|awaiting|respond|reply|replies/.test(question)) return { toolName: 'get_offer_status', input: rangeFor(question, today) };
  if (/late|attendance|no.?show|clock/.test(question)) return { toolName: 'get_attendance_summary', input: rangeFor(question, today) };
  if (/how many shifts|count (the )?shifts/.test(question)) return { toolName: 'count_shifts', input: rangeFor(question, today) };
  if (/(find|show|list) (the |my )?shifts/.test(question)) return { toolName: 'find_shifts', input: rangeFor(question, today) };
  return null;
}

function unwrap(output: unknown): { tool?: string; data?: Record<string, unknown> } | null {
  const out = output as { type?: string; value?: unknown };
  return (out?.type === 'json' ? out.value : null) as { tool?: string; data?: Record<string, unknown> } | null;
}

function summarise(output: unknown, sdkToolName: string): string {
  const wrapped = unwrap(output);
  const d = wrapped?.data;
  if (!d || typeof d.error === 'string') return 'I could not read that information.';
  const range = d.range as { from?: string; to?: string } | undefined;
  const period = range ? ` (${range.from} to ${range.to})` : '';
  switch (wrapped?.tool ?? sdkToolName) {
    case 'list_unfilled_shifts': {
      const shifts = (d.shifts as Array<Record<string, unknown>>) ?? [];
      if (!d.unfilledShiftCount) return `No shifts still need staff${period}.`;
      const lines = shifts.map((s) => `- ${String(s.jobRole)}${s.venue ? ` at ${String(s.venue)}` : ''}, ${String(s.startsAt)}: ${String(s.vacancies)} of ${String(s.required)} still needed`);
      return [`${String(d.unfilledShiftCount)} shift(s) still need staff${period}:`, ...lines].join('\n');
    }
    case 'find_shifts':
      return `${String(d.total)} shift(s)${period}; ${String(d.listed)} listed.`;
    case 'count_shifts':
      return `${String(d.total)} shift(s)${period}.`;
    case 'get_fill_rate':
      return d.seatFillRatePercent === null
        ? `There are no staffable shifts${period}.`
        : `Fill rate${period}: ${String(d.seatFillRatePercent)}% of seats filled (${String(d.seatsFilled)} of ${String(d.seatsRequired)}); ${String(d.fullyStaffedShifts)} of ${String(d.shifts)} shifts are fully staffed.`;
    case 'get_rota_coverage_gaps':
      return `${String(d.gapGroups)} coverage gap group(s)${period}.`;
    case 'get_venue_summary':
      return `${String(d.listed)} venue(s)${period}.`;
    case 'get_staff_availability':
      return `Availability counts for ${String((d.byDay as unknown[] | undefined)?.length ?? 0)} day(s)${period}, ${String(d.activeStaff)} active staff (advisory).`;
    case 'get_timesheet_approval_queue':
      return `${String(d.awaitingApproval)} timesheet(s) awaiting approval, ${String(d.rejected)} rejected.`;
    case 'get_offer_pipeline':
      return `Offer pipeline${period}: ${String(d.awaitingStaffResponse)} waiting for a reply, ${String(d.expiringWithin24h)} expiring within 24 hours.`;
    case 'get_attendance_summary': {
      const noShows = (d.noShows as { confirmed?: number; provisional?: number }) ?? {};
      return `Attendance${period}: ${String(d.records)} clock-in record(s), ${String(d.lateClockIns)} late clock-in(s); no-shows: ${String(noShows.confirmed ?? 0)} confirmed, ${String(noShows.provisional ?? 0)} provisional.`;
    }
    case 'get_offer_status':
      return `Offers${period}: ${String(d.awaitingStaffResponse)} waiting for a staff reply, ${String(d.awaitingManagerConfirmation)} accepted and awaiting confirmation, ${String(d.total)} in total.`;
    case 'compare_payroll_runs': {
      if (d.available === false) return 'There is no payroll run to compare yet.';
      const cur = d.current as Record<string, unknown>;
      const prev = d.previous as Record<string, unknown> | null;
      const diff = d.differences as Record<string, unknown> | null;
      if (!prev || !diff) return `Payroll run ${String(cur.periodStart)} to ${String(cur.periodEnd)}: gross ${String(cur.grossTotalFormatted)}, ${String(cur.shiftRecords)} shift record(s). There is no earlier run to compare with.`;
      return `Payroll run ${String(cur.periodStart)}–${String(cur.periodEnd)}: gross ${String(cur.grossTotalFormatted)} vs ${String(prev.grossTotalFormatted)} (difference ${String(diff.grossTotalFormatted)}); shift records ${String(cur.shiftRecords)} vs ${String(prev.shiftRecords)}; hours ${String(cur.hours)} vs ${String(prev.hours)}.`;
    }
    default:
      return 'I could not read that information.';
  }
}
