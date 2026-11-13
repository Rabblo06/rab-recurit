/**
 * Database setup like Twenty (DB-SETUP-PLAN §2.1, §4, §5.1): the crewflow_owner credential, derived from APP_SECRET.
 *
 * PURE: no I/O, no logging, never imports `pg`. Every value this module returns that carries a secret (the derived
 * password, a runtime URL) is a non-enumerable property, so a stray `JSON.stringify` or a logged plan object never
 * prints it. Every error message is fixed text: it never contains a URL, a user, a host, a password or a verifier.
 *
 * One deployment variable, two modes (`planOwnerLogin`):
 *   - `pass-through` (§7.1, owner decision D5): `PG_DATABASE_URL` already names `crewflow_owner` (R256 deployments, the
 *     dev stack, deploy-order's existing scenarios, the manual 01-crewflow-owner.sql path). The runtime URL is the input,
 *     byte for byte; APP_SECRET plays no part in the database login; the bootstrap child never connects.
 *   - `bootstrap`: `PG_DATABASE_URL` is the database ADMIN URL. The crewflow_owner password is
 *     hex(HKDF-SHA256(APP_SECRET, salt = empty, info = OWNER_PASSWORD_HKDF_INFO, 32 bytes)); the bootstrap child (as the
 *     admin) makes crewflow_owner use it, and every runtime process gets `buildRuntimeDatabaseUrl(adminUrl, password)`:
 *     the admin URL's host, port, database and validated query, with the userinfo replaced by crewflow_owner.
 *
 * PR #125 option 2: in a deployment ONLY the one-shot db-setup step receives PG_DATABASE_URL; it uses `planDbSetup` (below),
 * where a crewflow_owner URL is no longer passed through unchanged but gets the derived password too. `planOwnerLogin`'s
 * pass-through stays for the derive step's no-target mode (development, the documented rollback command).
 *
 * Consumers: the bootstrap child (`scripts/owner-login/bootstrap-owner-login.ts`), the derive step
 * (`scripts/owner-login/derive-runtime-url.ts`, used by api-prestart.sh and worker-start.sh so both build byte-identical
 * URLs), runtime-db-config (`OWNER_LOGIN`), and twenty-mode-check (`scramSha256Verifier`).
 */
import {
  createHash,
  createHmac,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';

import { minLength } from 'class-validator';

import {
  parsePgUrl,
  PgConfigError,
  type PgTarget,
} from '../postgres/pg-url-policy';

/** The one runtime login. Every runtime process (API, Worker, migrate child, schedulers) connects as this role only. */
export const OWNER_LOGIN = 'crewflow_owner' as const;

/**
 * HKDF `info` label of the crewflow_owner password. Distinct from, and not a prefix of, every other HKDF label in the repo
 * (`crewflow:key-purpose:v1:<purpose>:<kid>`, `rab-secret-encryption[:<kid>]`, `rab-qr-token-v1`); a spec enforces it.
 * Changing it rotates the database password of every bootstrap-mode deployment: bump the `-v1` suffix only on purpose.
 */
export const OWNER_PASSWORD_HKDF_INFO = 'crewflow-owner-db-password-v1';
/** Output key length in bytes; the password is its lowercase hex (64 characters). */
export const OWNER_PASSWORD_BYTES = 32;
/** The same floor as environment-variables.ts (`@MinLength(32)` on APP_SECRET), checked the same way (class-validator). */
export const APP_SECRET_MIN_LENGTH = 32;
/** SCRAM-SHA-256 parameters PostgreSQL itself uses by default (scram_iterations = 4096, 16-byte salt). */
export const SCRAM_ITERATIONS = 4096;
export const SCRAM_SALT_BYTES = 16;

/** The label every message uses for the deployment variable. */
const URL_LABEL = 'PG_DATABASE_URL';
const OWNER_PASSWORD_PATTERN = /^[0-9a-f]{64}$/;

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
  appSecretMissing:
    'APP_SECRET is required — the process must not start without it',
  appSecretShort: `APP_SECRET must be at least ${APP_SECRET_MIN_LENGTH} characters`,
  databaseUrlMissing: `${URL_LABEL} is required: the database admin URL (or a crewflow_owner URL).`,
  transactionPooler: `${URL_LABEL} names a transaction pooler. The database setup step needs a direct (session) connection: use the provider's direct host and port for the admin URL.`,
  badOwnerPassword:
    'The crewflow_owner password must be 64 lowercase hex characters (derived from APP_SECRET).',
  emptyScramPassword: 'A SCRAM-SHA-256 verifier needs a non-empty password.',
  nonAsciiScramPassword:
    'A SCRAM-SHA-256 verifier is only computed for printable-ASCII passwords here (where SASLprep is the identity), so it always matches what the server derives.',
  badScramSalt: 'A SCRAM-SHA-256 salt must be a non-empty byte buffer.',
  roundTrip:
    'Internal error: the rebuilt crewflow_owner URL does not name the same database target. Refusing.',
  unexpectedQuery:
    'Internal error: the admin URL carries a query parameter the runtime URL does not know how to keep. Refusing.',
} as const;

/**
 * hex(HKDF-SHA256(utf8(appSecret), salt = empty, info = OWNER_PASSWORD_HKDF_INFO, L = 32)): 64 lowercase hex characters.
 * Hex because it is URL-safe in userinfo without percent-encoding, SASLprep-neutral and shell-safe. Refuses a missing or
 * short APP_SECRET with the exact messages environment validation uses, before anything connects.
 */
export function deriveOwnerPassword(
  appSecret: string | undefined | null,
): string {
  if (appSecret === undefined || appSecret === null || appSecret === '') {
    throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.appSecretMissing);
  }
  if (
    typeof appSecret !== 'string' ||
    !minLength(appSecret, APP_SECRET_MIN_LENGTH)
  ) {
    throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.appSecretShort);
  }
  const okm = hkdfSync(
    'sha256',
    Buffer.from(appSecret, 'utf8'),
    Buffer.alloc(0),
    OWNER_PASSWORD_HKDF_INFO,
    OWNER_PASSWORD_BYTES,
  );
  return Buffer.from(okm).toString('hex');
}

/**
 * A SCRAM-SHA-256 verifier (`SCRAM-SHA-256$<iterations>:<salt b64>$<StoredKey b64>:<ServerKey b64>`, RFC 5802 / 7677),
 * computed here so no plaintext password is ever part of a statement. PostgreSQL stores a pre-hashed verifier as-is
 * (`CREATE ROLE … PASSWORD '<verifier>'`), whatever `password_encryption` says. `salt` is for fixed test vectors only;
 * production callers omit it (16 random bytes). Moved here from scripts/twenty-mode-check.ts (`scramVerifier`).
 */
export function scramSha256Verifier(password: string, salt?: Buffer): string {
  if (typeof password !== 'string' || password.length === 0)
    throw new OwnerCredentialError(
      OWNER_CREDENTIAL_MESSAGES.emptyScramPassword,
    );
  if (!/^[\x20-\x7e]+$/.test(password))
    throw new OwnerCredentialError(
      OWNER_CREDENTIAL_MESSAGES.nonAsciiScramPassword,
    );
  if (salt !== undefined && (!Buffer.isBuffer(salt) || salt.length === 0))
    throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.badScramSalt);
  const saltBytes = salt ?? randomBytes(SCRAM_SALT_BYTES);
  const salted = pbkdf2Sync(
    password,
    saltBytes,
    SCRAM_ITERATIONS,
    32,
    'sha256',
  );
  const hmac = (key: Buffer, text: string) =>
    createHmac('sha256', key).update(text).digest();
  const storedKey = createHash('sha256')
    .update(hmac(salted, 'Client Key'))
    .digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${saltBytes.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** parsePgUrl with every refusal re-thrown as OwnerCredentialError (its messages are already value-free). */
function parseTarget(raw: string, label: string): PgTarget {
  try {
    return parsePgUrl(raw, label);
  } catch (error) {
    if (error instanceof PgConfigError)
      throw new OwnerCredentialError(error.message);
    throw error;
  }
}

/** True when the (policy-valid) URL's login is crewflow_owner: the pass-through mode. Refuses an invalid URL. */
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
 * The crewflow_owner runtime URL for an ADMIN URL (§5.1). Steps: (1) the admin URL passes the same policy as every
 * connection (parsePgUrl: no `?host=`, no `sslrootcert`/any ssl* but sslmode, no unknown parameter, no `-c` options) and
 * must not be a transaction pooler (the bootstrap needs a session); (2) it is rebuilt from the parsed target, never by
 * string surgery: scheme, host, port, database and the validated query are kept, `application_name` is dropped (each
 * process sets its own); (3) the userinfo becomes `crewflow_owner:<ownerPassword>`; (4) TLS is unchanged (sslmode from
 * the admin URL, the CA from PG_SSL_CA_CERT_PATH); (5) the result is re-parsed and must name the same target.
 *
 * A crewflow_owner admin URL is returned unchanged, byte for byte (pass-through; `ownerPassword` is then not used).
 * Never connects. Returns a secret: never log it.
 */
export function buildRuntimeDatabaseUrl(
  adminUrl: string,
  ownerPassword: string,
): string {
  if (typeof adminUrl !== 'string' || adminUrl.trim() === '')
    throw new OwnerCredentialError(
      OWNER_CREDENTIAL_MESSAGES.databaseUrlMissing,
    );
  const admin = parseTarget(adminUrl, URL_LABEL);
  if (admin.user === OWNER_LOGIN) return adminUrl;
  return rebuildWithOwnerLogin(adminUrl, admin, ownerPassword);
}

/**
 * The rebuild of buildRuntimeDatabaseUrl, WITHOUT its crewflow_owner short-circuit: also used for a crewflow_owner URL in
 * the db-setup step (option 2, planDbSetup), where the URL's own password is replaced by the derived one.
 */
function rebuildWithOwnerLogin(
  adminUrl: string,
  admin: PgTarget,
  ownerPassword: string,
): string {
  if (admin.transactionPooler !== null)
    throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.transactionPooler);
  if (
    typeof ownerPassword !== 'string' ||
    !OWNER_PASSWORD_PATTERN.test(ownerPassword)
  ) {
    throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.badOwnerPassword);
  }

  // The admin URL already passed parsePgUrl, so `new URL` succeeds and every query parameter is allowed and validated.
  const source = new URL(adminUrl.trim());
  const scheme =
    source.protocol.toLowerCase() === 'postgresql:'
      ? 'postgresql:'
      : 'postgres:';
  const host = admin.host.includes(':') ? `[${admin.host}]` : admin.host;
  const query = new URLSearchParams();
  for (const [key, value] of source.searchParams) {
    if (DROPPED_QUERY_PARAMS.has(key)) continue;
    if (!KEPT_QUERY_PARAMS.has(key))
      throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.unexpectedQuery);
    if (key === 'sslmode') query.set(key, admin.sslmode ?? value);
    else if (key === 'options') {
      // parsePgUrl accepted only a Neon endpoint token here (session `-c` options are refused without allowSessionRole).
      if (admin.providerOptions === null)
        throw new OwnerCredentialError(
          OWNER_CREDENTIAL_MESSAGES.unexpectedQuery,
        );
      query.set(key, admin.providerOptions);
    } else query.set(key, value);
  }
  const search = query.toString();
  // The database keeps the admin URL's own encoded path: pg-connection-string decodes it with decodeURI, which is exactly
  // how admin.database was produced, so re-encoding it could only change its meaning (the round trip below proves it).
  const runtimeUrl = `${scheme}//${OWNER_LOGIN}:${ownerPassword}@${host}:${admin.port}${source.pathname}${search ? `?${search}` : ''}`;

  const runtime = parseTarget(runtimeUrl, URL_LABEL);
  if (
    runtime.user !== OWNER_LOGIN ||
    runtime.password !== ownerPassword ||
    runtime.host !== admin.host ||
    runtime.port !== admin.port ||
    runtime.database !== admin.database ||
    runtime.sslmode !== admin.sslmode ||
    runtime.channelBinding !== admin.channelBinding ||
    runtime.providerOptions !== admin.providerOptions ||
    runtime.applicationName !== null ||
    runtime.transactionPooler !== null
  ) {
    throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.roundTrip);
  }
  return runtimeUrl;
}

/** What a process needs to know about the one deployment variable. Secret-bearing fields are non-enumerable. */
export type OwnerLoginPlan =
  | {
      mode: 'pass-through';
      /** The validated crewflow_owner target (password non-enumerable). */
      readonly target: PgTarget;
      /** = the input URL, byte for byte. SECRET. */
      readonly runtimeUrl: string;
    }
  | {
      mode: 'bootstrap';
      /** The validated admin target the bootstrap child connects to (password non-enumerable). */
      readonly adminTarget: PgTarget;
      /** Same host/port/database/TLS as adminTarget, user crewflow_owner, the derived password. For the probe (Q3). */
      readonly runtimeTarget: PgTarget;
      /** The crewflow_owner runtime URL. SECRET. */
      readonly runtimeUrl: string;
      /** The derived crewflow_owner password (64 hex). SECRET. Feed it to scramSha256Verifier, never to SQL text. */
      readonly ownerPassword: string;
    };

export interface OwnerLoginInputs {
  /** PG_DATABASE_URL as the container received it. */
  databaseUrl: string | undefined | null;
  /** APP_SECRET. Not read (not required) in pass-through mode. */
  appSecret: string | undefined | null;
}

function hide<T extends object>(target: T, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/**
 * The single decision both the bootstrap child and the derive step make, so they can never disagree: pass-through for a
 * crewflow_owner URL, otherwise bootstrap with the derived password. Pure, never connects; throws OwnerCredentialError.
 */
export function planOwnerLogin(inputs: OwnerLoginInputs): OwnerLoginPlan {
  const databaseUrl = inputs.databaseUrl;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '')
    throw new OwnerCredentialError(
      OWNER_CREDENTIAL_MESSAGES.databaseUrlMissing,
    );
  const parsed = parseTarget(databaseUrl, URL_LABEL);
  if (parsed.user === OWNER_LOGIN) {
    const plan = { mode: 'pass-through' as const, target: parsed } as Extract<
      OwnerLoginPlan,
      { mode: 'pass-through' }
    >;
    hide(plan, 'runtimeUrl', databaseUrl);
    return plan;
  }
  if (parsed.transactionPooler !== null)
    throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.transactionPooler);
  const ownerPassword = deriveOwnerPassword(inputs.appSecret);
  const runtimeUrl = buildRuntimeDatabaseUrl(databaseUrl, ownerPassword);
  const plan = {
    mode: 'bootstrap' as const,
    adminTarget: parsed,
    runtimeTarget: parseTarget(runtimeUrl, URL_LABEL),
  } as Extract<OwnerLoginPlan, { mode: 'bootstrap' }>;
  hide(plan, 'runtimeUrl', runtimeUrl);
  hide(plan, 'ownerPassword', ownerPassword);
  return plan;
}

/**
 * PR #125 option 2 (owner decision 2026-11-13): what the one-shot db-setup step (the bootstrap child, the ONLY process that
 * receives PG_DATABASE_URL in a deployment) does with the one database setting. Both modes need APP_SECRET and give the
 * SAME crewflow_owner runtime URL (the URL's host, port, database and kept parameters; user crewflow_owner; the DERIVED
 * password), from which the credential-free target file is written:
 *   - `bootstrap`: the URL's login is NOT crewflow_owner (the database admin): create crewflow_owner / set its password
 *     (DB-SETUP-PLAN §3, unchanged);
 *   - `owner-url`: the URL's login IS crewflow_owner (an existing crewflow_owner, e.g. made by hand with
 *     01-crewflow-owner.sql): log in with the derived password if it already works (no change), else with the URL's own
 *     password, and set crewflow_owner's OWN password to the derived one (owner-bootstrap.ts).
 * Unlike planOwnerLogin, a crewflow_owner URL is NOT passed through unchanged (the apps never receive it) and a
 * transaction pooler is refused in both modes (the setup needs one real session). Pure; throws OwnerCredentialError.
 */
export type DbSetupPlan =
  | Extract<OwnerLoginPlan, { mode: 'bootstrap' }>
  | {
      mode: 'owner-url';
      /** The validated crewflow_owner target of the URL, with the URL's OWN password (non-enumerable). */
      readonly urlTarget: PgTarget;
      /** Same host/port/database/TLS, user crewflow_owner, the DERIVED password. */
      readonly runtimeTarget: PgTarget;
      /** The crewflow_owner runtime URL with the derived password. SECRET. */
      readonly runtimeUrl: string;
      /** The derived crewflow_owner password (64 hex). SECRET. Feed it to scramSha256Verifier, never to SQL text. */
      readonly ownerPassword: string;
    };

export function planDbSetup(inputs: OwnerLoginInputs): DbSetupPlan {
  const databaseUrl = inputs.databaseUrl;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '')
    throw new OwnerCredentialError(
      OWNER_CREDENTIAL_MESSAGES.databaseUrlMissing,
    );
  const parsed = parseTarget(databaseUrl, URL_LABEL);
  if (parsed.user !== OWNER_LOGIN) {
    const plan = planOwnerLogin(inputs);
    if (plan.mode !== 'bootstrap')
      throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.roundTrip);
    return plan;
  }
  if (parsed.transactionPooler !== null)
    throw new OwnerCredentialError(OWNER_CREDENTIAL_MESSAGES.transactionPooler);
  const ownerPassword = deriveOwnerPassword(inputs.appSecret);
  const runtimeUrl = rebuildWithOwnerLogin(databaseUrl, parsed, ownerPassword);
  const plan = {
    mode: 'owner-url' as const,
    urlTarget: parsed,
    runtimeTarget: parseTarget(runtimeUrl, URL_LABEL),
  } as Extract<DbSetupPlan, { mode: 'owner-url' }>;
  hide(plan, 'runtimeUrl', runtimeUrl);
  hide(plan, 'ownerPassword', ownerPassword);
  return plan;
}
