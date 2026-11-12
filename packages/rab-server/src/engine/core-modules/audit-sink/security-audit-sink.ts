import { appendFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/**
 * EXTERNAL AUDIT SINK (M0 §3.4 / §6.4 control 5; catalogue BC-07). With one owner login, `core.audit_log` insert-only can
 * no longer be enforced in the database: the login can re-grant itself UPDATE / DELETE / TRUNCATE and rewrite the trail
 * (G-05, owner-accepted). Security-relevant events are therefore ALSO written to a sink OUTSIDE the database that the
 * database login cannot reach — BEST EFFORT since Phase X Part 2 X1.1 (owner decision 2026-11-12, Twenty's event-log
 * model): the security audit rows are queued AFTER their transaction commits (audit-events/audit-event-queue.service.ts)
 * and the Worker writes them here with BullMQ retries; an event can be lost when Redis or the sink fails beyond the
 * retries, and an owner-login holder can alter a row before it is shipped. Nothing blocks or rolls back an action. This
 * module is the interface, the structured + redacted event shape, the configuration rules and two development adapters.
 * It creates no external service and holds no credential: the production adapter (a log shipper / append-only bucket /
 * SIEM endpoint) is a DEPLOYMENT DEPENDENCY.
 *
 * Configuration (validated at startup by `securityAuditSinkConfig`; fail closed):
 *   CREWFLOW_AUDIT_SINK          none | stdout | file      (unset = none)
 *   CREWFLOW_AUDIT_SINK_FILE     absolute path, required for `file`
 *   CREWFLOW_AUDIT_SINK_FAILURE  refuse | log              (unset = refuse in production, log elsewhere)
 *   Production (NODE_ENV=production or RAB_RUNTIME_ENV=production) REQUIRES a sink: `none` / unset refuses to start (M0
 *   §6.4: "external append-only sink ON" is mandatory for production under the owner login).
 *   `stdout` is acceptable in production only when the platform ships container stdout off the host to append-only
 *   storage (the deployment dependency); `file` is for development and tests (a local file the same host can edit is NOT
 *   tamper-evident).
 *
 * Failure behaviour (documented, tested):
 *   - `refuse`: an emit that fails throws `AuditSinkError`. The callers are the Worker's audit-event delivery job (the throw
 *     fails the JOB, and BullMQ retries it — never the action, which committed before the job existed), the API's
 *     detached pre-auth login-failure emit (caught and logged) and the posture-drift monitor;
 *   - `log`: the failure is written to stderr once per event and the caller continues (development only by default; a
 *     delivery job then completes without a retry).
 *
 * Redaction (always, before anything leaves the process): keys that look like secrets, compared after normalising the
 * name (`-` and spaces to `_`, lower case: password, pwd, secret, token, hash, totp, recovery, cookie, authorization, api /
 * private / access / signing / encryption keys, jwt, bearer, session ids, pin, backup / SMS / named one-time codes, dsn,
 * connection strings, database URLs; a bare `code` only when it holds one-time-code digits) are replaced by "[REDACTED]";
 * values are limited to strings, numbers, booleans and null; a string over 2,048 characters becomes "[too-long]" (never
 * cut, then shipped), the rest are cut at 256 characters, one event ships at most ~16 KB of strings ("[truncated]" after),
 * nesting at depth 3, at most 50 keys; inside strings, e-mail-like tokens are masked (`a***@example.com`, Unicode aware),
 * postgres:// URLs, secret `name=value` pairs (linear scan, same names plus `code`), Bearer / Basic credentials and JWTs
 * are replaced. The event carries ids, types and counts — never row data.
 */
export type AuditSinkMode = 'none' | 'stdout' | 'file';
export type AuditSinkFailurePolicy = 'refuse' | 'log';

export interface SecurityAuditEvent {
  /** Dotted event type, e.g. `security.posture.drift`, `auth.login.failed`, `admin.role.granted`. */
  type: string;
  severity: 'info' | 'warning' | 'critical';
  /** The emitting process label (api, worker, cli:<command>). */
  process: string;
  /** Pseudonymous identifiers only (uuids); never e-mail, name or token. */
  organisationId?: string | null;
  actorUserId?: string | null;
  detail?: Record<string, unknown>;
}

export interface SecurityAuditSink {
  readonly mode: AuditSinkMode;
  emit(event: SecurityAuditEvent): Promise<void>;
}

export class AuditSinkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditSinkConfigError';
  }
}

export class AuditSinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditSinkError';
  }
}

export interface AuditSinkConfig {
  mode: AuditSinkMode;
  file: string | null;
  failure: AuditSinkFailurePolicy;
  production: boolean;
}

const isProduction = (env: Record<string, string | undefined>) => env.NODE_ENV === 'production' || env.RAB_RUNTIME_ENV?.trim() === 'production';

/** Validates the sink configuration. Throws AuditSinkConfigError (names variables, never values beyond the mode). */
export function securityAuditSinkConfig(env: Record<string, string | undefined> = process.env): AuditSinkConfig {
  const production = isProduction(env);
  const rawMode = env.CREWFLOW_AUDIT_SINK;
  const mode = rawMode === undefined || rawMode === '' ? 'none' : rawMode;
  if (mode !== 'none' && mode !== 'stdout' && mode !== 'file') throw new AuditSinkConfigError('CREWFLOW_AUDIT_SINK must be exactly none, stdout or file.');
  if (production && mode === 'none') {
    throw new AuditSinkConfigError(
      'production requires an external security audit sink under the owner login (CREWFLOW_AUDIT_SINK=stdout with an off-host append-only log shipper, or a reviewed adapter): core.audit_log alone is not tamper-evident (BC-07).',
    );
  }
  if (production && mode === 'file') throw new AuditSinkConfigError('CREWFLOW_AUDIT_SINK=file is for development only: a local file is not an external append-only sink.');
  const file = env.CREWFLOW_AUDIT_SINK_FILE?.trim() || null;
  if (mode === 'file' && (!file || !isAbsolute(file))) throw new AuditSinkConfigError('CREWFLOW_AUDIT_SINK=file needs CREWFLOW_AUDIT_SINK_FILE, an absolute path.');
  if (mode !== 'file' && file) throw new AuditSinkConfigError('CREWFLOW_AUDIT_SINK_FILE is set but CREWFLOW_AUDIT_SINK is not file.');
  const rawFailure = env.CREWFLOW_AUDIT_SINK_FAILURE;
  const failure = rawFailure === undefined || rawFailure === '' ? (production ? 'refuse' : 'log') : rawFailure;
  if (failure !== 'refuse' && failure !== 'log') throw new AuditSinkConfigError('CREWFLOW_AUDIT_SINK_FAILURE must be exactly refuse or log.');
  if (production && failure === 'log') throw new AuditSinkConfigError('production requires CREWFLOW_AUDIT_SINK_FAILURE=refuse (a security event that cannot be recorded must fail closed).');
  return { mode, file, failure, production };
}

/**
 * Keys whose VALUE is never shipped, tested against the NORMALISED key (`-` and spaces → `_`, lower case), so `x-api-key`,
 * `private-key`, `accessKey` and `Access Key` all match. X1.1 review (defence in depth) added private / access / signing /
 * encryption keys, JWTs, bearer values, sessions, PINs, backup and SMS codes, connection strings and named one-time codes.
 * A bare `code` key stays: in today's metadata it is an ERROR code (report.integrity_failed, shift statements, e-mail
 * attachments); it is redacted only when its value looks like a one-time code (isOneTimeCodeValue).
 */
const SECRET_KEY =
  /pass(word)?|pwd|secret|token|hash|totp|recovery|cookie|authori[sz]ation|api_?key|^key$|private_?key|access_?key|signing_?key|encryption_?key|credential|signature|^sig$|otp|jwt|bearer|^session$|session_?id|^sid$|^pin$|backup_?codes?|sms_?code|^codes$|^dsn$|connection_?string|database_?url|(mfa|otp|totp|verification|auth|security|one_?time|second_?factor|reset)_?code/;
const OTP_CODE_KEY = 'code';

/** `-` and whitespace runs become `_`, then lower case. Linear. */
const normaliseKey = (key: string): string => key.replace(/[-\s]+/g, '_').toLowerCase();
const isSecretKeyName = (key: string): boolean => SECRET_KEY.test(normaliseKey(key));

/** 4–10 digits once spaces and dashes are removed (`123456`, `123 456`, `123-456`). Plain string operations. */
function isOneTimeCodeValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && isOneTimeCodeValue(String(value));
  if (typeof value !== 'string' || value.length > 32) return false;
  const digits = value.replace(/[\s-]/g, '');
  return /^\d{4,10}$/.test(digits);
}

/**
 * E-mail-like tokens: every whitespace-free token that contains `@` is masked (maskEmailToken). Unicode-aware
 * (IDN domains, apostrophes, accented local parts): `jöhn@exämple.com` → `j***@exämple.com`, `o'brien@x.ie` → `o***@x.ie`.
 * Deliberately broad: over-masking (a URL with credentials, an @handle) is acceptable, an unmasked address is not.
 */
const TOKEN = /\S+/gu;

/**
 * Masks one whitespace-free token: everything before its first `@` is kept only as its first code point; the rest after
 * the @-run is masked again if it holds another `@`. A token starting with `@` (a handle) is kept. Linear: each token is
 * scanned a bounded number of times (once per `@`), and TOKEN itself never backtracks.
 */
function maskEmailToken(token: string): string {
  const at = token.indexOf('@');
  if (at <= 0) return token;
  let rest = at;
  while (rest < token.length && token[rest] === '@') rest++;
  const domain = token.slice(rest);
  return `${Array.from(token.slice(0, at))[0]}***@${domain.includes('@') ? maskEmailToken(domain) : domain}`;
}
const PG_URL = /postgres(?:ql)?:\/\/\S+/gi;
const BEARER = /\bbearer\s+[^\s,;]+/gi;
const BASIC = /\bbasic\s+[A-Za-z0-9+/=._-]+/gi;
const JWT = /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g;

/** Longer strings are never shipped at all (a cut JWT head or payload could still leak); see redactString. */
const MAX_REDACT_INPUT = 2_048;
/** Total string characters one event may ship; values after the budget is spent become `[truncated]`. */
const EVENT_STRING_BUDGET = 16_384;

const isNameChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 /* _ */ || c === 45 /* - */ || c === 46; /* . */
const isValueStop = (ch: string): boolean => ch === '&' || ch === '#' || ch === ';' || ch === ',' || ch === '"' || ch === "'" || ch === '<' || ch === '>' || /\s/.test(ch);

/**
 * `name=value` pairs anywhere in a string (URL query or fragment, `k=v` logs, a leading `token=` with no delimiter): the
 * value is replaced when the NAME is secret by the same normalised key pattern, or is exactly `code` (an OAuth / reset
 * code). Linear: one forward pass over the `=` signs; each backward name scan stops at the previous pair or `=`.
 */
function redactNameValuePairs(value: string): string {
  let out = '';
  let last = 0;
  let i = value.indexOf('=');
  while (i !== -1) {
    let start = i;
    while (start > last && isNameChar(value.charCodeAt(start - 1))) start--;
    let next = i + 1;
    if (start < i) {
      const name = value.slice(start, i);
      if (isSecretKeyName(name) || normaliseKey(name) === OTP_CODE_KEY) {
        let end = i + 1;
        while (end < value.length && !isValueStop(value[end]!)) end++;
        out += `${value.slice(last, i + 1)}[REDACTED]`;
        last = end;
        next = end;
      }
    }
    i = value.indexOf('=', next);
  }
  return out + value.slice(last);
}

/** The string redaction every shipped value goes through (exported for its unit test). */
export function redactString(value: string): string {
  if (value.length > MAX_REDACT_INPUT) return '[too-long]';
  return redactNameValuePairs(value.replace(PG_URL, '[url]'))
    .replace(BEARER, '[bearer]')
    .replace(BASIC, '[basic]')
    .replace(JWT, '[jwt]')
    .replace(TOKEN, (token) => (token.includes('@') ? maskEmailToken(token) : token))
    .slice(0, 256);
}

interface Budget {
  left: number;
}

function redactValue(value: unknown, depth: number, budget: Budget): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (budget.left <= 0) return '[truncated]';
    const out = redactString(value);
    budget.left -= out.length;
    return out;
  }
  if (Array.isArray(value)) return depth >= 3 ? '[depth]' : value.slice(0, 50).map((v) => redactValue(v, depth + 1, budget));
  if (typeof value === 'object') return depth >= 3 ? '[depth]' : redactObject(value as Record<string, unknown>, depth + 1, budget);
  return '[unsupported]';
}

const isSecretEntry = (key: string, value: unknown): boolean =>
  isSecretKeyName(key) ||
  (normaliseKey(key) === OTP_CODE_KEY && (isOneTimeCodeValue(value) || (Array.isArray(value) && value.length > 0 && value.every(isOneTimeCodeValue))));

function redactObject(input: Record<string, unknown>, depth: number, budget: Budget = { left: EVENT_STRING_BUDGET }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input).slice(0, 50)) out[key] = isSecretEntry(key, input[key]) ? '[REDACTED]' : redactValue(input[key], depth, budget);
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,5}$/;

/** The exact JSON line a sink writes. Exported for its unit test. */
export function formatSecurityAuditEvent(event: SecurityAuditEvent, at: Date = new Date()): string {
  if (!EVENT_TYPE.test(event.type)) throw new AuditSinkError('audit event type must be a lowercase dotted name');
  const id = (v: string | null | undefined) => (v && UUID.test(v) ? v.toLowerCase() : null);
  return JSON.stringify({
    v: 1,
    at: at.toISOString(),
    type: event.type,
    severity: event.severity,
    process: String(event.process).slice(0, 64),
    organisationId: id(event.organisationId),
    actorUserId: id(event.actorUserId),
    detail: event.detail ? redactObject(event.detail, 1) : {},
  });
}

class FailurePolicySink implements SecurityAuditSink {
  constructor(
    readonly mode: AuditSinkMode,
    private readonly write: (line: string) => Promise<void>,
    private readonly failure: AuditSinkFailurePolicy,
    private readonly log: (line: string) => void,
  ) {}

  async emit(event: SecurityAuditEvent): Promise<void> {
    const line = formatSecurityAuditEvent(event);
    try {
      await this.write(line);
    } catch (error) {
      const code = (error as { code?: string })?.code ?? 'unknown';
      if (this.failure === 'refuse') throw new AuditSinkError(`the security audit sink (${this.mode}) could not record ${event.type} (code ${code}); the operation must not be reported as done`);
      this.log(`[audit-sink] could not record ${event.type} (code ${code}); continuing (CREWFLOW_AUDIT_SINK_FAILURE=log)`);
    }
  }
}

/** A sink that records nothing: allowed only outside production (securityAuditSinkConfig refuses it there). */
class NoSink implements SecurityAuditSink {
  readonly mode = 'none' as const;
  async emit(event: SecurityAuditEvent): Promise<void> {
    formatSecurityAuditEvent(event); // still validates the event shape
  }
}

export function createSecurityAuditSink(
  config: AuditSinkConfig,
  deps: { stdout?: (line: string) => Promise<void>; appendFile?: (path: string, line: string) => Promise<void>; log?: (line: string) => void } = {},
): SecurityAuditSink {
  const log = deps.log ?? ((line: string) => console.error(line)); // eslint-disable-line no-console
  if (config.mode === 'none') return new NoSink();
  if (config.mode === 'stdout') {
    const out = deps.stdout ?? ((line: string) => new Promise<void>((resolve, reject) => process.stdout.write(`${line}\n`, (e) => (e ? reject(e) : resolve()))));
    return new FailurePolicySink('stdout', (line) => out(`CREWFLOW_SECURITY_AUDIT ${line}`), config.failure, log);
  }
  const append = deps.appendFile ?? ((path: string, line: string) => appendFile(path, `${line}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' }));
  return new FailurePolicySink('file', (line) => append(config.file!, line), config.failure, log);
}
