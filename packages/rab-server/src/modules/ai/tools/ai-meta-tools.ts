import { AI_PLAN_LIMITS, AiToolParameterView } from '@rab/shared';
import { z } from 'zod';

import type { AiLearnedTool, AiToolCatalogueLine } from '../contracts/tools';
import { AI_EXECUTE_MAX_ARGS_BYTES, AI_LEARN_MAX_NAMES } from './ai-tool.constants';
import { AI_TOOL_NAME_PATTERN, AiToolDefinition } from './ai-tool.types';

/**
 * The two fixed SDK tools of lazy loading (AI Phase 3, docs/ai/PHASE3_TWENTY_PLAN.md §2.2, P3-D2): the model sees ONLY
 * these (plus, from 4w / 5b, `load_skills` and the pause tools — resolution X-4), never a domain tool directly.
 *
 * Each has a strict zod schema — the AUTHORITATIVE check, re-applied on the server inside the registry (rule 7.1) — and a
 * JSON schema published to the SDK that is frozen at boot with every `pattern` removed (`format` kept): a regex in a
 * schema is opaque text that the outgoing-payload guard could mistake for a token and refuse every real-provider turn
 * (T-L3). The SDK is given that JSON schema WITHOUT a validator, so the registry's strict parse is the only gate and a
 * malformed call is still recorded and audited (`invalid_input`) instead of disappearing as an SDK error.
 */

const toolName = z.string().regex(AI_TOOL_NAME_PATTERN);
/** A plan label may never present itself as an approval (TW-D8). */
const PLAN_APPROVAL_CLAIM = /\b(plan|proposal|changes?|action)\s+(is\s+|was\s+|has\s+been\s+)?approved\b|\bapproved\s+by\b/i;

export const LEARN_TOOLS_INPUT = z.strictObject({
  names: z.array(toolName).min(1).max(AI_LEARN_MAX_NAMES).describe(`1 to ${AI_LEARN_MAX_NAMES} tool names from the catalogue.`),
});

export const EXECUTE_TOOL_INPUT = z
  .strictObject({
    name: toolName.describe('A tool name from the catalogue.'),
    args: z.record(z.string().max(64), z.unknown()).default({}).describe("The tool's arguments, exactly as learn_tools described them."),
  })
  .refine((v) => Buffer.byteLength(JSON.stringify(v.args), 'utf8') <= AI_EXECUTE_MAX_ARGS_BYTES, { message: `args must be at most ${AI_EXECUTE_MAX_ARGS_BYTES} bytes of JSON.` });

export const LEARN_TOOLS_DESCRIPTION =
  'Returns the description, arguments (JSON schema), output fields and limits of up to 5 tools named in the "Tools you may use" catalogue. Learning is optional; it never runs a tool. Read-only.';
export const EXECUTE_TOOL_DESCRIPTION =
  'Runs ONE read-only tool from the "Tools you may use" catalogue with its arguments ({"name": "...", "args": {...}}). Arguments are checked strictly by the server; unknown fields are refused. Read-only.';

/** Recursively freezes a plain JSON value (published schemas and learned entries are immutable after boot). */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** JSON schema of a zod input as the model may see it: `pattern` and `$schema` removed everywhere, `format` kept, frozen. */
export function publishedInputSchema(schema: z.ZodType): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'pattern' || key === '$schema') continue;
        out[key] = strip(inner);
      }
      return out;
    }
    return value;
  };
  return deepFreeze(strip(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })) as Record<string, unknown>);
}

export const LEARN_TOOLS_JSON_SCHEMA = publishedInputSchema(LEARN_TOOLS_INPUT);
export const EXECUTE_TOOL_JSON_SCHEMA = publishedInputSchema(EXECUTE_TOOL_INPUT);

/** One `learn_tools` entry, built once per tool at boot (fixed server text + frozen schema; no record data). */
export function learnedToolOf(def: AiToolDefinition): AiLearnedTool {
  return deepFreeze({
    name: def.name,
    description: def.description,
    inputSchema: publishedInputSchema(def.input),
    // Output field names only (the allowlist), never values.
    outputFields: [...def.outputKeys],
    limits: { ...def.limits },
  } satisfies AiLearnedTool);
}

/** Header line of the system prompt's catalogue block (3w: `buildSystemPrompt(today, catalogue)` appends it). */
export const AI_TOOL_CATALOGUE_HEADER = 'Tools you may use (call learn_tools with up to 5 of these names to see their arguments, then execute_tool with {"name", "args"}; no other tool exists):';

/**
 * The catalogue block: one `- name: summary` line per PERMITTED read tool, name-sorted, fixed server text only (rule 5.2:
 * no record data in the system prompt) — byte-stable for a given permission set (Phase 7 prompt caching).
 */
export function renderToolCatalogue(catalogue: readonly AiToolCatalogueLine[]): string {
  const lines = [...catalogue].sort((a, b) => a.name.localeCompare(b.name)).map((l) => `- ${l.name}: ${l.summary}`);
  return [AI_TOOL_CATALOGUE_HEADER, ...(lines.length ? lines : ['- (none: you have no data tools for this question)'])].join('\n');
}

/**
 * `update_plan` (C1 CD-7 / TW-D8): an informational checklist the model may keep for the user. Kind `meta`, NO permission
 * and NO data access: the registry only masks and records the labels (they never reach a query). Strict input, ≤ 8 steps,
 * labels ≤ 100 characters; at most 6 updates per turn, each also counted in the per-turn tool-call cap. A plan is never an
 * approval: a label claiming one is refused, and nothing in the result says "approved".
 */
export const UPDATE_PLAN_INPUT = z.strictObject({
  steps: z
    .array(
      z.strictObject({
        label: z.string().trim().min(1).max(AI_PLAN_LIMITS.labelMaxChars).refine((v) => !PLAN_APPROVAL_CLAIM.test(v), { message: 'A plan step cannot claim an approval.' }),
        status: z.enum(['pending', 'in_progress', 'done']),
      }),
    )
    .min(1)
    .max(AI_PLAN_LIMITS.maxSteps)
    .describe(`1 to ${AI_PLAN_LIMITS.maxSteps} steps; each label at most ${AI_PLAN_LIMITS.labelMaxChars} characters of plain text.`),
});
export const UPDATE_PLAN_DESCRIPTION =
  'Shows the user a short checklist of what you are doing for this question (at most 8 steps with status pending, in_progress or done). Information only: it changes nothing, runs nothing and is never an approval.';
export const UPDATE_PLAN_JSON_SCHEMA = publishedInputSchema(UPDATE_PLAN_INPUT);

/**
 * C1 (CD-9): the human parameter list of a tool, derived ONCE at registry build from its strict zod input (through the
 * same published JSON schema the model learns): name, type, required, the fixed `.describe()` text and human bounds.
 */
export function toolParametersOf(def: Pick<AiToolDefinition, 'input' | 'limits'>): AiToolParameterView[] {
  const schema = publishedInputSchema(def.input) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, p]) => {
    const items = (p.items ?? {}) as Record<string, unknown>;
    const enumValues = Array.isArray(p.enum) ? (p.enum as string[]) : Array.isArray(items.enum) ? (items.enum as string[]) : undefined;
    const type: AiToolParameterView['type'] =
      p.type === 'array' ? 'array'
      : enumValues ? 'enum'
      : p.format === 'date' ? 'date'
      : p.format === 'uuid' ? 'uuid'
      : p.type === 'integer' ? 'integer'
      : p.type === 'number' ? 'number'
      : p.type === 'boolean' ? 'boolean'
      : 'string';
    const bounds: string[] = [];
    if ((name === 'from' || name === 'to') && def.limits.maxDays) bounds.push(`range at most ${def.limits.maxDays} days`);
    if (typeof p.minimum === 'number' && typeof p.maximum === 'number') bounds.push(`${p.minimum}–${p.maximum}`);
    if (typeof p.maxItems === 'number') bounds.push(`up to ${p.maxItems} values`);
    return Object.freeze({
      name,
      type,
      required: required.has(name),
      description: typeof p.description === 'string' ? p.description : '',
      limits: bounds.length ? bounds.join(', ') : null,
      ...(enumValues ? { enumValues: [...enumValues] } : {}),
    });
  });
}
