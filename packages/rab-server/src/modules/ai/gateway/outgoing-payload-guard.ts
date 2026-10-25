/**
 * AI Part A owner-approved exception (docs/ai/crewflow-ai-security-prompt.md, appendix "Owner-approved exceptions"):
 * before EVERY real-provider request the outgoing payload — the system prompt, the history, the user message and every
 * tool result, exactly as they will be sent — is scanned, and the request is REFUSED when anything below is found.
 * Pure: no I/O, no logging. Returns CATEGORIES only; the matched text is never returned, so callers cannot log it.
 *
 * Detection is deliberately broad (false positives refuse a dev question; false negatives would send personal data).
 * It does not make free text safe: it is one control next to synthetic-only organisations, masking and tool allowlists.
 */
export const SensitiveCategory = {
  EMAIL: 'email',
  PHONE: 'phone',
  NI_NUMBER: 'ni_number',
  BANK_DETAILS: 'bank_details',
  POSTCODE: 'postcode',
  CARD_NUMBER: 'card_number',
  TOKEN: 'token',
  API_KEY: 'api_key',
} as const;
export type SensitiveCategoryType = (typeof SensitiveCategory)[keyof typeof SensitiveCategory];

/** The one domain synthetic data may use (seed-ai-demo, the marker function). */
export const SYNTHETIC_EMAIL_DOMAIN = 'example.test';

// Identifiers and timestamps the system and the tools emit themselves; removed before the digit-based checks so a UUID or
// an ISO date is never mistaken for a phone, card or account number.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_DATE_TIME = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

const EMAIL = /[A-Z0-9._%+-]+@([A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,})/gi;
// UK: 0 or +44 / 0044 then 9-10 more digits, separators space . - ( ) allowed. International: + then 8-15 digits.
const PHONE_UK = /(?:\+44|0044|\b0)[\s.\-()]*(?:\d[\s.\-()]*){9,10}\d?/g;
const PHONE_INTL = /\+\d{1,3}[\s.\-()]*(?:\d[\s.\-()]*){6,14}\d/g;
const NI_NUMBER = /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;
const SORT_CODE = /\b\d{2}[-\s]\d{2}[-\s]\d{2}\b/g;
const SORT_CODE_ACCOUNT = /\b\d{6}\s?\d{8}\b/g;
const ACCOUNT_NEAR_WORDS = /\b(?:sort\s*code|account\s*(?:no|number|#)|acc(?:t)?\s*(?:no|#)|iban|swift|bic)\b[^\n]{0,24}\d{6,}/gi;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g;
const POSTCODE = /\b(?:GIR\s?0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?\s?\d[ABD-HJLNP-UW-Z]{2})\b/gi;
const CARD_RUN = /\b(?:\d[ -]?){12,18}\d\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
const PREFIXED_SECRET = /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi;
const LONG_OPAQUE = /\b[A-Za-z0-9_+/=-]{40,}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasLettersAndDigits(s: string): boolean {
  return /[A-Za-z]/.test(s) && /\d/.test(s);
}

/** Categories found in `text`. `secrets` are exact values that must never leave (the provider key canary). */
export function detectSensitiveContent(text: string, opts: { secrets?: readonly (string | null | undefined)[] } = {}): SensitiveCategoryType[] {
  const found = new Set<SensitiveCategoryType>();
  for (const secret of opts.secrets ?? []) if (secret && secret.length >= 8 && text.includes(secret)) found.add(SensitiveCategory.API_KEY);

  for (const m of text.matchAll(EMAIL)) if (m[1]!.toLowerCase() !== SYNTHETIC_EMAIL_DOMAIN) found.add(SensitiveCategory.EMAIL);

  if (JWT.test(text) || PREFIXED_SECRET.test(text) || BEARER.test(text)) found.add(SensitiveCategory.TOKEN);
  JWT.lastIndex = PREFIXED_SECRET.lastIndex = BEARER.lastIndex = 0;

  // Digit-based checks on a copy without UUIDs, ISO dates and synthetic email addresses.
  const cleaned = text.replace(UUID, ' ').replace(ISO_DATE_TIME, ' ').replace(EMAIL, ' ');
  for (const m of cleaned.matchAll(LONG_OPAQUE)) if (hasLettersAndDigits(m[0])) found.add(SensitiveCategory.TOKEN);
  if (PHONE_UK.test(cleaned) || PHONE_INTL.test(cleaned)) found.add(SensitiveCategory.PHONE);
  PHONE_UK.lastIndex = PHONE_INTL.lastIndex = 0;
  if (NI_NUMBER.test(cleaned)) found.add(SensitiveCategory.NI_NUMBER);
  NI_NUMBER.lastIndex = 0;
  if (SORT_CODE.test(cleaned) || SORT_CODE_ACCOUNT.test(cleaned) || ACCOUNT_NEAR_WORDS.test(cleaned) || IBAN.test(cleaned)) found.add(SensitiveCategory.BANK_DETAILS);
  SORT_CODE.lastIndex = SORT_CODE_ACCOUNT.lastIndex = ACCOUNT_NEAR_WORDS.lastIndex = IBAN.lastIndex = 0;
  if (POSTCODE.test(cleaned)) found.add(SensitiveCategory.POSTCODE);
  POSTCODE.lastIndex = 0;
  for (const m of cleaned.matchAll(CARD_RUN)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) found.add(SensitiveCategory.CARD_NUMBER);
  }
  return [...found].sort();
}

/**
 * The whole outgoing request: the system prompt, every message (user, assistant, tool results) serialised exactly as the
 * SDK receives it, plus any extra texts the caller wants checked (the UNMASKED user input — see the runner).
 */
export function scanOutgoingPayload(
  payload: { system: string; messages: unknown; extraTexts?: readonly string[] },
  opts: { secrets?: readonly (string | null | undefined)[] } = {},
): SensitiveCategoryType[] {
  const messages = withoutProviderOpaqueFields(payload.messages ?? []);
  const parts = [payload.system, JSON.stringify(messages), ...(payload.extraTexts ?? [])];
  const found = new Set<SensitiveCategoryType>();
  for (const part of parts) for (const c of detectSensitiveContent(part, opts)) found.add(c);
  // JSON escaping could split a value ("@"); scan the decoded strings too.
  for (const s of collectStrings(messages)) for (const c of detectSensitiveContent(s, opts)) found.add(c);
  return [...found].sort();
}

/**
 * Provider-generated opaque fields (`providerOptions` / `providerMetadata`, e.g. a reasoning `signature`) are base64 the
 * provider itself issued and replays; they carry no Crewflow data and would always look like tokens. Everything else —
 * every text, every tool input and every tool result — is scanned.
 */
const PROVIDER_OPAQUE_KEYS = new Set(['providerOptions', 'providerMetadata', 'signature', 'redactedData']);
function withoutProviderOpaqueFields(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => withoutProviderOpaqueFields(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (!PROVIDER_OPAQUE_KEYS.has(k)) out[k] = withoutProviderOpaqueFields(v, depth + 1);
  return out;
}

function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || value === null || value === undefined) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out, depth + 1);
  else if (typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out, depth + 1);
  return out;
}
