/**
 * Database setup the Twenty way (owner decision 2026-11-18, "change PR #125 option 2 to Twenty's way"): the crewflow_owner
 * credential.
 *
 * Twenty passes PG_DATABASE_URL, the APP login's URL, to the server and the worker alike (twentyhq/twenty@eedb0a73
 * packages/twenty-docker/helm/twenty/templates/deployment-server.yaml:148-155, deployment-worker.yaml:81-88); only its setup
 * step (the `ensure-database-exists` init container) holds the admin login, and it creates the app user with the app user's
 * own password (deployment-server.yaml:90-116). Crewflow does the same: rab-api and rab-worker read PG_DATABASE_URL = the
 * crewflow_owner URL from their environment, and the one-shot db-setup creates crewflow_owner with the password INSIDE that
 * URL (modes a and b) or only checks it (mode c). There is no password file and no generated password any more; APP_SECRET
 * is never part of any database credential.
 *
 * PURE: no I/O, no logging, never imports `pg`. Every value this module returns that carries a secret (a password, a URL)
 * is a non-enumerable property, so a stray `JSON.stringify` or a logged plan object never prints it. Every error message is
 * fixed text: it never contains a URL, a user, a host, a password or a verifier.
 *
 * Consumers: the bootstrap child (`scripts/owner-login/owner-bootstrap.ts`), runtime-db-config (`OWNER_LOGIN`,
 * `isOwnerLoginUrl`) and twenty-mode-check (`scramSha256Verifier`).
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

import { parsePgUrl, PgConfigError, type PgTarget } from '../postgres/pg-url-policy';

/** The one runtime login. Every runtime process (API, Worker, migrate child, schedulers) connects as this role only. */
export const OWNER_LOGIN = 'crewflow_owner' as const;

/** A crewflow_owner password (the one inside PG_DATABASE_URL) is 1-1024 characters, no control characters. */
export const OWNER_PASSWORD_MAX_LENGTH = 1024;
/** SCRAM-SHA-256 parameters PostgreSQL itself uses by default (scram_iterations = 4096, 16-byte salt). */
export const SCRAM_ITERATIONS = 4096;
export const SCRAM_SALT_BYTES = 16;

/** The label every message uses for the deployment variable. */
const URL_LABEL = 'PG_DATABASE_URL';

/**
 * Every refusal of this module (and of the URL policy it runs). Fixed, value-free text; safe to print. The bootstrap child
 * maps it to exit 64 (refusal); anything else thrown is unexpected (exit 70).
 */
export class OwnerCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerCredentialError';
  }
}

/** The fixed messages, exported so consumers and tests compare text exactly. */
export const OWNER_CREDENTIAL_MESSAGES = {
  databaseUrlMissing: `${URL_LABEL} is empty: a database URL is required.`,
  emptyScramPassword: 'A SCRAM-SHA-256 verifier needs a non-empty password.',
  nonAsciiScramPassword:
    'A SCRAM-SHA-256 verifier is only computed for printable-ASCII passwords here (where SASLprep is the identity), so it always matches what the server derives.',
  badScramSalt: 'A SCRAM-SHA-256 salt must be a non-empty byte buffer.',
  ownerUrlWithoutPassword: `${URL_LABEL} names crewflow_owner but carries no usable password (1-${OWNER_PASSWORD_MAX_LENGTH} characters, no control characters). Refusing.`,
} as const;

/**
 * Security review of PR #246, M2: the strength floor for a crewflow_owner password db-setup CREATES or SETS (modes a and b),
 * and, in production, for the one mode c only checks. The operator chooses it now (Twenty's way), so "changeme" must never
 * become the schema owner's password. Floor: 32+ characters, 10+ different characters, and not one short block repeated
 * (`openssl rand -hex 32` is 64 characters over 16). A heuristic floor, not an entropy measurement.
 */
export const OWNER_PASSWORD_MIN_LENGTH = 32;
export const OWNER_PASSWORD_MIN_DISTINCT = 10;

/** True when `password` passes the strength floor above. Pure; never logs. */
export function isStrongOwnerPassword(password: string): boolean {
  if (typeof password !== 'string' || password.length < OWNER_PASSWORD_MIN_LENGTH) return false;
  if (new Set(password).size < OWNER_PASSWORD_MIN_DISTINCT) return false;
  // One short block repeated ("abcdefghij" x 4): the smallest period of the string is less than half its length.
  for (let period = 1; period <= password.length / 2; period += 1) {
    if (password.length % period !== 0) continue;
    if (password.slice(0, period).repeat(password.length / period) === password) return false;
  }
  return true;
}

/** True when `password` can be used as the crewflow_owner password (the one in PG_DATABASE_URL). */
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

/**
 * The runtime-login facts of a (policy-valid) PG_DATABASE_URL, for runtime-db-config.ts checkRuntimeLogin: is its login
 * crewflow_owner, and is its password strong. Refuses an invalid URL. Never returns a value. (Whether it is a transaction pooler
 * is not decided from the URL any more: owner instruction 2026-11-19, capability detection, pg-session-probe.ts.)
 */
export function runtimeUrlFacts(databaseUrl: string): { owner: boolean; strongPassword: boolean } {
  const target = parseTarget(databaseUrl, URL_LABEL);
  return {
    owner: target.user === OWNER_LOGIN,
    strongPassword: typeof target.password === 'string' && isStrongOwnerPassword(target.password),
  };
}

/**
 * One database URL, parsed and classified by its login (pure; never connects; throws OwnerCredentialError):
 *   - `bootstrap`  the login is NOT crewflow_owner (an admin login: the bundled db's superuser, or your database's admin);
 *   - `owner-url`  the login IS crewflow_owner; its password is kept (non-enumerable).
 * The setup needs one real session; a transaction pooler is no longer recognised by its host name here (owner instruction
 * 2026-11-19, capability detection): the setup step connects to PG_DATABASE_SESSION_URL when set. `label` names the variable
 * in every refusal.
 */
export type DbSetupPlan =
  | { mode: 'bootstrap'; readonly urlTarget: PgTarget }
  | {
      mode: 'owner-url';
      /** The validated crewflow_owner target (password non-enumerable). */
      readonly urlTarget: PgTarget;
      /** The URL's own password (crewflow_owner's). SECRET; non-enumerable. */
      readonly ownerPassword: string;
    };

function hide<T extends object>(target: T, key: string, value: string): void {
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: false });
}

/** A fixed message with the variable name it speaks about (the messages above name PG_DATABASE_URL). */
const relabel = (message: string, label: string): string => (label === URL_LABEL ? message : message.split(URL_LABEL).join(label));

export function planDbSetup(databaseUrl: string | undefined | null, label: string = URL_LABEL): DbSetupPlan {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') throw new OwnerCredentialError(relabel(OWNER_CREDENTIAL_MESSAGES.databaseUrlMissing, label));
  let parsed: PgTarget;
  try {
    parsed = parseTarget(databaseUrl, label);
  } catch (error) {
    if (error instanceof OwnerCredentialError) throw new OwnerCredentialError(relabel(error.message, label));
    throw error;
  }
  if (parsed.user !== OWNER_LOGIN) return { mode: 'bootstrap', urlTarget: parsed };
  if (!isValidOwnerPassword(parsed.password)) throw new OwnerCredentialError(relabel(OWNER_CREDENTIAL_MESSAGES.ownerUrlWithoutPassword, label));
  const plan = { mode: 'owner-url' as const, urlTarget: parsed } as Extract<DbSetupPlan, { mode: 'owner-url' }>;
  hide(plan, 'ownerPassword', parsed.password as string);
  return plan;
}

/**
 * The ONE-SHOT db-setup service's two inputs, and the ONLY place either is read (owner decision 2026-11-18, Twenty's way):
 *   - PG_DATABASE_URL  ALWAYS required, ALWAYS the app login crewflow_owner, at a direct host: the very URL rab-api and
 *                      rab-worker receive (compose passes the same expression to all three). Any other login is REFUSED.
 *   - PG_ADMIN_URL     optional: a login that can create roles (your database's admin, or the bundled db's superuser, which
 *                      db-setup.sh sets from the compose-built bundled URL in mode a). With it (modes a and b) db-setup
 *                      creates crewflow_owner with the password inside PG_DATABASE_URL (Twenty: `CREATE USER %I WITH
 *                      PASSWORD %L` with the app user's own password, deployment-server.yaml:107-116), sets that password
 *                      when the role exists and the password does not log in, and removes CREATEROLE once the schema
 *                      bootstrap is complete. Never crewflow_owner itself, and it must name the SAME database as
 *                      PG_DATABASE_URL (host, port, database).
 *                      Without it (mode c) db-setup only checks crewflow_owner, read-only.
 * The retired PG_DATABASE_ADMIN_URL is refused by name. rab-api and rab-worker never receive PG_ADMIN_URL
 * (never-in-runtime-env.ts, api-prestart.sh, worker-start.sh, the compose gates).
 */
export const ADMIN_URL_LABEL = 'PG_ADMIN_URL' as const;
/** Earlier names of the admin URL: refused by name with a "renamed" message, never read. */
export const RETIRED_ADMIN_URL_NAMES: readonly string[] = Object.freeze(['PG_DATABASE_ADMIN_URL']);

export const DB_SETUP_INPUT_MESSAGES = Object.freeze({
  retiredAdminName: (name: string) => `${name} was renamed to ${ADMIN_URL_LABEL} (your database's admin URL; db-setup only). Rename it. Refusing.`,
  appUrlMissing: `${URL_LABEL} is empty. It is always required: the crewflow_owner URL that rab-api and rab-worker use (bundled db: set PG_DATABASE_APP_PASSWORD; your own database: put the crewflow_owner URL in ${URL_LABEL}). Refusing.`,
  appUrlNotOwner: `${URL_LABEL} is the app login and must log in as crewflow_owner. It is never an admin URL: an admin URL goes in ${ADMIN_URL_LABEL} (db-setup only). Refusing.`,
  adminUrlIsOwner: `${ADMIN_URL_LABEL} logs in as crewflow_owner, the app login. ${ADMIN_URL_LABEL} is your database's admin login (db-setup creates crewflow_owner with it); remove it to have db-setup only check crewflow_owner. Refusing.`,
  targetMismatch: `${ADMIN_URL_LABEL} and ${URL_LABEL} name different databases (host, port or database differ). Both must name the same database: db-setup creates crewflow_owner there, and rab-api / rab-worker connect there. Refusing.`,
  weakPassword: `The crewflow_owner password inside ${URL_LABEL} is too weak to become the schema owner's password: it must be at least ${OWNER_PASSWORD_MIN_LENGTH} characters with at least ${OWNER_PASSWORD_MIN_DISTINCT} different characters (openssl rand -hex 32). Nothing was created or changed. Refusing.`,
  // sql-injection-reviewed: an error MESSAGE (printed, never executed); the interpolations are this module's label constants.
  weakPasswordProduction: `The crewflow_owner password inside ${URL_LABEL} is too weak for production: it must be at least ${OWNER_PASSWORD_MIN_LENGTH} characters with at least ${OWNER_PASSWORD_MIN_DISTINCT} different characters. As your admin set a strong one (openssl rand -hex 32; ALTER ROLE crewflow_owner PASSWORD ...) and put it in ${URL_LABEL}, or set ${ADMIN_URL_LABEL} so db-setup sets it. Refusing.`,
});

/** Production, fail closed: NODE_ENV, RAB_RUNTIME_ENV or DB_TARGET says production (trimmed, any case). Same rule as runtime-db-config.ts. */
function looksLikeProduction(env: Record<string, string | undefined>): boolean {
  return ['NODE_ENV', 'RAB_RUNTIME_ENV', 'DB_TARGET'].some((name) => env[name]?.trim().toLowerCase() === 'production');
}

/**
 * db-setup's input. `url` / `name` are the URL db-setup connects with FIRST (the admin URL in `bootstrap` mode, the app URL
 * in `owner-url` mode); `appUrl` is always PG_DATABASE_URL. Every URL and the password are SECRET (non-enumerable).
 */
export interface DbSetupInput {
  readonly mode: 'bootstrap' | 'owner-url';
  readonly name: typeof ADMIN_URL_LABEL | typeof URL_LABEL;
  /** The connect URL's plan (bootstrap: the admin URL's; owner-url: the app URL's). */
  readonly plan: DbSetupPlan;
  /** The app URL's validated target (crewflow_owner). */
  readonly appTarget: PgTarget;
  /** The connect URL. SECRET; non-enumerable. */
  readonly url: string;
  /** PG_DATABASE_URL (crewflow_owner). SECRET; non-enumerable. */
  readonly appUrl: string;
  /** The crewflow_owner password inside PG_DATABASE_URL. SECRET; non-enumerable. */
  readonly ownerPassword: string;
}

const presentValue = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

/** Host, port, database and the provider routing token: the database a URL connects to, whatever its login. */
export function sameDatabase(a: PgTarget, b: PgTarget): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.database === b.database && a.providerOptions === b.providerOptions;
}

/** db-setup's input (see ADMIN_URL_LABEL). Pure; never connects; throws OwnerCredentialError (fixed, value-free text). */
export function selectDbSetupInput(env: Record<string, string | undefined>): DbSetupInput {
  for (const name of RETIRED_ADMIN_URL_NAMES) if (presentValue(env, name) !== undefined) throw new OwnerCredentialError(DB_SETUP_INPUT_MESSAGES.retiredAdminName(name));
  const adminUrl = presentValue(env, ADMIN_URL_LABEL);
  const appUrl = presentValue(env, URL_LABEL);
  if (appUrl === undefined) throw new OwnerCredentialError(DB_SETUP_INPUT_MESSAGES.appUrlMissing);
  const appPlan = planDbSetup(appUrl, URL_LABEL);
  if (appPlan.mode !== 'owner-url') throw new OwnerCredentialError(DB_SETUP_INPUT_MESSAGES.appUrlNotOwner);
  let adminPlan: DbSetupPlan | null = null;
  if (adminUrl !== undefined) {
    adminPlan = planDbSetup(adminUrl, ADMIN_URL_LABEL);
    if (adminPlan.mode !== 'bootstrap') throw new OwnerCredentialError(DB_SETUP_INPUT_MESSAGES.adminUrlIsOwner);
    if (!sameDatabase(adminPlan.urlTarget, appPlan.urlTarget)) throw new OwnerCredentialError(DB_SETUP_INPUT_MESSAGES.targetMismatch);
    // M2: db-setup creates or sets this password: never a weak one, in any environment.
    if (!isStrongOwnerPassword(appPlan.ownerPassword)) throw new OwnerCredentialError(DB_SETUP_INPUT_MESSAGES.weakPassword);
  } else if (looksLikeProduction(env) && !isStrongOwnerPassword(appPlan.ownerPassword)) {
    // M2, mode c: db-setup only checks it, but production never runs on a weak schema-owner password.
    throw new OwnerCredentialError(DB_SETUP_INPUT_MESSAGES.weakPasswordProduction);
  }
  const input = {
    mode: adminPlan ? ('bootstrap' as const) : ('owner-url' as const),
    name: adminPlan ? ADMIN_URL_LABEL : URL_LABEL,
    plan: adminPlan ?? appPlan,
    appTarget: appPlan.urlTarget,
  } as DbSetupInput;
  hide(input, 'url', adminUrl ?? appUrl);
  hide(input, 'appUrl', appUrl);
  hide(input, 'ownerPassword', appPlan.ownerPassword);
  return input;
}
