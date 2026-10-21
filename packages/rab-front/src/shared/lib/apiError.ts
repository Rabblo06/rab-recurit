import axios from 'axios';

/**
 * The ONE place a failed API call becomes user-facing text. Ownership is single:
 *  - `shared/api.ts` (axios client) handles transport concerns (401 refresh / redirect) and never shows feedback;
 *  - this module turns any error into a safe message plus the server's machine-readable `code`;
 *  - the caller decides whether and how to show it (usually `toast.error(getApiErrorMessage(e, 'Could not …'))`);
 *  - `shell/ToastHost` renders it.
 *
 * The server's exception filter (`rab-server` `AllExceptionsFilter`) already replaces unexpected errors with a
 * generic 500, and `HttpException` messages are written to be client-safe. This module still refuses anything that
 * looks technical (SQL, stack frames, file paths, tokens, ids, framework defaults, class-validator property errors)
 * and falls back to the status message below, so a server regression can never surface internals in the UI.
 */

export type ApiErrorKind =
  | 'offline'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'validation'
  | 'server'
  | 'unknown';

export const API_ERROR_MESSAGES: Record<ApiErrorKind, string> = {
  offline: 'Connection lost. Check your internet connection.',
  timeout: 'The request took too long. Please try again.',
  unauthorized: 'Your session has expired. Please sign in again.',
  forbidden: "You don't have permission to perform this action.",
  not_found: 'The requested item could not be found.',
  conflict: 'This record has changed. Refresh and try again.',
  payload_too_large: 'This file is too large. Choose a smaller file and try again.',
  rate_limited: 'Too many requests. Please try again shortly.',
  validation: 'Please check the details and try again.',
  server: 'Something went wrong. Please try again.',
  unknown: 'Something went wrong. Please try again.',
};

export interface NormalizedApiError {
  kind: ApiErrorKind;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  /** The server's machine-readable `code` (e.g. `EMAIL_UNAVAILABLE`), preserved for callers that branch on it. */
  code: string | null;
  /** Safe, user-facing text. Always set. */
  message: string;
  /** The server's own message when it passed the safety check, else null. */
  serverMessage: string | null;
  /** Worth offering a retry (network, timeout, 429, 5xx). */
  retryable: boolean;
}

export interface ApiErrorOptions {
  /** Used for 400/422 without a safe server message, other 4xx, and non-HTTP errors. */
  fallback?: string;
  /** Per-kind replacements, e.g. `{ payload_too_large: 'Photos must be 5 MB or smaller.' }`. */
  messages?: Partial<Record<ApiErrorKind, string>>;
}

/** Nest/Express/Multer defaults and other framework text: correct but useless (or revealing) to a user. */
const FRAMEWORK_DEFAULTS =
  /^(internal server error|forbidden( resource)?|unauthori[sz]ed|not found\.?|bad request( exception)?|conflict|too many requests|payload too large|file too large|request entity too large|unprocessable entity|service unavailable|bad gateway|gateway timeout|http exception|throttlerexception.*|cannot (get|post|put|patch|delete) .*|invalid transition.*|stale response.*|network error|request failed with status code \d+|timeout of \d+ms exceeded)$/i;

const TECHNICAL_PATTERNS: RegExp[] = [
  /\bselect\b[\s\S]{0,200}\bfrom\b[\s\S]{0,120}\b(where|join|limit)\b|\binsert into\b|\bdelete from\b|\bupdate\s+"?\w+"?\s+set\b/i, // SQL
  /\b(relation|column|constraint|schema|table) "[^"]*"/i,
  /\b(violates|duplicate key|syntax error|deadlock|sqlstate|queryfailederror|entitynotfound\w*|typeorm|postgres(ql)?)\b|\bpg_\w+/i,
  /\bat [\w$.<>]+ \(|\n\s+at /, // stack frames
  /\b\w+\.(ts|tsx|js|mjs|cjs):\d+/i, // file:line
  /[a-z]:\\|(^|[\s(])\/(src|app|usr|var|home|opt|tmp|node_modules|dist)\//i, // file paths
  /node_modules|webpack|__dirname/i,
  /\beyJ[\w-]{8,}\.[\w-]+/, // JWT
  /\bbearer\s+\S+/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // uuid / internal id
  /\b[0-9a-f]{24,}\b/i, // hashes, object ids
  /\bworkspace_[0-9a-f]{8,}\b|\b(rab|crewflow)_(app|owner)\b/i, // schema / role names
  /\b(ECONN\w+|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ERR_[A-Z_]+)\b/,
  /^\s*[\w.]*(error|exception)\b\s*:/i, // "TypeError: …", "QueryFailedError: …"
  /\b(undefined|null|NaN)\b|\[object \w+\]/,
  /<\/?[a-z][\s\S]*>/i, // HTML error pages
];

/** class-validator's default property messages: "email must be an email", "property organisationId should not exist". */
const VALIDATOR_DEFAULT = /^(property \w+ should not exist|[a-z][\w.]*(\.\d+)?\s+(must|should|is not|has to|has failed)\b)/;

/** True when a server message is plain user-facing text that is safe to show as-is. */
export function isSafeServerMessage(message: unknown): message is string {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (text.length < 3 || text.length > 300) return false;
  if (FRAMEWORK_DEFAULTS.test(text) || VALIDATOR_DEFAULT.test(text)) return false;
  return !TECHNICAL_PATTERNS.some((p) => p.test(text));
}

function pickServerMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const raw = (data as { message?: unknown }).message;
  // class-validator sends an array: keep the safe, human-written entries (max 3) and drop property-name defaults.
  const candidates = Array.isArray(raw) ? raw : [raw];
  const safe = candidates.filter(isSafeServerMessage).map((m) => m.trim()).slice(0, 3);
  return safe.length ? safe.join(' ') : null;
}

function pickCode(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : null;
}

function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  if (status === 400 || status === 422) return 'validation';
  return 'unknown';
}

/**
 * Kinds whose server message is preferred when it is safe: a domain rule the user can act on ("This subdomain is
 * taken.", "You cannot approve your own hours.", "Too many invitations have been sent recently…"). Framework defaults
 * ("Forbidden resource", "ThrottlerException: Too Many Requests") fail the safety check and get the fixed text.
 * 401/404/413/5xx always use the fixed text: a 404 body must not hint at what exists, and the others carry nothing a
 * user needs.
 */
const PREFER_SERVER: ReadonlySet<ApiErrorKind> = new Set(['validation', 'conflict', 'forbidden', 'rate_limited', 'unknown']);

interface HttpLikeError {
  axios: boolean;
  code?: string;
  response?: { status?: number; data?: unknown };
}

/** An axios error, or any object carrying an axios-shaped `response` (re-thrown errors, test doubles). */
function asHttpError(error: unknown): HttpLikeError | null {
  if (axios.isAxiosError(error)) return { axios: true, code: error.code, response: error.response };
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === 'object') return { axios: false, response: response as HttpLikeError['response'] };
  }
  return null;
}

export function normalizeApiError(error: unknown, options: ApiErrorOptions | string = {}): NormalizedApiError {
  const opts: ApiErrorOptions = typeof options === 'string' ? { fallback: options } : options;
  const text = (kind: ApiErrorKind, preferFallback = false) =>
    opts.messages?.[kind] ?? (preferFallback && opts.fallback ? opts.fallback : API_ERROR_MESSAGES[kind]);
  const unknownError: NormalizedApiError = { kind: 'unknown', status: null, code: null, message: text('unknown', true), serverMessage: null, retryable: false };

  const http = asHttpError(error);
  if (!http) return unknownError;

  const response = http.response;
  if (!response) {
    if (http.code === 'ERR_CANCELED') return unknownError;
    let kind: ApiErrorKind = http.code === 'ECONNABORTED' || http.code === 'ETIMEDOUT' ? 'timeout' : 'offline';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) kind = 'offline';
    return { kind, status: null, code: null, message: text(kind), serverMessage: null, retryable: true };
  }

  const status = typeof response.status === 'number' ? response.status : null;
  const rawMessage = (response.data as { message?: unknown } | undefined)?.message;
  // Multer reports an oversized upload as a 400 "File too large"; treat it as the 413 it means.
  const kind: ApiErrorKind =
    typeof rawMessage === 'string' && /^(file too large|request entity too large)$/i.test(rawMessage.trim())
      ? 'payload_too_large'
      : status === null
        ? 'unknown'
        : kindForStatus(status);
  const serverMessage = PREFER_SERVER.has(kind) ? pickServerMessage(response.data) : null;
  const code = pickCode(response.data);
  const retryable = kind === 'rate_limited' || kind === 'server' || kind === 'timeout';
  const message = opts.messages?.[kind] ?? serverMessage ?? text(kind, kind === 'validation' || kind === 'unknown');
  return { kind, status, code, message, serverMessage, retryable };
}

/** Shorthand for the common case: `toast.error(getApiErrorMessage(e, 'Could not save the workspace.'))`. */
export function getApiErrorMessage(error: unknown, options?: ApiErrorOptions | string): string {
  return normalizeApiError(error, options).message;
}

/** The server's machine-readable error `code`, or null. */
export function getApiErrorCode(error: unknown): string | null {
  return pickCode(asHttpError(error)?.response?.data);
}

/** The HTTP status, or null when no response arrived. */
export function getApiErrorStatus(error: unknown): number | null {
  const status = asHttpError(error)?.response?.status;
  return typeof status === 'number' ? status : null;
}
