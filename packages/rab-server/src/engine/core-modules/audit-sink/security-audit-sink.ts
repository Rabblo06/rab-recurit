import { appendFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/**
 * EXTERNAL AUDIT SINK (M0 §3.4 / §6.4 control 5; catalogue BC-07). With one owner login, `core.audit_log` insert-only can
 * no longer be enforced in the database: the login can re-grant itself UPDATE / DELETE / TRUNCATE and rewrite the trail
 * (G-05, owner-accepted). Security-relevant events are therefore ALSO written, at the moment they happen, to a sink
 * OUTSIDE the database that the database login cannot reach. This module is the interface, the structured + redacted
 * event shape, the configuration rules and two development adapters. It creates no external service and holds no
 * credential: the production adapter (a log shipper / append-only bucket / SIEM endpoint) is a DEPLOYMENT DEPENDENCY.
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
 *   - `refuse`: an emit that fails throws `AuditSinkError`; the caller (a security-relevant operation) must fail closed —
 *     the operation is not reported as done when its external record could not be written;
 *   - `log`: the failure is written to stderr once per event and the caller continues (development only by default).
 *
 * Redaction (always, before anything leaves the process): keys that look like secrets (password, secret, token, hash,
 * totp, recovery, cookie, authorization, apiKey, key) are replaced by "[REDACTED]"; values are limited to strings,
 * numbers, booleans and null, strings cut at 256 characters, nesting at depth 3, at most 50 keys; e-mail addresses in
 * strings are masked (`a***@example.com`); a postgres:// URL is replaced. The event carries ids, types and counts —
 * never row data.
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

const SECRET_KEY = /pass(word)?|secret|token|hash|totp|recovery|cookie|authori[sz]ation|api_?key|^key$|credential|signature|otp/i;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const PG_URL = /postgres(?:ql)?:\/\/\S+/gi;

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.replace(PG_URL, '[url]').replace(EMAIL, '$1***@$2').slice(0, 256);
  if (Array.isArray(value)) return depth >= 3 ? '[depth]' : value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') return depth >= 3 ? '[depth]' : redactObject(value as Record<string, unknown>, depth + 1);
  return '[unsupported]';
}

function redactObject(input: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input).slice(0, 50)) out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(input[key], depth);
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
