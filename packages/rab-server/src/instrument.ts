/**
 * Must be imported before any other module in every entrypoint (main.ts,
 * packages/rab-worker/src/main.ts, packages/rab-server/src/command/main.ts) so Sentry can instrument
 * everything that loads after it.
 *
 * Privacy contract (Phase 0 "Sentry"): no event, transaction, span or breadcrumb that leaves this process may carry
 * request cookies, request headers (Authorization), request bodies, query strings, URL fragments, URL userinfo, client
 * IPs, SQL text, email addresses, JWTs, bearer tokens or `token=` / `code=` / `password=` / `secret=` values. Two layers
 * enforce it:
 *   1. collection: `sendDefaultPii: false` and a `requestDataIntegration` that attaches no cookies, body, headers,
 *      query string, IP or user;
 *   2. egress: `beforeSend`, `beforeSendTransaction`, `beforeSendSpan` and `beforeBreadcrumb` scrub whatever another
 *      integration (HTTP/OTel span attributes, outgoing-request breadcrumbs, console breadcrumbs, `extra`) still adds.
 * Error types and stack frames are kept so Sentry stays useful. `includeLocalVariables` and
 * `extraErrorDataIntegration` must stay off: both copy arbitrary in-memory values into events.
 *
 * The scrubbers run on the main thread over attacker-influenced text (URL paths, headers echoed in messages), so:
 *   - every string is capped at MAX_STRING_LENGTH before any regex runs, and every regex is linear-time (left-anchored
 *     by a negative lookbehind or a literal, bounded quantifiers) — see the S-1 tests in instrument.spec.ts;
 *   - every hook fails closed: if scrubbing throws, the event / transaction / breadcrumb is dropped and a span is
 *     reduced to empty data. A throwing `beforeSend` must never reach Sentry, because Sentry re-captures the thrown
 *     error as an "internal" event that skips `beforeSend` and carries the scope's unscrubbed `extra`.
 *
 * Everything above the final `Sentry.init` is pure and exported so it can be unit-tested without initialising Sentry
 * (see instrument.spec.ts and instrument.envelope.spec.ts).
 */
import * as Sentry from '@sentry/node';
import type { Breadcrumb, ErrorEvent, Event, NodeOptions } from '@sentry/node';

type SpanJSON = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];
type TransactionEvent = Parameters<
  NonNullable<NodeOptions['beforeSendTransaction']>
>[0];
type SentryEnv = Readonly<Record<string, string | undefined>>;

export const FILTERED = '[Filtered]';

/** Trace sample rate in production when `SENTRY_TRACES_SAMPLE_RATE` is unset or invalid (0 everywhere else). */
export const PRODUCTION_DEFAULT_TRACES_SAMPLE_RATE = 0.01;

/** Longest string (characters) any scrubber regex ever sees. Longer strings are cut at a token boundary + '…'. */
export const MAX_STRING_LENGTH = 2048;

const MAX_DEPTH = 8;
const MAX_BREADTH = 1000;
const MAX_KEY_LENGTH = 256;

// ---------------------------------------------------------------------------------------------------------------------
// Free-text redaction. Every pattern below is linear-time: each either starts with a literal word, or with a negative
// lookbehind so a run of matching characters is only ever tried from its first character, and every open-ended
// quantifier that could rescan the input is bounded.
// ---------------------------------------------------------------------------------------------------------------------

// `scheme://user:pass@` anywhere (postgres://, redis://, https://, IP hosts).
const USERINFO_RE =
  /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)[^\s/?#@]{1,256}@/g;
// A JWS/JWE header always base64url-encodes `{"` → `eyJ`; also catches a truncated token (header + partial payload).
const JWT_RE = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*)*/g;
// Other three-segment base64url tokens with long segments (opaque signed tokens with unusual headers).
const DOTTED_TOKEN_RE =
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g;
const EMAIL_RE =
  /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63}){0,8}\.[A-Z]{2,24}/gi;
const AUTH_SCHEME_RE =
  /\b(Bearer|Basic|Digest)\s{1,16}(?!\[Filtered\])[A-Za-z0-9._~+/=-]{1,4096}/gi;
// Cookie / Set-Cookie / Authorization header lines quoted in a message.
const HEADER_LINE_RE =
  /\b(cookie|set-cookie|authorization|proxy-authorization|x-api-key)(\s{0,16}:\s{0,16})(?!\s{0,16}\[Filtered\])[^\r\n]{1,4096}/gi;
// `name=value` (query strings, form bodies, log lines): any of these names.
const EQ_PARAM_NAMES =
  'token|access_token|refresh_token|id_token|code|password|passwd|pwd|secret|client_secret|api_key|apikey|' +
  'signature|sig|session_id|sessionid|otp|jwt|ticket|credential|credentials';
// `name: value` (log lines): only unambiguous credential names — `code: 23505` / `state: DRAFT` stay readable.
const COLON_PARAM_NAMES =
  'token|access_token|refresh_token|id_token|password|passwd|secret|client_secret|api_key|apikey|otp|jwt';
// The value: a single- or double-quoted string (closing quote optional, bounded), or a bare token.
const PARAM_VALUE = String.raw`(?:"[^"\r\n]{0,512}"?|'[^'\r\n]{0,512}'?|(?!\[Filtered\])[^\s&"',;#]{1,1024})`;
const EQ_PARAM_RE = new RegExp(
  String.raw`\b(${EQ_PARAM_NAMES})(\s{0,16}=\s{0,16})${PARAM_VALUE}`,
  'gi',
);
const COLON_PARAM_RE = new RegExp(
  String.raw`\b(${COLON_PARAM_NAMES})(\s{0,16}:\s{0,16})${PARAM_VALUE}`,
  'gi',
);
// `"name": "value"` (JSON embedded in a message).
const JSON_PARAM_RE = new RegExp(
  String.raw`("(?:${EQ_PARAM_NAMES}|authorization|cookie)"\s{0,16}:\s{0,16})"(?:[^"\\\r\n]|\\.){0,1024}"?`,
  'gi',
);

const CUT_SEPARATORS = new Set(' \t\r\n/?#&=,;:\'"()<>[]{}|\\'.split(''));

/**
 * Caps a string at MAX_STRING_LENGTH. The cut moves back to the previous separator so no partial token (half a JWT,
 * the start of an email or password) survives past the redaction patterns that need the whole token to match.
 */
export function capLength(input: string): string {
  if (input.length <= MAX_STRING_LENGTH) return input;
  let end = MAX_STRING_LENGTH;
  while (end > 0 && !CUT_SEPARATORS.has(input[end - 1])) end--;
  return `${input.slice(0, end)}…`;
}

/** Removes credentials and personal identifiers from free text. Idempotent; linear in min(length, 2048). */
export function redactString(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  return capLength(input)
    .replace(USERINFO_RE, '$1')
    .replace(HEADER_LINE_RE, `$1$2${FILTERED}`)
    .replace(JWT_RE, FILTERED)
    .replace(DOTTED_TOKEN_RE, FILTERED)
    .replace(AUTH_SCHEME_RE, `$1 ${FILTERED}`)
    .replace(JSON_PARAM_RE, `$1"${FILTERED}"`)
    .replace(EQ_PARAM_RE, `$1$2${FILTERED}`)
    .replace(COLON_PARAM_RE, `$1$2${FILTERED}`)
    .replace(EMAIL_RE, FILTERED);
}

/** Drops the query string and fragment of a URL (absolute or relative), then redacts the rest (incl. userinfo). */
export function stripUrlQueryAndFragment(url: string): string {
  if (typeof url !== 'string') return url;
  const cut = url.search(/[?#]/);
  return redactString(cut === -1 ? url : url.slice(0, cut));
}

// ---------------------------------------------------------------------------------------------------------------------
// Structured data (extra, tags, contexts, breadcrumb data, span attributes)
// ---------------------------------------------------------------------------------------------------------------------

/** Object keys whose value is replaced wholesale, whatever it is (`password_hash`, `passwordHash`, `oldPassword`, …). */
const SENSITIVE_KEY_RE =
  /pass(word|wd|phrase)|^pwd$|^pass$|secret|token|authori[sz]ation|cookie|api[-_]?key|private[-_]?key|credential|^otp$|^mfa[-_]?code$|^session([-_]?(id|token))?$|^jwt$|^signature$/i;

/** Attributes that are dropped: SQL text, raw query strings/fragments, request/response headers and bodies, client IPs. */
const DROPPED_KEY_RE =
  /^(db\.statement|db\.query\.text|db\.query\.parameter\..*|http\.query|http\.fragment|url\.query|url\.fragment|http\.request\.header\..*|http\.response\.header\..*|http\.request\.body.*|http\.response\.body.*|net\.peer\.ip|net\.sock\.peer\.addr|http\.client_ip|client\.address|network\.peer\.address|user\.email|user\.ip_address|ip_address)$/i;

/** Keys holding a URL or request target: kept, minus query string and fragment. */
const URL_KEY_RE =
  /^(url|http\.url|url\.full|http\.target|url\.path|url\.original|http\.route|server\.url)$/i;

/**
 * Recursively scrubs a JSON-like value: dropped keys removed, sensitive keys → `[Filtered]`, URL keys lose their
 * query/fragment, every string (keys included) goes through `redactString`. Returns a new value; never mutates input.
 */
export function scrubData<T>(
  value: T,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (depth >= MAX_DEPTH) return FILTERED as unknown as T;
  if (seen.has(value as object)) return '[Circular]' as unknown as T;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_BREADTH)
      .map((item) => scrubData(item, depth + 1, seen)) as unknown as T;
  }
  if (value instanceof Error) {
    return `${String(value.name).slice(0, 128)}: ${redactString(value.message)}` as unknown as T;
  }

  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [rawKey, raw] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (++count > MAX_BREADTH) break;
    const key =
      rawKey.length > MAX_KEY_LENGTH ? rawKey.slice(0, MAX_KEY_LENGTH) : rawKey;
    if (DROPPED_KEY_RE.test(key)) continue;
    const outKey = redactString(key);
    if (SENSITIVE_KEY_RE.test(key)) {
      out[outKey] = FILTERED;
    } else if (URL_KEY_RE.test(key) && typeof raw === 'string') {
      out[outKey] = stripUrlQueryAndFragment(raw);
    } else {
      out[outKey] = scrubData(raw, depth + 1, seen);
    }
  }
  return out as T;
}

const SQL_VERB_RE =
  /^\s{0,64}(SELECT|INSERT|UPDATE|DELETE|WITH|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|SHOW|CALL|LOCK|COPY)\b/i;

/** Reduces SQL text to a fixed placeholder that keeps only an allow-listed leading verb (`SELECT [Filtered]`). */
export function sqlPlaceholder(sql: unknown): string {
  if (typeof sql !== 'string') return FILTERED;
  const verb = SQL_VERB_RE.exec(sql.slice(0, 128))?.[1];
  return verb ? `${verb.toUpperCase()} ${FILTERED}` : FILTERED;
}

function isDbSpan(
  op: unknown,
  data: Record<string, unknown> | undefined,
): boolean {
  return (
    (typeof op === 'string' && /^db(\.|$)/.test(op)) ||
    !!(
      data &&
      ('db.system' in data || 'db.statement' in data || 'db.query.text' in data)
    )
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Events, spans, breadcrumbs
// ---------------------------------------------------------------------------------------------------------------------

function scrubRequest(event: Event): void {
  const request = event.request;
  if (!request) return;
  delete request.cookies;
  delete request.headers;
  delete request.data;
  delete request.query_string;
  delete request.env;
  if (typeof request.url === 'string')
    request.url = stripUrlQueryAndFragment(request.url);
}

function scrubUser(event: Event): void {
  if (!event.user) return;
  // Only the opaque id survives: no email, username or IP address leaves the process.
  const id = event.user.id;
  event.user = id === undefined ? {} : { id };
}

function scrubCommon(event: Event): void {
  scrubRequest(event);
  scrubUser(event);
  for (const exception of event.exception?.values ?? []) {
    // `type` (the error class), `mechanism` and `stacktrace` (frames) are kept; only the message is free text.
    if (typeof exception.value === 'string')
      exception.value = redactString(exception.value);
  }
  if (typeof event.message === 'string')
    event.message = redactString(event.message);
  if (event.logentry) {
    if (typeof event.logentry.message === 'string')
      event.logentry.message = redactString(event.logentry.message);
    if (event.logentry.params)
      event.logentry.params = scrubData(event.logentry.params);
  }
  if (typeof event.transaction === 'string')
    event.transaction = stripUrlQueryAndFragment(event.transaction);
  if (event.extra) event.extra = scrubData(event.extra);
  if (event.tags) event.tags = scrubData(event.tags);
  // Includes `contexts.trace.data`: a transaction's root span lives there, where `beforeSendSpan` never sees it.
  if (event.contexts) event.contexts = scrubData(event.contexts);
  if (event.breadcrumbs) {
    // `scope.addBreadcrumb` bypasses `beforeBreadcrumb`, so breadcrumbs are scrubbed again on the way out.
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb) =>
      scrubBreadcrumb(breadcrumb),
    );
  }
}

/** `beforeSend`: error and message events. Throws on malformed input — wrap with the fail-closed hook. */
export function scrubErrorEvent<E extends ErrorEvent | Event>(event: E): E {
  scrubCommon(event);
  return event;
}

/** `beforeSendTransaction`: transaction events (`beforeSend` never runs for these). */
export function scrubTransactionEvent<E extends TransactionEvent | Event>(
  event: E,
): E {
  scrubCommon(event);
  if (event.spans) event.spans = event.spans.map((span) => scrubSpan(span));
  return event;
}

/** `beforeSendSpan`: each child span of a transaction. Never drops a span (v8 only warns on `null`). Idempotent. */
export function scrubSpan(span: SpanJSON): SpanJSON {
  const data = span.data as Record<string, unknown> | undefined;
  const db = isDbSpan(span.op, data);
  if (data) span.data = scrubData(data) as SpanJSON['data'];
  if (typeof span.description === 'string') {
    // For a DB span the description *is* the SQL text (Sentry copies `db.statement` into it).
    span.description = db
      ? sqlPlaceholder(span.description)
      : stripUrlQueryAndFragment(span.description);
  }
  return span;
}

/** `beforeBreadcrumb`: outgoing-HTTP, console and manual breadcrumbs. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (typeof breadcrumb.message === 'string')
    breadcrumb.message = redactString(breadcrumb.message);
  if (breadcrumb.data) breadcrumb.data = scrubData(breadcrumb.data); // drops http.query / http.fragment, strips url
  return breadcrumb;
}

/** The fail-closed span: identity and timing only, empty data, filtered description. Never throws. */
function minimalSpan(span: SpanJSON): SpanJSON {
  const pick = <K extends keyof SpanJSON>(key: K): SpanJSON[K] | undefined => {
    try {
      return span[key];
    } catch {
      return undefined;
    }
  };
  return {
    span_id: pick('span_id'),
    trace_id: pick('trace_id'),
    parent_span_id: pick('parent_span_id'),
    start_timestamp: pick('start_timestamp'),
    timestamp: pick('timestamp'),
    op: pick('op'),
    status: pick('status'),
    origin: pick('origin'),
    data: {},
    description: FILTERED,
  } as SpanJSON;
}

// ---------------------------------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------------------------------

/** Strict parse: a plain decimal in [0, 1] — no exponent, hex, sign, blank, NaN or Infinity — else `undefined`. */
export function parseSampleRate(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!/^(?:\d{1,16}(?:\.\d{0,16})?|\.\d{1,16})$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/**
 * `SENTRY_TRACES_SAMPLE_RATE` if valid; otherwise 0.01 in production and 0 everywhere else. `onInvalid` is called
 * (with no argument — the raw value is never echoed) when the variable is set, non-blank and rejected.
 */
export function resolveTracesSampleRate(
  env: SentryEnv,
  onInvalid?: (fallback: number) => void,
): number {
  const fallback =
    env.NODE_ENV === 'production' ? PRODUCTION_DEFAULT_TRACES_SAMPLE_RATE : 0;
  const raw = env.SENTRY_TRACES_SAMPLE_RATE;
  const parsed = parseSampleRate(raw);
  if (parsed !== undefined) return parsed;
  if (onInvalid && typeof raw === 'string' && raw.trim() !== '')
    onInvalid(fallback);
  return fallback;
}

function defaultBootWarning(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(message);
}

/**
 * The `Sentry.init` options for an environment, or `undefined` when `SENTRY_DSN` is unset (Sentry stays off).
 * `overrides` exists for tests (e.g. a capturing `transport`); it can never re-enable PII, change the integrations,
 * the sample rate or replace a scrubber — those keys are applied after it. `warn` receives at most one boot warning
 * (invalid `SENTRY_TRACES_SAMPLE_RATE`), which never contains the configured value.
 */
export function buildSentryOptions(
  env: SentryEnv,
  overrides: Partial<NodeOptions> = {},
  warn: (message: string) => void = defaultBootWarning,
): NodeOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;
  const tracesSampleRate = resolveTracesSampleRate(env, (fallback) =>
    warn(
      `[sentry] SENTRY_TRACES_SAMPLE_RATE is not a decimal between 0 and 1; using the default (${fallback}).`,
    ),
  );
  return {
    environment: env.NODE_ENV ?? 'development',
    ...overrides,
    dsn: overrides.dsn ?? env.SENTRY_DSN,
    tracesSampleRate,
    sendDefaultPii: false,
    includeLocalVariables: false,
    // Merged with the default integrations by name: this replaces the default RequestData integration (which attaches
    // cookies, body, headers incl. Authorization, query string and user email) with one that attaches method + URL
    // only; the scrubbers then strip the URL's query string and fragment.
    integrations: [
      Sentry.requestDataIntegration({
        include: {
          cookies: false,
          data: false,
          headers: false,
          query_string: false,
          ip: false,
          user: false,
          url: true,
        },
      }),
    ],
    // The AI Phase 1 rule (no body, query string or cookies on /rest/v1/(admin/)ai/ routes) is a subset of this.
    // Every hook fails closed (see the file header for why a throwing beforeSend would leak).
    beforeSend: (event) => {
      try {
        return scrubErrorEvent(event);
      } catch {
        return null;
      }
    },
    beforeSendTransaction: (event) => {
      try {
        return scrubTransactionEvent(event);
      } catch {
        return null;
      }
    },
    beforeSendSpan: (span) => {
      try {
        return scrubSpan(span);
      } catch {
        return minimalSpan(span);
      }
    },
    beforeBreadcrumb: (breadcrumb) => {
      try {
        return scrubBreadcrumb(breadcrumb);
      } catch {
        return null;
      }
    },
  };
}

const sentryOptions = buildSentryOptions(process.env);
if (sentryOptions) {
  Sentry.init(sentryOptions);
}
