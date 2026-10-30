/**
 * Phase B (B1/B2): the URL parameter policy for every PostgreSQL connection string this codebase accepts.
 *
 * Why a policy at all: pg 8.23 merges the parsed connection string LAST (`pg/lib/connection-parameters.js:55-61`), and
 * `pg-connection-string` turns every query parameter into a config key (`index.js:40-64`). So a URL can silently override
 * the host, port, user or database the rest of the string names (`?host=other`), replace any code-built `ssl` object
 * (`?sslmode=…`, `?sslrootcert=…`), or inject session settings (`?options=-c role=…`). The factory therefore never hands a
 * raw URL to the driver. This module validates the URL once, extracts the target (host, port, user, password, database)
 * with the SAME parser pg uses, and returns explicit values; `pg-tls.ts` builds the `ssl` object from configuration only.
 *
 * Allowed query parameters (anything else is refused, fail closed):
 *   sslmode            a DECLARATION only, mapped by pg-tls.ts (never passed to pg)
 *   application_name   kept as the connection's application_name
 *   channel_binding    require/prefer → pg `enableChannelBinding` (pg uses SCRAM-SHA-256-PLUS when the server offers it;
 *                      pg 8 cannot REQUIRE it — TLS verify-full is what authenticates the server); disable → off
 *   options            ONLY a Neon `endpoint=<id>` / `project=<id>` token naming the same endpoint as the host; or, for the
 *                      MIGRATE process against a local/test target only (`allowSessionRole`), exactly `-c role=<identifier>`
 *                      — the M2 restricted-migrator harness's phase-A identity (migration-security-check.ts). Refused for
 *                      every other process and in production; every other `-c` setting is always refused
 *   connect_timeout, keepalives, keepalives_idle, keepalives_interval, keepalives_count
 *                      accepted as provider boilerplate and ignored (pg reads none of them from a URL; the factory's
 *                      explicit connect timeout and keep-alive settings govern)
 *   target_session_attrs  only `any` (pg 8 does not implement it; any other value would be silently unenforced)
 *
 * Refused because they override the target or security: host, hostaddr, port, user, dbname, database, password,
 * passfile, service, every ssl* parameter except sslmode (sslrootcert, sslcert, sslkey, sslcrl, sslpassword, sslsni, ssl,
 * sslnegotiation), uselibpqcompat, and `options` carrying anything but the Neon endpoint token (`-c role=…`,
 * `-c search_path=…`, …). A Supabase pooler user (`postgres.<project-ref>`) lives in the userinfo, not the query, so it
 * is an ordinary user name here.
 *
 * Messages name the variable and the parameter only — never the URL, the user, the password or a parameter value.
 */
import * as path from 'path';

interface PgConnectionStringConfig {
  host?: string | null;
  port?: string | number | null;
  user?: string | null;
  password?: string | null;
  database?: string | null;
}

/**
 * The `pg-connection-string` that the installed `pg` itself requires (resolved from pg's own directory), so this policy
 * parses exactly as the driver would. It is a dependency of `pg`, not of this package, hence the explicit resolution.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pgConnectionString = require(require.resolve('pg-connection-string', { paths: [path.dirname(require.resolve('pg'))] })) as {
  parse: (value: string) => PgConnectionStringConfig;
};
const parsePgConnectionString = (value: string): PgConnectionStringConfig => pgConnectionString.parse(value);

export class PgConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgConfigError';
  }
}

export type PgSslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full' | 'no-verify';
const SSL_MODES: ReadonlySet<string> = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify']);

/** Parameters accepted as harmless provider boilerplate; pg ignores them when they arrive through a URL. */
const IGNORED_BENIGN_PARAMS: ReadonlySet<string> = new Set(['connect_timeout', 'keepalives', 'keepalives_idle', 'keepalives_interval', 'keepalives_count']);
const ALLOWED_PARAMS: ReadonlySet<string> = new Set([...IGNORED_BENIGN_PARAMS, 'sslmode', 'application_name', 'channel_binding', 'options', 'target_session_attrs']);
/** Named explicitly so the refusal says WHY (target or security override), not merely "unknown". */
const TARGET_OVERRIDE_PARAMS: ReadonlySet<string> = new Set(['host', 'hostaddr', 'port', 'user', 'dbname', 'database', 'password', 'passfile', 'service']);

export interface TransactionPoolerShape {
  /** neon | supabase | digitalocean | rds-proxy */
  provider: string;
  /** Plain-English reason, safe to log (no host). */
  reason: string;
}

/** The validated target of one connection string. `password` is non-enumerable so a stray JSON.stringify never prints it. */
export interface PgTarget {
  /** Variable the URL came from, e.g. PG_DATABASE_URL. */
  label: string;
  host: string;
  port: number;
  user: string;
  readonly password: string;
  database: string;
  sslmode: PgSslMode | null;
  applicationName: string | null;
  channelBinding: boolean;
  /** Neon `endpoint=<id>` token from `options`, merged into the startup options by the factory. */
  providerOptions: string | null;
  /** `-c role=<identifier>` from `options` (migrate process, local/test target only), merged into the startup options. */
  sessionRoleOption: string | null;
  /**
   * Security review N-1: the Neon endpoint id the connection string ROUTES to besides its host name — an `options`
   * `endpoint=<id>` token or Neon password routing (`endpoint=<id>$<password>`). Always equal to the host's own endpoint
   * (anything else is refused); kept so the unmarked-production deny list checks it explicitly too. Lower-case; null when
   * neither is used.
   */
  routedNeonEndpoint?: string | null;
  /** A documented transaction-pooler URL shape (session advisory locks unsafe), or null. */
  transactionPooler: TransactionPoolerShape | null;
  /** Heuristic only (e.g. PgBouncer's default port 6432): warn, never refuse. */
  poolerSuspicion: string | null;
  /** user + host + port + database. For equality checks only; never log it (it carries the user name). */
  canonicalKey: string;
  /** host:port/database — safe to log (the existing guards already log host and database). */
  display: string;
}

const NEON_SUFFIX = '.neon.tech';

/** Documented transaction-pooler URL shapes. Each entry says how sure the shape is. */
export function detectTransactionPooler(host: string, port: number): TransactionPoolerShape | null {
  const h = host.toLowerCase();
  const firstLabel = h.split('.')[0] ?? h;
  // Neon: the pooled hostname inserts `-pooler` after the endpoint id; Neon's pooler is PgBouncer in transaction mode.
  if (h.endsWith(NEON_SUFFIX) && firstLabel.endsWith('-pooler')) {
    return { provider: 'neon', reason: 'Neon pooled host (-pooler): PgBouncer in transaction mode' };
  }
  // Supabase (Supavisor): port 6543 is the transaction-mode pooler; 5432 on the same host is session mode (allowed).
  if (h.endsWith('.pooler.supabase.com') && port === 6543) {
    return { provider: 'supabase', reason: 'Supabase pooler on port 6543: transaction mode' };
  }
  // DigitalOcean managed PostgreSQL: the direct port is 25060; connection pools (PgBouncer) are served on 25061. A DO pool
  // can be configured as transaction, session or statement mode and the URL does not say which, so every pool URL is
  // refused for session locks (the session probe is the real check for anything that passes this list).
  if (h.endsWith('.ondigitalocean.com') && port === 25061) {
    return { provider: 'digitalocean', reason: 'DigitalOcean connection pool port 25061 (PgBouncer; pool mode not visible in the URL)' };
  }
  // AWS RDS Proxy: `<name>.proxy-<id>.<region>.rds.amazonaws.com`. Session state pins the client, but AWS documents
  // pinning as best effort, so it is treated as unsafe for session advisory locks.
  if (/\.proxy-[a-z0-9]+\.[a-z0-9-]+\.rds\.amazonaws\.com$/.test(h)) {
    return { provider: 'rds-proxy', reason: 'AWS RDS Proxy endpoint' };
  }
  return null;
}

function poolerSuspicionOf(port: number): string | null {
  return port === 6432 ? 'port 6432 is PgBouncer\'s default port' : null;
}

export interface ParsePgUrlOptions {
  /** Accept `options=-c role=<identifier>` (only the migrate process against a local/test target; see the header). */
  allowSessionRole?: boolean;
}

/** Validates a connection string and returns its explicit target. Throws PgConfigError; never echoes the value. */
export function parsePgUrl(raw: string, label: string, parseOptions: ParsePgUrlOptions = {}): PgTarget {
  const value = raw.trim();
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    throw new PgConfigError(`${label} must be a postgres:// or postgresql:// URL (value not shown).`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PgConfigError(`${label} is not a parseable postgres URL (value not shown).`);
  }

  const counts = new Map<string, number>();
  for (const key of url.searchParams.keys()) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const [key, count] of counts) {
    if (count > 1) throw new PgConfigError(`${label} repeats the query parameter "${key}". Refusing an ambiguous connection string.`);
    if (TARGET_OVERRIDE_PARAMS.has(key)) {
      throw new PgConfigError(
        `${label} sets "${key}" as a query parameter, which would override the connection target named in the URL. Put the host, port, user, password and database in the URL itself. Refusing.`,
      );
    }
    if ((key.startsWith('ssl') && key !== 'sslmode') || key === 'uselibpqcompat') {
      throw new PgConfigError(
        `${label} sets "${key}", which would override the TLS settings. TLS is configured only through sslmode (a declaration) and PG_SSL_CA_CERT_PATH / PG_SSL_ALLOW_SELF_SIGNED. Refusing.`,
      );
    }
    if (!ALLOWED_PARAMS.has(key)) {
      throw new PgConfigError(`${label} sets the unsupported query parameter "${key}". Only ${[...ALLOWED_PARAMS].sort().join(', ')} are accepted. Refusing.`);
    }
  }

  const params = url.searchParams;
  const sslmodeRaw = params.get('sslmode');
  if (sslmodeRaw !== null && !SSL_MODES.has(sslmodeRaw)) {
    throw new PgConfigError(`${label} has an unrecognised sslmode. Use verify-full (or require), or disable outside production.`);
  }
  const applicationName = params.get('application_name');
  if (applicationName !== null && !/^[\x20-\x7e]{1,63}$/.test(applicationName)) {
    throw new PgConfigError(`${label} has an application_name that is empty, longer than 63 characters or not printable ASCII.`);
  }
  const channelBindingRaw = params.get('channel_binding');
  if (channelBindingRaw !== null && !['require', 'prefer', 'disable'].includes(channelBindingRaw)) {
    throw new PgConfigError(`${label} has an unrecognised channel_binding. Use require, prefer or disable.`);
  }
  const targetSessionAttrs = params.get('target_session_attrs');
  if (targetSessionAttrs !== null && targetSessionAttrs !== 'any') {
    throw new PgConfigError(
      `${label} sets target_session_attrs to something other than "any". node-postgres does not implement it, so the requirement would be silently ignored. Refusing.`,
    );
  }
  for (const key of IGNORED_BENIGN_PARAMS) {
    const v = params.get(key);
    if (v !== null && !/^\d{1,9}$/.test(v)) throw new PgConfigError(`${label} has a non-numeric ${key}.`);
  }

  // The target, read by the very parser pg uses, from the URL WITHOUT its query (every query parameter was consumed above),
  // so nothing in the query can reach the driver and no file is read (sslrootcert & co. were refused).
  const bare = new URL(value);
  bare.search = '';
  bare.hash = '';
  let parsed: PgConnectionStringConfig;
  try {
    parsed = parsePgConnectionString(bare.toString());
  } catch {
    throw new PgConfigError(`${label} is not a parseable postgres URL (value not shown).`);
  }
  const host = (parsed.host ?? '').trim();
  if (!host) throw new PgConfigError(`${label} must name a host.`);
  if (host.startsWith('/')) throw new PgConfigError(`${label} names a Unix socket. Only TCP hosts are supported (TLS and pooler checks need a host name).`);
  const database = (parsed.database ?? '').trim();
  if (!database) throw new PgConfigError(`${label} must name a database.`);
  const user = (parsed.user ?? '').trim();
  if (!user) throw new PgConfigError(`${label} must name a user.`);
  const portText = parsed.port ? String(parsed.port) : '5432';
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new PgConfigError(`${label} has an invalid port.`);
  }
  const port = Number(portText);
  // Security review N-1: a fully-qualified name may end in ONE dot (`ep-x.<region>.aws.neon.tech.`); DNS resolves it to the
  // same host, so it is stripped before any host rule (Neon endpoint key, deny list, loopback, pooler shapes) runs. Anything
  // still ending in a dot (`host..`) is not a host name: refused.
  const normalisedHost = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!normalisedHost || normalisedHost.endsWith('.')) throw new PgConfigError(`${label} has an invalid host name.`);
  const isNeonHost = normalisedHost.endsWith(NEON_SUFFIX);
  const hostNeonEndpoint = isNeonHost ? (normalisedHost.split('.')[0] ?? '').replace(/-pooler$/, '') : '';

  // Neon `options=endpoint%3D<id>`: the SNI workaround Neon documents for clients without SNI. pg sends SNI, so it is
  // redundant here, but it is accepted so a pasted Neon string works. It must name the SAME endpoint as the host:
  // otherwise it would route the connection to a different compute than the one the URL (and every guard) names.
  let providerOptions: string | null = null;
  let sessionRoleOption: string | null = null;
  const options = params.get('options');
  const roleOption = options !== null && parseOptions.allowSessionRole ? /^-c\s+role=([a-z_][a-z0-9_]{0,62})$/.exec(options.trim()) : null;
  if (roleOption) {
    sessionRoleOption = `-c role=${roleOption[1]}`;
  } else if (options !== null) {
    const token = options.trim();
    const match = /^(endpoint|project)=([a-z0-9-]+)$/.exec(token);
    if (!match || !isNeonHost || match[2] !== hostNeonEndpoint) {
      throw new PgConfigError(
        `${label} sets "options". Only a Neon endpoint=<id> token naming the URL's own Neon endpoint is accepted; session settings such as -c role or -c search_path are refused (-c role only for the migration process against a local or test database).`,
      );
    }
    providerOptions = `${match[1]}=${match[2]}`;
  }

  // Security review N-1: Neon also routes by the PASSWORD (`endpoint=<id>$<password>`, or `;` as the separator), for clients
  // without SNI. That would reach the named endpoint through ANY host (an IP, an alias, a loopback tunnel), bypassing every
  // host-based rule. Treated exactly like the `options` token: only on a Neon host and only naming that host's own endpoint.
  // The password itself is never logged or echoed; only the fact that it carries a routing prefix is.
  const password = parsed.password ?? '';
  let routedNeonEndpoint: string | null = providerOptions !== null ? hostNeonEndpoint : null;
  if (/^endpoint=/i.test(password)) {
    const routed = /^endpoint=([a-z0-9-]+)(?:[$;]|$)/i.exec(password);
    const routedId = routed?.[1]?.toLowerCase() ?? '';
    if (!routedId || !isNeonHost || routedId !== hostNeonEndpoint) {
      throw new PgConfigError(
        `${label} carries Neon password routing (a password beginning "endpoint="). It is accepted only on a Neon host and only naming that host's own endpoint. Refusing (password not shown).`,
      );
    }
    routedNeonEndpoint = routedId;
  }

  const target: PgTarget = {
    label,
    host: normalisedHost,
    port,
    user,
    password: '',
    database,
    sslmode: (sslmodeRaw as PgSslMode | null) ?? null,
    applicationName,
    channelBinding: channelBindingRaw === 'require' || channelBindingRaw === 'prefer',
    providerOptions,
    sessionRoleOption,
    routedNeonEndpoint,
    transactionPooler: detectTransactionPooler(normalisedHost, port),
    poolerSuspicion: poolerSuspicionOf(port),
    canonicalKey: `${user}\u0000${normalisedHost}\u0000${port}\u0000${database}`,
    display: `${normalisedHost}:${port}/${database}`,
  };
  Object.defineProperty(target, 'password', { value: password, enumerable: false, writable: false });
  return target;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/** Printable identity of a validated target (no user, no password). What the identity guards log and compare. */
export interface PgTargetIdentity {
  /** Which environment variable this came from. Safe to print. */
  label: string;
  host: string;
  port: string;
  database: string;
  /** Neon endpoint id when the host is a Neon host (pooled and direct share it); otherwise host:port. */
  endpointKey: string;
  /** A Neon `-pooler` host or any documented transaction-pooler shape. */
  pooled: boolean;
  /** Not a loopback host. */
  remote: boolean;
}

export function describePgTarget(target: PgTarget): PgTargetIdentity {
  const firstLabel = target.host.split('.')[0] ?? target.host;
  const neon = target.host.endsWith(NEON_SUFFIX);
  return {
    label: target.label,
    host: target.host,
    port: String(target.port),
    database: target.database,
    endpointKey: neon ? `neon:${firstLabel.replace(/-pooler$/, '')}` : `${target.host}:${target.port}`,
    pooled: /-pooler$/.test(firstLabel) || target.transactionPooler !== null,
    remote: !LOOPBACK_HOSTS.has(target.host),
  };
}

/** True when two validated targets name the same connection target, user and database (password not compared). */
export function sameTarget(a: PgTarget, b: PgTarget): boolean {
  return a.canonicalKey === b.canonicalKey;
}

/** For any log line that must mention a connection string: scheme, host, port and database only. */
export function redactPgUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//<redacted>@${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return '<unparseable postgres url>';
  }
}
