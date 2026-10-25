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

/**
 * AI_PROVIDER=mock — a DETERMINISTIC, rule-based language model implementing the AI SDK's LanguageModelV3 spec. It makes
 * no network call and has no randomness: the same prompt always produces the same tool call and the same reply. It
 * exists so the whole real path (API → BullMQ → Worker → tools → gateway → SSE) can run and be tested without provider
 * credentials. env.validation refuses `mock` in production, so it can never answer a real customer.
 *
 * Behaviour:
 *   - last message is a user question → pick ONE tool by keywords (only among the tools actually offered for this
 *     user) with explicit dates derived from the question and "today" (read from the system prompt), or answer that
 *     the data is not available to the user;
 *   - last message is a tool result → summarise the returned numbers in plain text (it never adds a number that is not
 *     in the tool result).
 * Token usage is estimated as ⌈characters / 4⌉ for input and output (deterministic, documented as an estimate).
 */
export class DeterministicMockModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider = 'crewflow-mock';
  readonly supportedUrls = {};

  constructor(readonly modelId: string) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const plan = planResponse(options);
    const content: LanguageModelV3Content[] = plan.kind === 'tool'
      ? [{ type: 'tool-call', toolCallId: plan.toolCallId, toolName: plan.toolName, input: JSON.stringify(plan.input) }]
      : [{ type: 'text', text: plan.text }];
    return { content, finishReason: plan.finishReason, usage: plan.usage, warnings: [] };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const plan = planResponse(options);
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

function planResponse(options: LanguageModelV3CallOptions): Plan {
  const prompt = options.prompt;
  const promptChars = JSON.stringify(prompt).length;
  const last = prompt[prompt.length - 1];
  const offered = new Set((options.tools ?? []).map((t) => t.name));
  if (last?.role === 'tool') {
    const result = last.content.find((p) => p.type === 'tool-result');
    const text = result && result.type === 'tool-result' ? summarise(result.toolName, result.output) : 'I could not read that information.';
    return { kind: 'text', text, finishReason: { unified: 'stop', raw: 'stop' }, usage: usageOf(promptChars, text.length) };
  }
  const question = last ? textOf(last).toLowerCase() : '';
  const system = prompt.find((m) => m.role === 'system');
  const today = (system && system.role === 'system' ? system.content.match(/Today is (\d{4}-\d{2}-\d{2})/)?.[1] : undefined) ?? new Date().toISOString().slice(0, 10);
  const choice = chooseTool(question, today);
  if (choice && offered.has(choice.toolName)) {
    const toolCallId = `call_${choice.toolName}_${prompt.length}`;
    return { kind: 'tool', toolCallId, toolName: choice.toolName, input: choice.input, finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: usageOf(promptChars, JSON.stringify(choice.input).length) };
  }
  const text = choice
    ? 'I cannot access that information with your current permissions.'
    : 'I can help with unfilled shifts, fill rates, attendance counts, offer status and payroll run totals. What would you like to know?';
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
  if (/payroll|pay run|payrun|wage|more expensive/.test(question)) return { toolName: 'compare_payroll_runs', input: {} };
  if (/fill rate|filled|percentage|% of/.test(question)) return { toolName: 'get_fill_rate', input: rangeFor(question, today) };
  if (/unfilled|need staff|needs staff|vacan|understaffed|under-filled|still need/.test(question)) return { toolName: 'list_unfilled_shifts', input: rangeFor(question, today) };
  if (/offer|awaiting|respond|reply|replies/.test(question)) return { toolName: 'get_offer_status', input: rangeFor(question, today) };
  if (/late|attendance|no.?show|clock/.test(question)) return { toolName: 'get_attendance_summary', input: rangeFor(question, today) };
  return null;
}

function summarise(toolName: string, output: unknown): string {
  const out = output as { type?: string; value?: unknown };
  const wrapped = (out?.type === 'json' ? out.value : null) as { data?: Record<string, unknown>; error?: string } | null;
  const d = wrapped?.data;
  if (!d) return 'I could not read that information.';
  const range = d.range as { from?: string; to?: string } | undefined;
  const period = range ? ` (${range.from} to ${range.to})` : '';
  switch (toolName) {
    case 'list_unfilled_shifts': {
      const shifts = (d.shifts as Array<Record<string, unknown>>) ?? [];
      if (!d.unfilledShiftCount) return `No shifts still need staff${period}.`;
      const lines = shifts.map((s) => `- ${String(s.jobRole)}${s.venue ? ` at ${String(s.venue)}` : ''}, ${String(s.startsAt)}: ${String(s.vacancies)} of ${String(s.required)} still needed`);
      return [`${String(d.unfilledShiftCount)} shift(s) still need staff${period}:`, ...lines].join('\n');
    }
    case 'get_fill_rate':
      return d.seatFillRatePercent === null
        ? `There are no staffable shifts${period}.`
        : `Fill rate${period}: ${String(d.seatFillRatePercent)}% of seats filled (${String(d.seatsFilled)} of ${String(d.seatsRequired)}); ${String(d.fullyStaffedShifts)} of ${String(d.shifts)} shifts are fully staffed.`;
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
      if (!prev || !diff) return `Payroll run ${String(cur.periodStart)} to ${String(cur.periodEnd)}: gross £${String(cur.grossTotalPounds)}, ${String(cur.shiftRecords)} shift record(s). There is no earlier run to compare with.`;
      return `Payroll run ${String(cur.periodStart)}–${String(cur.periodEnd)}: gross £${String(cur.grossTotalPounds)} vs £${String(prev.grossTotalPounds)} (difference £${String(diff.grossTotalPounds)}); shift records ${String(cur.shiftRecords)} vs ${String(prev.shiftRecords)}; hours ${String(cur.hours)} vs ${String(prev.hours)}.`;
    }
    default:
      return 'I could not read that information.';
  }
}
