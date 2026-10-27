import type { AiMetaToolName } from '@rab/shared';
import type { ModelMessage } from 'ai';

import { maxInputTokensFromBytes } from '../../../engine/core-modules/ai/models/cost';
import { AI_CONTEXT_BUDGET_RATIO, AiContextBudgetInput, AiContextBudgetResult } from '../contracts/usage';
import { wrapToolData } from '../prompt/system-prompt';

/**
 * Phase 7 context budget (docs/ai/PHASE7_TWENTY_PLAN.md §2.5, C7-7): a PURE step that runs FIRST in the gateway's
 * `prepareStep` (7b wiring), before the EX-1 checks and `scanOutgoingPayload`, which then scan exactly the messages this
 * returns (so what is scanned is what is sent).
 *
 *   limit    = floor(AI_CONTEXT_BUDGET_RATIO × min(contextWindowTokens, turnCeilingTokens − maxOutputTokens)).
 *   estimate = an UPPER BOUND of the next request's input tokens: the smaller of
 *                (a) the previous step's reported input tokens + the UTF-8 bytes appended since (step 0: not available), and
 *                (b) the UTF-8 byte bound of the messages (+ the fixed prefix bytes: system prompt + tool definitions, and
 *                    the provider framing allowance).
 *              Both are upper bounds (a byte-level BPE tokenizer never yields more tokens than bytes), so the smaller is
 *              one too: the estimate can only fail toward trimming early, never toward an oversized request.
 *
 * Over the limit, OLDER tool results are replaced, oldest first, by the fixed stub
 * `wrapToolData(name, { omitted: 'older_result_removed' })`:
 *   - the `tool-call` / `tool-result` pairing is kept (only the `output` changes; no part or message is ever removed,
 *     because Anthropic rejects an orphaned `tool_use`);
 *   - Phase 4 skill content (`load_skills`) is trimmed only after every other older result;
 *   - the results of the NEWEST tool message (the answer to the call the model just made) are never removed;
 *   - a result is replaced only when the stub is strictly shorter, so the step never adds text;
 *   - an existing stub is left as it is (idempotent: running the step on its own output changes nothing).
 * Still over the limit with nothing left to trim → `context_full` → `AiStepRefusedError('context_full')` →
 * `AI_CONTEXT_FULL` ("This conversation is too long. Start a new conversation.") BEFORE any request is sent.
 * Nothing is ever summarised and no model is ever asked to compress anything.
 */
export const AI_CONTEXT_OMITTED_MARKER = 'older_result_removed' as const;
const LOAD_SKILLS: AiMetaToolName = 'load_skills';

/** Inputs that are not (yet) part of the C0 `AiContextBudgetInput` contract (REQUEST.md: contract amendment proposed). */
export interface AiContextBudgetOptions {
  /** UTF-8 bytes of what every request carries besides `messages`: the system prompt and the serialised tool definitions. */
  prefixBytes?: number;
}

type ToolResultLike = { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown };

/** The fixed stub that replaces an older tool result's output. */
export function omittedToolOutput(toolName: string): { type: 'json'; value: ReturnType<typeof wrapToolData> } {
  return { type: 'json', value: wrapToolData(toolName, { omitted: AI_CONTEXT_OMITTED_MARKER }) };
}

export function contextBudgetLimit(input: Pick<AiContextBudgetInput, 'contextWindowTokens' | 'turnCeilingTokens' | 'maxOutputTokens'>): number {
  const { contextWindowTokens, turnCeilingTokens, maxOutputTokens } = input;
  if (![contextWindowTokens, turnCeilingTokens, maxOutputTokens].every((n) => Number.isFinite(n) && n >= 0)) return 0;
  return Math.max(0, Math.floor(AI_CONTEXT_BUDGET_RATIO * Math.min(contextWindowTokens, turnCeilingTokens - maxOutputTokens)));
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function nonNegative(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
}

/** Upper bound of the input tokens a request built from `messages` can have (see the module header). */
export function estimateInputTokens(messages: readonly ModelMessage[], input: Pick<AiContextBudgetInput, 'previousStepInputTokens' | 'appendedBytesSincePrevious'>, options: AiContextBudgetOptions = {}): number {
  const prefix = nonNegative(options.prefixBytes) ?? 0;
  const byteBound = maxInputTokensFromBytes(utf8Bytes(messages) + prefix);
  const previous = nonNegative(input.previousStepInputTokens);
  const appended = nonNegative(input.appendedBytesSincePrevious);
  if (previous === null || appended === null) return byteBound;
  return Math.min(byteBound, previous + appended);
}

function isToolResult(part: unknown): part is ToolResultLike {
  if (typeof part !== 'object' || part === null) return false;
  const p = part as Record<string, unknown>;
  return p.type === 'tool-result' && typeof p.toolName === 'string' && typeof p.toolCallId === 'string' && 'output' in p;
}

function isOmitted(part: ToolResultLike): boolean {
  return JSON.stringify(part.output) === JSON.stringify(omittedToolOutput(part.toolName));
}

interface Candidate {
  message: number;
  part: number;
  skills: boolean;
}

/** Applies the context budget to the next request's messages. Pure: the input array and its messages are never mutated. */
export function applyContextBudget(input: AiContextBudgetInput, options: AiContextBudgetOptions = {}): AiContextBudgetResult {
  const limit = contextBudgetLimit(input);
  if (limit <= 0) return { action: 'context_full' };
  const original = input.messages;
  if (estimateInputTokens(original, input, options) <= limit) return { action: 'unchanged', messages: original };

  // The newest message carrying tool results is protected: the model needs the answer to the call it just made.
  let newestToolMessage = -1;
  original.forEach((m, i) => {
    if (Array.isArray(m.content) && (m.content as unknown[]).some(isToolResult)) newestToolMessage = i;
  });
  const candidates: Candidate[] = [];
  original.forEach((m, i) => {
    if (i === newestToolMessage || !Array.isArray(m.content)) return;
    (m.content as unknown[]).forEach((part, j) => {
      if (!isToolResult(part) || isOmitted(part)) return;
      if (utf8Bytes(omittedToolOutput(part.toolName)) >= utf8Bytes(part.output)) return; // never adds text
      candidates.push({ message: i, part: j, skills: part.toolName === LOAD_SKILLS });
    });
  });
  // Oldest first; skill content (`load_skills`) only after every other older result. Stable within each group.
  candidates.sort((a, b) => Number(a.skills) - Number(b.skills) || a.message - b.message || a.part - b.part);

  const working: ModelMessage[] = [...original];
  let removed = 0;
  for (const c of candidates) {
    const message = working[c.message]!;
    const content = [...(message.content as unknown[])];
    const part = content[c.part] as ToolResultLike;
    content[c.part] = { ...part, output: omittedToolOutput(part.toolName) };
    working[c.message] = { ...message, content } as ModelMessage;
    removed += 1;
    if (estimateInputTokens(working, input, options) <= limit) return { action: 'trimmed', messages: working, removedResults: removed };
  }
  return { action: 'context_full' };
}
