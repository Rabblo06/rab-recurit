/**
 * DB setup, option A (owner decision on PR #125): the API and the Worker never receive the database ADMIN credential.
 * A one-shot `db-setup` service runs the bootstrap child with the admin URL; on success the child publishes a
 * CREDENTIAL-FREE description of the database (this file's `DbTarget`) at CREWFLOW_DB_TARGET_FILE. The apps' derive step
 * reads it and builds the crewflow_owner URL from it plus HKDF(APP_SECRET) (owner-credential.ts).
 *
 *   {"v":1,"host":"db","port":5432,"database":"crewflow","params":{"sslmode":"verify-full"}}
 *
 * No user, no password, ever. `params` are only the query parameters the runtime URL keeps (owner-credential.ts
 * KEPT_QUERY_PARAMS; `application_name` is dropped there and refused here).
 *
 * PURE: no I/O, no logging, never imports `pg`. The reader is STRICT: an unknown key, an unknown parameter, a wrong type or
 * a value the URL policy refuses is a DbTargetError (exit 64), with fixed, value-free text. The URL itself is built by
 * `buildRuntimeDatabaseUrl` (same policy, same rebuild, same round-trip check as the admin-URL path), and the result is
 * re-parsed and must name exactly the host, port and database of the file.
 */
import { buildRuntimeDatabaseUrl, OWNER_LOGIN, OwnerCredentialError, type OwnerLoginPlan } from './owner-credential';
import { parsePgUrl, PgConfigError } from '../postgres/pg-url-policy';

export const DB_TARGET_FILE_VAR = 'CREWFLOW_DB_TARGET_FILE';
export const DEFAULT_DB_TARGET_FILE = '/run/crewflow/db-target/target.json';
export const DB_TARGET_VERSION = 1;
/** A target file is a few hundred bytes; anything much larger is not one. */
export const DB_TARGET_MAX_BYTES = 4096;

/** The query parameters a target may carry: exactly those buildRuntimeDatabaseUrl keeps. */
export const DB_TARGET_PARAMS: ReadonlySet<string> = new Set([
  'sslmode',
  'channel_binding',
  'target_session_attrs',
  'options',
  'connect_timeout',
  'keepalives',
  'keepalives_idle',
  'keepalives_interval',
  'keepalives_count',
]);

export interface DbTarget {
  v: 1;
  host: string;
  port: number;
  database: string;
  params: Record<string, string>;
}

export class DbTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbTargetError';
  }
}

export const DB_TARGET_MESSAGES = {
  notJson: 'The database target file is not valid JSON. Refusing.',
  shape: 'The database target file does not have exactly the keys v, host, port, database, params. Refusing.',
  version: 'The database target file has an unsupported version (v must be 1). Refusing.',
  host: 'The database target file has an invalid host. Refusing.',
  port: 'The database target file has an invalid port (a whole number 1-65535). Refusing.',
  database: 'The database target file has an invalid database name. Refusing.',
  params: 'The database target file has an unknown, repeated or non-string connection parameter. Refusing.',
  tooLarge: 'The database target file is larger than a target can be. Refusing.',
  canonical: 'The database target file is not in the exact form the db-setup step writes (key order, repeated keys). Refusing.',
  policy: (why: string) => `The database target file names a connection the URL policy refuses: ${why}`,
  roundTrip: 'The database target file does not round-trip to the same host, port and database. Refusing.',
  credential: 'Internal error: a database target must never carry a login or a password. Refusing.',
} as const;

/** Placeholder login of the synthetic URL handed to buildRuntimeDatabaseUrl (never crewflow_owner: that is pass-through). */
const SYNTHETIC_LOGIN = 'crewflow_db_target';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Strict schema check. Throws DbTargetError (fixed text). */
export function validateDbTarget(value: unknown): DbTarget {
  if (!isPlainObject(value)) throw new DbTargetError(DB_TARGET_MESSAGES.shape);
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'database,host,params,port,v') throw new DbTargetError(DB_TARGET_MESSAGES.shape);
  if (value.v !== DB_TARGET_VERSION) throw new DbTargetError(DB_TARGET_MESSAGES.version);
  const { host, port, database, params } = value;
  // A host name, an IPv4 literal or a bare IPv6 literal (lower-case, as parsePgUrl normalises it). Never userinfo, a path,
  // a query, whitespace or brackets.
  const hostName = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
  const ipv6 = /^(?=.*:)[0-9a-f:.]{2,45}$/;
  if (typeof host !== 'string' || host.length < 1 || host.length > 253 || !(hostName.test(host) || ipv6.test(host))) {
    throw new DbTargetError(DB_TARGET_MESSAGES.host);
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new DbTargetError(DB_TARGET_MESSAGES.port);
  // PostgreSQL names are at most 63 bytes; no control characters.
  if (typeof database !== 'string' || database.length < 1 || Buffer.byteLength(database, 'utf8') > 63 || /[\x00-\x1f\x7f]/.test(database)) {
    throw new DbTargetError(DB_TARGET_MESSAGES.database);
  }
  if (!isPlainObject(params)) throw new DbTargetError(DB_TARGET_MESSAGES.params);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!DB_TARGET_PARAMS.has(k) || typeof v !== 'string' || v.length < 1 || v.length > 256) throw new DbTargetError(DB_TARGET_MESSAGES.params);
    out[k] = v;
  }
  return { v: 1, host, port, database, params: out };
}

/** JSON text of a target file → validated target. Throws DbTargetError. */
export function parseDbTarget(text: string): DbTarget {
  if (Buffer.byteLength(text, 'utf8') > DB_TARGET_MAX_BYTES) throw new DbTargetError(DB_TARGET_MESSAGES.tooLarge);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DbTargetError(DB_TARGET_MESSAGES.notJson);
  }
  const target = validateDbTarget(value);
  // Only the writer's canonical text is accepted (fixed key order, sorted params). This also refuses repeated JSON keys,
  // which JSON.parse would silently resolve last-wins.
  if (text.trim() !== serializeDbTarget(target).trim()) throw new DbTargetError(DB_TARGET_MESSAGES.canonical);
  return target;
}

/** The file's exact text: fixed key order, sorted params, one trailing newline. */
export function serializeDbTarget(target: DbTarget): string {
  const t = validateDbTarget(target);
  const params: Record<string, string> = {};
  for (const k of Object.keys(t.params).sort()) params[k] = t.params[k] as string;
  return `${JSON.stringify({ v: t.v, host: t.host, port: t.port, database: t.database, params })}\n`;
}

function synthUrl(target: DbTarget): string {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  const query = new URLSearchParams();
  for (const k of Object.keys(target.params).sort()) query.set(k, target.params[k] as string);
  const search = query.toString();
  return `postgres://${SYNTHETIC_LOGIN}@${host}:${target.port}/${encodeURIComponent(target.database)}${search ? `?${search}` : ''}`;
}

/**
 * The crewflow_owner runtime URL for a target and the derived password. Runs the SAME policy and rebuild as the admin-URL
 * path (buildRuntimeDatabaseUrl: no unknown parameter, no ssl* but sslmode, no session options, no transaction pooler),
 * then checks the result names exactly the file's host, port and database. Returns a secret: never log it.
 */
export function runtimeUrlFromDbTarget(target: DbTarget, ownerPassword: string): string {
  const t = validateDbTarget(target);
  let url: string;
  try {
    url = buildRuntimeDatabaseUrl(synthUrl(t), ownerPassword);
  } catch (error) {
    // OwnerCredentialError / PgConfigError messages are fixed and value-free by contract.
    if (error instanceof OwnerCredentialError || error instanceof PgConfigError) {
      throw new DbTargetError(DB_TARGET_MESSAGES.policy(error.message));
    }
    throw error;
  }
  const parsed = parsePgUrl(url, 'the crewflow_owner URL built from the database target');
  if (parsed.user !== OWNER_LOGIN || parsed.host !== t.host || parsed.port !== t.port || parsed.database !== t.database) {
    throw new DbTargetError(DB_TARGET_MESSAGES.roundTrip);
  }
  return url;
}

/**
 * The writer side: the target of a bootstrap-mode plan, read from its (already policy-checked) runtime URL, so it holds
 * exactly the host, port, database and kept parameters the runtime will use. Proves it is credential-free and that
 * rebuilding it with the same password gives the same connection. Throws DbTargetError.
 */
export function dbTargetFromPlan(plan: Extract<OwnerLoginPlan, { mode: 'bootstrap' }>): DbTarget {
  const runtime = plan.runtimeTarget;
  const params: Record<string, string> = {};
  for (const [k, v] of new URL(plan.runtimeUrl).searchParams) params[k] = v;
  const target = validateDbTarget({ v: 1, host: runtime.host, port: runtime.port, database: runtime.database, params });
  const text = serializeDbTarget(target);
  if (text.includes(plan.ownerPassword) || /"(user|password|username)"/.test(text) || text.includes('@')) {
    throw new DbTargetError(DB_TARGET_MESSAGES.credential);
  }
  const rebuilt = parsePgUrl(runtimeUrlFromDbTarget(target, plan.ownerPassword), 'the rebuilt crewflow_owner URL');
  if (
    rebuilt.canonicalKey !== runtime.canonicalKey ||
    rebuilt.password !== plan.ownerPassword ||
    rebuilt.sslmode !== runtime.sslmode ||
    rebuilt.channelBinding !== runtime.channelBinding ||
    rebuilt.providerOptions !== runtime.providerOptions
  ) {
    throw new DbTargetError(DB_TARGET_MESSAGES.roundTrip);
  }
  return target;
}
