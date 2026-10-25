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
