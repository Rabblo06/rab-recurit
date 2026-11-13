/**
 * Database setup the Twenty Helm way (OWNER-DB-FINAL.md Part A, DB-SETUP-HELM-PLAN.md): the crewflow_owner credential.
 *
 * Twenty's Helm chart keeps the app user's password as a RANDOM value (`randAlphaNum 32`) in its own secret and reuses it
 * on every upgrade (`lookup`) — twentyhq/twenty@eedb0a73 `packages/twenty-docker/helm/twenty/templates/secret-db-url.yaml:3-8`.
 * Crewflow does the same: `generateOwnerPassword()` makes a crypto-random password ONCE; the bootstrap child stores it in
 * db-setup's password file (owner-password-file.ts) and later starts reuse it. APP_SECRET is never part of any database
 * credential (the former HKDF derivation is gone).
 *
 * PURE: no I/O, no logging, never imports `pg`. Every value this module returns that carries a secret (a password, a runtime
 * URL) is a non-enumerable property, so a stray `JSON.stringify` or a logged plan object never prints it. Every error
 * message is fixed text: it never contains a URL, a user, a host, a password or a verifier.
 *
 * Consumers: the bootstrap child (`scripts/owner-login/owner-bootstrap.ts`), the derive step
 * (`scripts/owner-login/derive-runtime-url.ts`, used by api-prestart.sh and worker-start.sh so both build byte-identical
 * URLs), runtime-db-config (`OWNER_LOGIN`, `isOwnerLoginUrl`), db-target.ts, and twenty-mode-check (`scramSha256Verifier`).
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

import { parsePgUrl, PgConfigError, type PgTarget } from '../postgres/pg-url-policy';

/** The one runtime login. Every runtime process (API, Worker, migrate child, schedulers) connects as this role only. */
export const OWNER_LOGIN = 'crewflow_owner' as const;

/** Bytes of entropy of a generated crewflow_owner password (Twenty: 32 random characters). The password is their hex. */
export const OWNER_PASSWORD_BYTES = 32;
/** A stored password (generated, or copied from an existing crewflow_owner URL) is 1-1024 characters, no control characters. */
export const OWNER_PASSWORD_MAX_LENGTH = 1024;
/** SCRAM-SHA-256 parameters PostgreSQL itself uses by default (scram_iterations = 4096, 16-byte salt). */
export const SCRAM_ITERATIONS = 4096;
export const SCRAM_SALT_BYTES = 16;

/** The label every message uses for the deployment variable. */
const URL_LABEL = 'PG_DATABASE_URL';

/**
 * Every refusal of this module (and of the URL policy it runs). Fixed, value-free text; safe to print. The bootstrap child
 * and the derive step map it to exit 64 (refusal); anything else thrown is unexpected (exit 70).
 */
export class OwnerCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerCredentialError';
  }
}

/** The fixed messages, exported so consumers and tests compare text exactly. */
export const OWNER_CREDENTIAL_MESSAGES = {
  databaseUrlMissing: `${URL_LABEL} is required: the database admin URL (or an existing crewflow_owner URL).`,
  transactionPooler: `${URL_LABEL} names a transaction pooler. The database setup step needs a direct (session) connection: use the provider's direct host and port.`,
  badOwnerPassword: `The crewflow_owner password must be 1-${OWNER_PASSWORD_MAX_LENGTH} characters with no control characters.`,
  emptyScramPassword: 'A SCRAM-SHA-256 verifier needs a non-empty password.',
  nonAsciiScramPassword:
    'A SCRAM-SHA-256 verifier is only computed for printable-ASCII passwords here (where SASLprep is the identity), so it always matches what the server derives.',
  badScramSalt: 'A SCRAM-SHA-256 salt must be a non-empty byte buffer.',
  roundTrip: 'Internal error: the rebuilt crewflow_owner URL does not name the same database target. Refusing.',
  unexpectedQuery: 'Internal error: the admin URL carries a query parameter the runtime URL does not know how to keep. Refusing.',
  ownerUrlWithoutPassword: `${URL_LABEL} names crewflow_owner but carries no usable password. Refusing.`,
} as const;

/**
 * A new crewflow_owner password: hex of 32 crypto-random bytes (64 lowercase hex characters: URL-safe in userinfo, SASLprep
 * neutral, shell safe). Twenty: `randAlphaNum 32` (secret-db-url.yaml:3-8). Called only when no password file exists.
 */
export function generateOwnerPassword(): string {
  return randomBytes(OWNER_PASSWORD_BYTES).toString('hex');
}

/** True when `password` can be stored and used as the crewflow_owner password (generated or copied from a URL). */
export function isValidOwnerPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 1 && password.length <= OWNER_PASSWORD_MAX_LENGTH && !/[\x00-\x1f\x7f]/.test(password);
}

/**
 * A SCRAM-SHA-256 verifier (`SCRAM-SHA-256$<iterations>:<salt b64>$<StoredKey b64>:<ServerKey b64>`, RFC 5802 / 7677),
 * computed here so no plaintext password is ever part of a statement. PostgreSQL stores a pre-hashed verifier as-is
 * (`CREATE ROLE … PASSWORD '<verifier>'`), whatever `password_encryption` says. `salt` is for fixed test vectors only;
 * production callers omit it (16 random bytes).
 */
export function scramSha256Verifier(password: string, salt?: Buffer): string {
  if (typeof password !== 'string' || password.length === 0) throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.emptyScramPassword);
  if (!/^[\x20-\x7e]+$/.test(password)) throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.nonAsciiScramPassword);
  if (salt !== undefined && (!Buffer.isBuffer(salt) || salt.length === 0)) throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.badScramSalt);
  const saltBytes = salt ?? randomBytes(SCRAM_SALT_BYTES);
  const salted = pbkdf2Sync(password, saltBytes, SCRAM_ITERATIONS, 32, 'sha256');
  const hmac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest();
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${saltBytes.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** parsePgUrl with every refusal re-thrown as OwnerCredentialError (its messages are already value-free). */
function parseTarget(raw: string, label: string): PgTarget {
  try {
    return parsePgUrl(raw, label);
  } catch (error) {
    if (error instanceof PgConfigError) throw new OwnerCredentialError(error.message);
    throw error;
  }
}

/** True when the (policy-valid) URL's login is crewflow_owner. Refuses an invalid URL. */
export function isOwnerLoginUrl(databaseUrl: string): boolean {
  return parseTarget(databaseUrl, URL_LABEL).user === OWNER_LOGIN;
}

/** Query parameters the runtime URL keeps (all already validated by parsePgUrl). `application_name` is dropped. */
const KEPT_QUERY_PARAMS: ReadonlySet<string> = new Set([
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
const DROPPED_QUERY_PARAMS: ReadonlySet<string> = new Set(['application_name']);

/**
 * The crewflow_owner runtime URL for a database URL (any login) and the crewflow_owner password: (1) the URL passes the
 * same policy as every connection (parsePgUrl: no `?host=`, no `sslrootcert`/any ssl* but sslmode, no unknown parameter,
 * no `-c` options) and must not be a transaction pooler; (2) it is rebuilt from the parsed target, never by string surgery:
 * scheme, host, port, database and the validated query are kept, `application_name` is dropped; (3) the userinfo becomes
 * `crewflow_owner:<password, percent-encoded>`; (4) TLS is unchanged (sslmode from the URL, the CA from PG_SSL_CA_CERT_PATH);
 * (5) the result is re-parsed and must name the same target with exactly this password. Never connects. Returns a secret.
 */
export function buildRuntimeDatabaseUrl(databaseUrl: string, ownerPassword: string): string {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.databaseUrlMissing);
  const source = parseTarget(databaseUrl, URL_LABEL);
  if (source.transactionPooler !== null) throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.transactionPooler);
  if (!isValidOwnerPassword(ownerPassword)) throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.badOwnerPassword);

  // The URL already passed parsePgUrl, so `new URL` succeeds and every query parameter is allowed and validated.
  const parsed = new URL(databaseUrl.trim());
  const scheme = parsed.protocol.toLowerCase() === 'postgresql:' ? 'postgresql:' : 'postgres:';
  const host = source.host.includes(':') ? `[${source.host}]` : source.host;
  const query = new URLSearchParams();
  for (const [key, value] of parsed.searchParams) {
    if (DROPPED_QUERY_PARAMS.has(key)) continue;
    if (!KEPT_QUERY_PARAMS.has(key)) throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.unexpectedQuery);
    if (key === 'sslmode') query.set(key, source.sslmode ?? value);
    else if (key === 'options') {
      // parsePgUrl accepted only a Neon endpoint token here (session `-c` options are refused without allowSessionRole).
      if (source.providerOptions === null) throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.unexpectedQuery);
      query.set(key, source.providerOptions);
    } else query.set(key, value);
  }
  const search = query.toString();
  // The database keeps the URL's own encoded path: pg-connection-string decodes it with decodeURI, which is exactly how
  // source.database was produced, so re-encoding it could only change its meaning (the round trip below proves it).
  const runtimeUrl = `${scheme}//${OWNER_LOGIN}:${encodeURIComponent(ownerPassword)}@${host}:${source.port}${parsed.pathname}${search ? `?${search}` : ''}`;

  const runtime = parseTarget(runtimeUrl, URL_LABEL);
  if (
    runtime.user !== OWNER_LOGIN ||
    runtime.password !== ownerPassword ||
    runtime.host !== source.host ||
    runtime.port !== source.port ||
    runtime.database !== source.database ||
    runtime.sslmode !== source.sslmode ||
    runtime.channelBinding !== source.channelBinding ||
    runtime.providerOptions !== source.providerOptions ||
    runtime.applicationName !== null ||
    runtime.transactionPooler !== null
  ) {
    throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.roundTrip);
  }
  return runtimeUrl;
}

/**
 * What the one-shot db-setup step (the bootstrap child, the ONLY process that receives PG_DATABASE_URL) does with the one
 * database setting. Pure; never connects; throws OwnerCredentialError.
 *   - `bootstrap`: the URL's login is NOT crewflow_owner (the bundled db's superuser or a client's admin URL): crewflow_owner
 *     is created if missing, with the password from db-setup's password file (generated on the first start). Twenty: the
 *     `ensure-database-exists` init container, which alone holds the superuser secret and runs `CREATE USER … IF NOT
 *     EXISTS` without ever changing an existing user's password (deployment-server.yaml:81-130, :99-116). A client's admin
 *     URL is a Crewflow addition (Twenty would run the app as that login; RLS requires a separate owner login).
 *   - `owner-url`: the URL's login IS crewflow_owner (an existing one, e.g. made by hand with 01-crewflow-owner.sql): only
 *     read-only checks; its password is copied into the password file; the database is never written to (Twenty: an
 *     external database gets no setup step, secret-db-url.yaml:24-30).
 * A transaction pooler is refused in both modes (the setup needs one real session).
 */
export type DbSetupPlan =
  | { mode: 'bootstrap'; readonly urlTarget: PgTarget }
  | {
      mode: 'owner-url';
      /** The validated crewflow_owner target (password non-enumerable). */
      readonly urlTarget: PgTarget;
      /** The URL's own password (the existing crewflow_owner's). SECRET; non-enumerable. */
      readonly ownerPassword: string;
    };

function hide<T extends object>(target: T, key: string, value: string): void {
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: false });
}

export function planDbSetup(databaseUrl: string | undefined | null): DbSetupPlan {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.databaseUrlMissing);
  const parsed = parseTarget(databaseUrl, URL_LABEL);
  if (parsed.transactionPooler !== null) throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.transactionPooler);
  if (parsed.user !== OWNER_LOGIN) return { mode: 'bootstrap', urlTarget: parsed };
  if (!isValidOwnerPassword(parsed.password)) throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.ownerUrlWithoutPassword);
  const plan = { mode: 'owner-url' as const, urlTarget: parsed } as Extract<DbSetupPlan, { mode: 'owner-url' }>;
  hide(plan, 'ownerPassword', parsed.password as string);
  return plan;
}
