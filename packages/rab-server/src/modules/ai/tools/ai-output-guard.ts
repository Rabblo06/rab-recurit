/**
 * The last line between a tool implementation and the model (docs/ai/PHASE1_PLAN.md, data minimisation). Pure.
 *
 * 1. ALLOWLIST: every object key at every depth must be in the tool's `outputKeys`; anything else is dropped.
 * 2. DENYLIST (defence in depth, fail closed): a key that names a sensitive category — NI number, bank detail, right to
 *    work, passport, emergency contact, note, password, token, secret, MFA, rate/salary/pay per person, email, phone,
 *    address — is REFUSED even if a tool mistakenly allowlisted it: the whole result is withheld (AiToolOutputRefused).
 * 3. VALUE MASKING: strings are trimmed, stripped of control characters and angle brackets (no markup reaches the
 *    model as structure), capped at 160 characters, and anything shaped like an email address, a UK NI number, a sort
 *    code/account number or a phone number is masked.
 * 4. BOUNDS: arrays cut to `maxRows`, depth ≤ 4, numbers must be finite.
 */
import { wrapToolData } from '../prompt/system-prompt';
import { AI_TOOL_DEFAULT_OUTPUT_BYTES, AI_TOOL_MAX_OUTPUT_BYTES } from './ai-tool.constants';

export const AI_OUTPUT_DENYLIST_KEY = /(pass(word)?|token|secret|mfa|totp|recovery|iban|sort_?code|account_?(no|number)|bank|national_?insurance|\bni_?(no|number)?\b|nino|right_?to_?work|rtw|passport|visa|emergency|note|salary|pay_?rate|hourly|charge_?rate|rate_?pence|net_?pence|payslip|email|phone|mobile|address|postcode|date_?of_?birth|dob|lat(itude)?$|lng|longitude)/i;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const NI_NUMBER = /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;
const SORT_CODE = /\b\d{2}-\d{2}-\d{2}\b/g;
const LONG_DIGITS = /\+?\d[\d\s-]{7,}\d/g;
const MAX_STRING = 160;
/** Identifiers and timestamps the tools emit themselves are passed through unmasked (a digit run inside a UUID is not a phone number). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const MAX_DEPTH = 4;

export class AiToolOutputRefused extends Error {
  constructor(readonly key: string) {
    super('tool output contained a denylisted field');
    this.name = 'AiToolOutputRefused';
  }
}

export function maskSensitiveText(value: string): string {
  return value
    .replace(EMAIL, '[email removed]')
    .replace(NI_NUMBER, '[id removed]')
    .replace(SORT_CODE, '[number removed]')
    .replace(LONG_DIGITS, (m) => (/^\d{4}-\d{2}-\d{2}/.test(m) ? m : '[number removed]'));
}

export function sanitiseText(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return maskSensitiveText(cleaned).slice(0, MAX_STRING);
}

/** Exported for tests: the guard applied to every tool result before the model sees it. */
export function guardToolOutput(value: unknown, opts: { allowedKeys: ReadonlySet<string>; maxRows: number }): unknown {
  return walk(value, opts, 0);
}

function walk(value: unknown, opts: { allowedKeys: ReadonlySet<string>; maxRows: number }, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return UUID.test(value) || ISO_DATE_TIME.test(value) ? value : sanitiseText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, opts.maxRows).map((item) => walk(item, opts, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (AI_OUTPUT_DENYLIST_KEY.test(key)) throw new AiToolOutputRefused(key);
      if (!opts.allowedKeys.has(key)) continue;
      out[key] = walk(inner, opts, depth + 1);
    }
    return out;
  }
  return null;
}

/** UTF-8 size of a value as the model receives it (JSON). */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export type AiRedactedOutput =
  | { ok: true; payload: ReturnType<typeof wrapToolData>; rows: number; truncated: boolean; bytes: number }
  | { ok: false; error: 'output_too_large' };

/**
 * `redactForModel()` (AI Phase 3, rule 3.4, docs/ai/PHASE3_TWENTY_PLAN.md §2.4, P3-D4): the ONE path from a tool result to
 * the model. 1) `guardToolOutput` unchanged — allowlist, denylist refusal (throws AiToolOutputRefused), masking, strings ≤
 * 160 characters, arrays ≤ the tool's `maxRows`, depth ≤ 4; 2) wrapped as untrusted data; 3) a UTF-8 byte cap on the
 * WRAPPED JSON (`def.maxBytes`, default 8 KB, never above 16 KB): trailing array rows are dropped (the longest array
 * first) and `truncated: true` is set (with `listed` updated when the tool reports it); if no row is left to drop and it
 * is still too large, the result is refused as `output_too_large`. A string or a JSON value is NEVER cut in the middle.
 */
export function redactForModel(value: unknown, def: { name: string; outputKeys: readonly string[]; maxRows: number; maxBytes?: number }): AiRedactedOutput {
  const cap = Math.min(def.maxBytes ?? AI_TOOL_DEFAULT_OUTPUT_BYTES, AI_TOOL_MAX_OUTPUT_BYTES);
  const guarded = guardToolOutput(value, { allowedKeys: new Set(def.outputKeys), maxRows: def.maxRows });
  let payload = wrapToolData(def.name, guarded);
  let bytes = jsonBytes(payload);
  if (bytes <= cap) return { ok: true, payload, rows: countRows(guarded), truncated: isTruncated(guarded), bytes };
  if (!guarded || typeof guarded !== 'object' || Array.isArray(guarded)) return { ok: false, error: 'output_too_large' };
  const data = guarded as Record<string, unknown>;
  const arrays = collectArrays(data);
  while (bytes > cap) {
    const longest = arrays.filter((a) => a.length > 0).sort((a, b) => b.length - a.length)[0];
    if (!longest) return { ok: false, error: 'output_too_large' };
    longest.pop();
    data.truncated = true;
    const topLevel = Object.values(data).filter(Array.isArray);
    if (typeof data.listed === 'number' && topLevel.length === 1) data.listed = (topLevel[0] as unknown[]).length;
    payload = wrapToolData(def.name, data);
    bytes = jsonBytes(payload);
  }
  return { ok: true, payload, rows: countRows(data), truncated: true, bytes };
}

/** Arrays inside a guarded result (depth ≤ 4, as the guard allows), the cut candidates. */
function collectArrays(value: unknown, out: unknown[][] = [], depth = 0): unknown[][] {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    out.push(value);
    for (const item of value) collectArrays(item, out, depth + 1);
    return out;
  }
  for (const inner of Object.values(value as Record<string, unknown>)) collectArrays(inner, out, depth + 1);
  return out;
}

function isTruncated(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).truncated === true);
}

/** Rows a result carries: the length of its first array (top-level), 1 for a scalar result. */
export function countRows(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) if (Array.isArray(inner)) return inner.length;
  }
  return 1;
}
