/**
 * Database setup the Twenty Helm way (OWNER-DB-FINAL.md Part A, DB-SETUP-HELM-PLAN.md): the core of the bootstrap child,
 * run by the one-shot db-setup service, the ONLY holder of PG_DATABASE_URL. It makes sure `crewflow_owner` exists with
 * exactly the 01-crewflow-owner.sql attributes and `CONNECT, CREATE, TEMPORARY ... WITH GRANT OPTION` on the current
 * database, that db-setup's password file holds its password, and publishes the credential-free target. Entry:
 * bootstrap-owner-login.ts.
 *
 * Twenty's Helm chart (twentyhq/twenty@eedb0a73, packages/twenty-docker/helm/twenty/templates/):
 *   - the `ensure-database-exists` init container alone holds the superuser secret (deployment-server.yaml:81-130) and runs
 *     `CREATE USER … IF NOT EXISTS`, never changing an existing user's password (:99-116);
 *   - the app user's password is random (`randAlphaNum 32`), kept in its own secret and reused on every upgrade
 *     (secret-db-url.yaml:3-8);
 *   - an external database gets no setup step at all (secret-db-url.yaml:24-30, _helpers.tpl:56-83);
 *   - APP_SECRET is never part of any database credential.
 *
 * Modes (owner-credential.ts planDbSetup):
 *   - BOOTSTRAP (the bundled db's superuser, or a client's admin URL — the latter a Crewflow addition, required by RLS):
 *       password file present  -> its password; crewflow_owner created only if missing; an existing crewflow_owner must log
 *                                 in with it (else REFUSED 64: delete the password file and start again with the admin
 *                                 address; never an automatic reset); only a missing grant is added;
 *       password file missing  -> a NEW crypto-random password, stored exclusively as the pending `owner-password.next`
 *                                 BEFORE the transaction; then crewflow_owner created, or (it exists: the file was lost) its
 *                                 password reset through Q4c (Crewflow addition A4; Twenty would leave the app unable to log
 *                                 in); the pending file becomes `owner-password` only after the COMMIT and a login with it
 *                                 (security review L1: a run that fails in between never leaves a file the role rejects).
 *   - OWNER-URL (an existing crewflow_owner URL): O1 + Q2 and the read-only refusals only, on a session logged in with the
 *     URL's own password; that password is copied into the file. Never a write to the database, never a password change.
 *
 * Admin session: application_name crewflow-owner-bootstrap, retried for up to 60 s on connection-refused / 57P03; every
 * connection pinned (H1: search_path=pg_catalog,pg_temp). Q0, Q1, Q2, the refusals (§3.3 + H1/N1/N2), the probe (Q3) with
 * the stored password, and only when something is missing the write transaction (Q4a lock; facts + probe again under the
 * lock; Q4b inputs as bind parameters; Q4c DO block, text unchanged; Q4d re-verify), COMMIT, the probe again (must succeed)
 * and Q2 again (must be exact), else exit 70.
 *
 * Exit codes: 0 ok, 64 refusal (configuration / rights / a privileged crewflow_owner / a stale password file), 70 unexpected.
 * Output: fixed strings plus a SQLSTATE at most. Never a URL, a password, a verifier, a host, a database or a login name,
 * and never a driver error's message / detail / where. The plaintext password exists only in this process's memory and in
 * the password file; the server only ever receives the SCRAM verifier (§3.6).
 */
import { Client } from 'pg';

import { type DbTarget, DbTargetError, dbTargetFromRuntimeUrl } from '../../../owner-login/db-target';
import {
  buildRuntimeDatabaseUrl,
  type DbSetupPlan,
  generateOwnerPassword,
  OWNER_LOGIN,
  OwnerCredentialError,
  planDbSetup,
  scramSha256Verifier,
} from '../../../owner-login/owner-credential';
import { type OwnerPasswordRead, OwnerPasswordFileError } from '../../../owner-login/owner-password-file';
import { pgClientConfig, PgConfigError, PgDriverConfig, readPrimaryDatabaseUrl, resolvePgEnvironment, ResolvedPgEnvironment, sameTarget } from '../../../postgres';
import {
  OWNER_BOOTSTRAP_BEGIN,
  OWNER_BOOTSTRAP_COMMIT,
  OWNER_BOOTSTRAP_Q0_SESSION,
  OWNER_BOOTSTRAP_Q1_SUPERUSER_LOGGING,
  OWNER_BOOTSTRAP_Q2_FACTS,
  OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES,
  OWNER_BOOTSTRAP_Q3_PROBE,
  OWNER_BOOTSTRAP_Q4A_LOCK,
  OWNER_BOOTSTRAP_Q4B_SET_INPUTS,
  OWNER_BOOTSTRAP_Q4C_DO,
  OWNER_BOOTSTRAP_Q4D_REVERIFY,
  OWNER_BOOTSTRAP_ROLLBACK,
  OWNER_SELF_O1_SESSION,
  BOOTSTRAP_SESSION_STARTUP_OPTIONS,
  OWNER_URL_SESSION_STARTUP_OPTIONS,
} from './owner-bootstrap-sql';

export const OWNER_BOOTSTRAP_EXIT = Object.freeze({ ok: 0, refused: 64, unexpected: 70 } as const);
export const OWNER_BOOTSTRAP_RESULT_PREFIX = 'OWNER_BOOTSTRAP_RESULT';
export const OWNER_BOOTSTRAP_LOG_PREFIX = '[owner-bootstrap]';
export const OWNER_BOOTSTRAP_APPLICATION_NAME = 'crewflow-owner-bootstrap';
export const OWNER_PROBE_APPLICATION_NAME = 'crewflow-owner-bootstrap-probe';
export const MIN_SERVER_VERSION_NUM = 160000;
/** How long the admin connection is retried on connection-refused / 57P03 (OpenShip drops depends_on conditions). */
export const ADMIN_CONNECT_RETRY_WINDOW_MS = 60_000;
export const ADMIN_CONNECT_RETRY_INTERVAL_MS = 2_000;
/**
 * Races between two DATABASES of one cluster (the advisory lock is per database, roles are cluster-wide): a concurrent
 * CREATE ROLE (42710 / 23505), a concurrent ALTER ROLE / GRANT on the same catalog row ("tuple concurrently updated",
 * XX000: the DO block keeps only the SQLSTATE), a serialization failure or deadlock (40001 / 40P01). The transaction is
 * rolled back and the attempt re-runs from the facts and the probe, so a role another start just finished needs nothing.
 */
export const MAX_ATTEMPTS = 3;
export const RACE_SQLSTATES: ReadonlySet<string> = new Set(['42710', '23505', 'XX000', '40001', '40P01']);

/**
 * Security review M2: a provider that refuses a pre-hashed (SCRAM verifier) password, the only form the bootstrap ever sends,
 * is NOT supported (D6: no plaintext path). The refusal says so and offers no workaround.
 */
const PREHASHED_REFUSED_UNSUPPORTED = 'If this provider refuses pre-hashed passwords, this configuration is not supported.';

/** Every fixed line this module can print (tests assert them exactly). */
export const OWNER_BOOTSTRAP_MESSAGES = Object.freeze({
  passThrough: 'PG_DATABASE_URL is the crewflow_owner login: checking it (read-only) and storing its password for the API and the Worker; the database is not changed.',
  ownerNotSelf: 'The PG_DATABASE_URL session is not crewflow_owner itself (session_user and current_user must both be crewflow_owner). Refusing.',
  ownerNoDbGrant:
    'crewflow_owner lacks CONNECT, CREATE, TEMPORARY WITH GRANT OPTION on this database (01-crewflow-owner.sql grants it). Grant it as the database owner, or put the database admin URL in PG_DATABASE_URL. Refusing.',
  passwordFileStale:
    'The stored crewflow_owner password does not log in. Delete the password file and start again with the admin address in PG_DATABASE_URL. Refusing.',
  passwordFileLost:
    'No crewflow_owner password file: a new random password is stored as a pending file before any database change, and becomes the password file only after it logs in.',
  passwordFileWriteFailed: (code: string) => `Storing the crewflow_owner password file failed (${code}); nothing was changed in the database.`,
  passwordFileRace:
    'A pending crewflow_owner password file appeared while this run was starting (another db-setup at the same moment?); nothing was changed in the database. Start again.',
  pendingPromoted: 'A pending new crewflow_owner password from an earlier run logs in; it is now the stored password.',
  pendingDiscarded: 'A pending new crewflow_owner password from an earlier run that did not complete does not log in; it was deleted.',
  pendingUnusable: 'A pending crewflow_owner password file was not usable; it was deleted.',
  pendingProbeFailed: (sqlstateClass: string) =>
    `Checking a pending new crewflow_owner password failed (SQLSTATE class ${sqlstateClass}); it is kept. Giving up (the restart policy retries).`,
  pendingRemoveFailed: (code: string) => `Deleting a pending crewflow_owner password file failed (${code}); nothing was changed in the database.`,
  passwordPromoteFailed: (code: string) =>
    `crewflow_owner now uses the new password, but making it the stored password failed (${code}); the next start completes it.`,
  pgTooOld: 'PostgreSQL 16 or later is required.',
  ownerInOtherDatabase:
    'The crewflow_owner password file is missing, so its password would be reset, but crewflow_owner owns objects in, or holds a grant on, another database of this PostgreSQL cluster: another Crewflow deployment uses it, and the reset would break that deployment. Crewflow supports one deployment per PostgreSQL cluster when using an admin URL. Restore this deployment\'s password file, or put the crewflow_owner URL in PG_DATABASE_URL. Refusing.',
  ownerOwnsDatabase:
    'crewflow_owner owns this database (directly or through a role it is a member of, e.g. rab_owner after transition-from-separated.sql). The database setup step never runs as the admin in a database the app login owns (it could plant objects the admin session would run). Put the crewflow_owner URL in PG_DATABASE_URL instead of the admin URL (db-setup then runs as crewflow_owner itself). Refusing.',
  searchPathDefault:
    'A database-wide or crewflow_owner search_path default is set (ALTER DATABASE ... SET search_path / ALTER ROLE crewflow_owner SET search_path). Remove it (ALTER DATABASE ... RESET search_path / ALTER ROLE crewflow_owner RESET search_path). Refusing.',
  privilegedAttributes: (attributes: readonly string[]) =>
    // sql-injection-reviewed: an error MESSAGE (printed, never executed); attributes are the fixed attribute names of the facts row.
    `crewflow_owner exists with ${attributes.join(', ')}; Crewflow never runs as a privileged login. Fix the role (ALTER ROLE crewflow_owner NOSUPERUSER ...) or drop it; the API never changes an existing role's attributes.`,
  noCreateRoleHardened: "crewflow_owner is NOCREATEROLE (hardened); a release that creates roles will need it back.",
  privilegedMembership: 'crewflow_owner is a member of a superuser, BYPASSRLS or predefined privileged role.',
  expired: "crewflow_owner's VALID UNTIL has passed; clear it (ALTER ROLE crewflow_owner VALID UNTIL 'infinity').",
  adminCannotCreateRoles: "The PG_DATABASE_URL login cannot create roles (needs CREATEROLE, or use the provider's admin login).",
  adminCannotGrantDb:
    'The PG_DATABASE_URL login cannot grant CONNECT, CREATE, TEMPORARY on this database (it must own the database or hold those privileges WITH GRANT OPTION).',
  adminNoAdminOption:
    "The crewflow_owner password file is missing, so its password must be reset, but the PG_DATABASE_URL login has no ADMIN OPTION on crewflow_owner (it was created by another login). Run, as that login or a superuser: GRANT crewflow_owner TO <your admin> WITH ADMIN OPTION; or put the crewflow_owner URL in PG_DATABASE_URL. Refusing.",
  adminCannotResetPassword:
    "The crewflow_owner password file is missing, so its password must be reset, but the PG_DATABASE_URL login cannot change another role's password (it needs CREATEROLE and ADMIN OPTION on crewflow_owner, or superuser); or put the crewflow_owner URL in PG_DATABASE_URL. Refusing.",
  probeFailed: (sqlstateClass: string) =>
    `crewflow_owner could not log in for a reason other than its password (SQLSTATE class ${sqlstateClass}); check pg_hba.conf and the role. Refusing.`,
  sessionRoleOption: 'PG_DATABASE_URL carries options=-c role=...; the database setup step connects as the URL login itself. Remove it. Refusing.',
  adminAuth: (sqlstate: string) =>
    `The database refused the PG_DATABASE_URL login (SQLSTATE ${sqlstate}: wrong password, or pg_hba.conf does not allow it). Refusing.`,
  adminNoDatabase:
    'The database named in PG_DATABASE_URL does not exist (SQLSTATE 3D000). db-setup never creates a database: create it at your provider (the bundled db creates its own), then start again. Refusing.',
  adminTls: 'TLS to the database failed (certificate, host name, or the server has no TLS). Check sslmode in PG_DATABASE_URL and PG_SSL_CA_CERT_PATH. Refusing.',
  adminUnreachable: 'The database did not accept a connection within 60 s. Giving up (the restart policy retries).',
  adminConnectFailed: (code: string) => `Connecting with PG_DATABASE_URL failed (${code}).`,
  writeRefused: (sqlstate: string) =>
    `The database refused to create or update crewflow_owner (SQLSTATE ${sqlstate}): the PG_DATABASE_URL login lacks a needed right, or the provider refuses pre-hashed passwords. ${PREHASHED_REFUSED_UNSUPPORTED} Refusing.`,
  writeFailed: (sqlstate: string) => `Setting up crewflow_owner failed (SQLSTATE ${sqlstate}). Nothing was committed.`,
  reverifyFailed: 'crewflow_owner is not exactly as required after the setup step (attributes, grant or login). Refusing to continue.',
  raceRetry: 'crewflow_owner was being created by another start at the same moment; reading the facts again.',
  raceExhausted: 'crewflow_owner kept changing while this start tried to set it up. Giving up (the restart policy retries).',
  unexpected: (code: string) => `Unexpected failure (${code}). Nothing secret is printed; see the database log for the SQLSTATE.`,
  ready: (what: string) => `crewflow_owner is ready (${what}).`,
  targetPublished: 'The database target (host, port, database, TLS parameters; no credential) was published for the API and the Worker.',
  targetPublishFailed: (code: string) => `Publishing the database target failed (${code}); the API and the Worker keep waiting.`,
  targetWithdrawFailed: (code: string) => `Removing the previous database target failed (${code}); the API and the Worker may start on it.`,
});

export type OwnerBootstrapOutcome = 'pass-through' | 'unchanged' | 'created' | 'updated' | 'refused' | 'failed';

export interface OwnerBootstrapResult {
  outcome: OwnerBootstrapOutcome;
  exitCode: 0 | 64 | 70;
  created: boolean;
  passwordSet: boolean;
  grantAdded: boolean;
  /** Only a SQLSTATE (or a Node error code); never a message. */
  code: string | null;
}

/** Exit 64. The message is one of OWNER_BOOTSTRAP_MESSAGES (or a factory PgConfigError message, credential-free by contract). */
export class OwnerBootstrapRefusal extends Error {
  constructor(message: string, readonly code: string | null = null) {
    super(message);
    this.name = 'OwnerBootstrapRefusal';
  }
}

/** Exit 70. */
export class OwnerBootstrapFailure extends Error {
  constructor(message: string, readonly code: string | null = null) {
    super(message);
    this.name = 'OwnerBootstrapFailure';
  }
}

/** Q2, typed. */
export interface OwnerFacts {
  serverVersionNum: number;
  adminSuper: boolean;
  adminCreateRole: boolean;
  adminCanGrantDb: boolean;
  ownerExists: boolean;
  oLogin: boolean | null;
  oSuper: boolean | null;
  oBypassRls: boolean | null;
  oReplication: boolean | null;
  oCreateDb: boolean | null;
  oCreateRole: boolean | null;
  oInherit: boolean | null;
  oExpired: boolean | null;
  adminHasAdminOption: boolean;
  oPrivilegedMemberships: number | null;
  oHasDbGrant: boolean;
  /** H1 / N2: crewflow_owner owns the current database, directly or through any role membership (MEMBER). */
  oOwnsDb: boolean;
  /** H1: a database-wide or crewflow_owner-level search_path default exists. */
  searchPathDefaultSet: boolean;
}

type Row = Record<string, unknown>;


/** Security re-review N4: a fact column that is not a boolean is a failure (70), never silently `false`. */
function strictBool(row: Row, column: string): boolean {
  const v = row[column];
  if (typeof v !== 'boolean') throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected(`facts column ${column} is not a boolean`));
  return v;
}

/** The same for a column that is NULL when crewflow_owner does not exist. */
function strictBoolOrNull(row: Row, column: string): boolean | null {
  const v = row[column];
  if (v === null) return null;
  if (typeof v !== 'boolean') throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected(`facts column ${column} is not a boolean`));
  return v;
}

export function factsFromRow(row: Row | undefined): OwnerFacts {
  if (!row) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('facts query returned no row'));
  const count = row.o_privileged_memberships;
  if (!(count === null || (typeof count === 'string' && /^[0-9]+$/.test(count)) || (typeof count === 'number' && Number.isInteger(count) && count >= 0))) {
    throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('facts column o_privileged_memberships is not a count'));
  }
  const version = Number(row.server_version_num);
  if (!Number.isInteger(version) || version <= 0) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('facts column server_version_num is not a number'));
  return {
    serverVersionNum: version,
    adminSuper: strictBool(row, 'admin_super'),
    adminCreateRole: strictBool(row, 'admin_createrole'),
    adminCanGrantDb: strictBool(row, 'admin_can_grant_db'),
    ownerExists: strictBool(row, 'owner_exists'),
    oLogin: strictBoolOrNull(row, 'o_login'),
    oSuper: strictBoolOrNull(row, 'o_super'),
    oBypassRls: strictBoolOrNull(row, 'o_bypassrls'),
    oReplication: strictBoolOrNull(row, 'o_replication'),
    oCreateDb: strictBoolOrNull(row, 'o_createdb'),
    oCreateRole: strictBoolOrNull(row, 'o_createrole'),
    oInherit: strictBoolOrNull(row, 'o_inherit'),
    // NULL when crewflow_owner is missing (rolvaliduntil IS NOT NULL AND ... on a NULL row).
    oExpired: strictBoolOrNull(row, 'o_expired'),
    adminHasAdminOption: strictBool(row, 'admin_has_admin_option'),
    oPrivilegedMemberships: count === null ? null : Number(count),
    oHasDbGrant: strictBool(row, 'o_has_db_grant'),
    oOwnsDb: strictBool(row, 'o_owns_db'),
    searchPathDefaultSet: strictBool(row, 'search_path_default_set'),
  };
}

/** Attribute names (fixed words) that make an existing crewflow_owner unacceptable. */
export function privilegedAttributesOf(f: OwnerFacts): string[] {
  if (!f.ownerExists) return [];
  const out: string[] = [];
  if (f.oSuper) out.push('SUPERUSER');
  if (f.oBypassRls) out.push('BYPASSRLS');
  if (f.oReplication) out.push('REPLICATION');
  if (f.oCreateDb) out.push('CREATEDB');
  if (f.oLogin === false) out.push('NOLOGIN');
  if (f.oInherit === false) out.push('NOINHERIT');
  return out;
}

/**
 * §3.3, the checks that need no probe, in the plan's order. Throws OwnerBootstrapRefusal; returns the notes to log
 * (D2: an existing NOCREATEROLE crewflow_owner is accepted — the documented hardening — with one line).
 */
export function decideBeforeProbe(f: OwnerFacts): string[] {
  const notes: string[] = [];
  if (!(f.serverVersionNum >= MIN_SERVER_VERSION_NUM)) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.pgTooOld);
  const privileged = privilegedAttributesOf(f);
  if (privileged.length > 0) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.privilegedAttributes(privileged));
  // H1 (defence in depth beside the pinned search_path): the admin session never works in a database the app login owns,
  // nor under a planted search_path default. After the attribute refusal, so a SUPERUSER crewflow_owner (a member of every
  // role, the owner included) is named as such.
  if (f.oOwnsDb) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.ownerOwnsDatabase);
  if (f.searchPathDefaultSet) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.searchPathDefault);
  if (f.ownerExists && f.oCreateRole === false) notes.push(OWNER_BOOTSTRAP_MESSAGES.noCreateRoleHardened);
  if (f.ownerExists && (f.oPrivilegedMemberships ?? 0) > 0) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.privilegedMembership);
  if (f.ownerExists && f.oExpired === true) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.expired);
  if (!f.ownerExists && !(f.adminSuper || f.adminCreateRole)) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminCannotCreateRoles);
  if (!f.oHasDbGrant && !f.adminCanGrantDb) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminCannotGrantDb);
  return notes;
}

export type ProbeResult = { ok: true } | { ok: false; code: string };

export interface WritePlan {
  /** Run the write transaction at all. */
  write: boolean;
  create: boolean;
  needPassword: boolean;
  needGrant: boolean;
}

/**
 * Where this run's crewflow_owner password comes from: `file` = db-setup's password file (the normal start); `new` = the file
 * was missing, so a fresh random password was generated (it is stored before any database write).
 */
export type PasswordSource = 'file' | 'new';

/**
 * §3.4 + the last row of §3.3, the Helm way. `probe` (Q3 with this run's password) is null when the role does not exist, or
 * when the password is `new` (nothing to probe: it cannot match yet).
 *   role missing                              => CREATE ROLE with this run's password;
 *   `file`, probe ok                          => the password is right; never touched (Twenty: an existing user is skipped);
 *   `file`, 28P01                             => REFUSED (64): the stored password no longer logs in; never an automatic reset;
 *   `file`, 42501 while the grant is missing  => CONNECT is not granted yet: add only the grant (the probe after COMMIT
 *                                                decides; a 28P01 then is the same refusal);
 *   `file`, anything else                     => refused with the SQLSTATE class only;
 *   `new`, role exists                        => A4 (Crewflow addition): reset its password to the new one (needs superuser,
 *                                                or CREATEROLE + ADMIN OPTION).
 */
export function planWrite(f: OwnerFacts, probe: ProbeResult | null, source: PasswordSource = 'file'): WritePlan {
  const create = !f.ownerExists;
  let needPassword = create;
  if (!create) {
    if (source === 'new') needPassword = true;
    else {
      if (!probe) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('no probe for an existing role'));
      if (!probe.ok) {
        if (probe.code === '28P01') throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.passwordFileStale, probe.code);
        if (!(probe.code === '42501' && !f.oHasDbGrant)) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.probeFailed(sqlstateClass(probe.code)), probe.code);
      }
    }
    if (needPassword) {
      if (!f.adminHasAdminOption) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminNoAdminOption);
      if (!f.adminSuper && !f.adminCreateRole) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminCannotResetPassword);
    }
  }
  const needGrant = !f.oHasDbGrant;
  return { write: create || needPassword || needGrant, create, needPassword, needGrant };
}

/** After COMMIT, Q2 again: the role must now be exactly right (fail closed, exit 70). */
export function assertFactsExact(f: OwnerFacts): void {
  const ok =
    f.ownerExists &&
    privilegedAttributesOf(f).length === 0 &&
    (f.oPrivilegedMemberships ?? 0) === 0 &&
    f.oExpired !== true &&
    f.oHasDbGrant;
  if (!ok) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed);
}

/** A 5-character SQLSTATE's class ("28" for 28P01), or "??" for anything that is not a SQLSTATE. */
export function sqlstateClass(code: string | null | undefined): string {
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code.slice(0, 2) : '??';
}

/** The driver/Node error code only (SQLSTATE or E*), sanitised; never the message. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Za-z_]{1,40}$/.test(code) ? code : 'no-code';
}

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

export function isTlsError(error: unknown): boolean {
  if (TLS_ERROR_CODES.has(errorCode(error))) return true;
  const message = error instanceof Error ? error.message : '';
  // pg's own fixed text when the server answers 'N' to SSLRequest (no value in it; only matched, never printed).
  return message === 'The server does not support SSL connections';
}

const RETRYABLE_CONNECT_CODES = new Set(['ECONNREFUSED', 'EAI_AGAIN', '57P03']);

/** Maps an admin-connection failure to a refusal (64) or a failure (70). */
export function classifyAdminConnectError(error: unknown, retriesExhausted: boolean): OwnerBootstrapRefusal | OwnerBootstrapFailure {
  const code = errorCode(error);
  if (code === '28P01' || code === '28000') return new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminAuth(code), code);
  if (code === '3D000') return new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminNoDatabase, code);
  if (isTlsError(error)) return new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminTls, code);
  if (retriesExhausted && RETRYABLE_CONNECT_CODES.has(code)) return new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.adminUnreachable, code);
  return new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.adminConnectFailed(code), code);
}

/** The write transaction's failure: a privilege / provider refusal (64), a race (retried by the caller), else 70. */
export function classifyWriteError(error: unknown): OwnerBootstrapRefusal | OwnerBootstrapFailure | 'race' {
  // A decision taken under the lock (it may carry a probe SQLSTATE such as 42501) keeps its own message.
  if (error instanceof OwnerBootstrapRefusal || error instanceof OwnerBootstrapFailure) return error;
  const code = errorCode(error);
  if (RACE_SQLSTATES.has(code)) return 'race';
  if (code === '42501' || code === '22023' || code === '28P01') return new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.writeRefused(code), code);
  return new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.writeFailed(code), code);
}

export interface SqlSession {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}

export interface OwnerBootstrapIo {
  /** Opens one admin session (one attempt; the runner retries). */
  openAdmin(): Promise<SqlSession>;
  /** Q3 as crewflow_owner with this run's password; resolves to ok, or the error code. */
  probeOwner(): Promise<ProbeResult>;
  /** A fresh SCRAM verifier of this run's password. */
  verifier(): string;
  /** Where this run's password comes from (default `file`). */
  passwordSource?: PasswordSource;
  /**
   * `new` only: stores this run's NEW password exclusively as the PENDING file `owner-password.next` (never over
   * `owner-password`; EEXIST when one is already there). Called once the refusals passed and a write is needed, always BEFORE
   * the transaction. A crash or failure after it leaves `owner-password` untouched; the role keeps its old password (nothing
   * committed) or already has the new one (committed). The next start tells the two apart by logging in with the pending
   * password: it logs in -> promoted; it does not (28P01) -> deleted (resolveStoredPassword). A throw stops the run with
   * nothing changed in the database.
   */
  persistPassword?(): void;
  /** Set by attempt() once persistPassword succeeded (race retries do not store it again). */
  passwordPersisted?: boolean;
  /**
   * `new` only: renames the pending file over `owner-password` (security review L1). Called only after the COMMIT and a
   * successful post-commit login with the new password. A throw is exit 70; the next start promotes it.
   */
  promotePassword?(): void;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

async function closeQuietly(session: SqlSession | null): Promise<void> {
  if (!session) return;
  try {
    await session.end();
  } catch {
    /* already closed */
  }
}

async function connectAdminWithRetry(io: OwnerBootstrapIo, windowMs: number): Promise<SqlSession> {
  const deadline = io.now() + windowMs;
  for (;;) {
    try {
      return await io.openAdmin();
    } catch (error) {
      const code = errorCode(error);
      const retryable = RETRYABLE_CONNECT_CODES.has(code);
      if (!retryable || io.now() + ADMIN_CONNECT_RETRY_INTERVAL_MS > deadline) throw classifyAdminConnectError(error, retryable);
      await io.sleep(ADMIN_CONNECT_RETRY_INTERVAL_MS);
    }
  }
}

async function readFacts(session: SqlSession): Promise<OwnerFacts> {
  const { rows } = await session.query(OWNER_BOOTSTRAP_Q2_FACTS);
  return factsFromRow(rows[0]);
}

/**
 * Security review L4 (owner-approved, read-only): before an A4 reset, Q2b. Refused (64) when crewflow_owner is used by
 * another database of the cluster. Strict: anything but one boolean row is a failure (70).
 */
async function assertNoOtherDatabase(session: SqlSession): Promise<void> {
  const { rows } = await session.query(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES);
  const v = rows.length === 1 ? rows[0]?.o_other_database : undefined;
  if (typeof v !== 'boolean') throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('other-database fact'));
  if (v) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.ownerInOtherDatabase);
}

/** The facts, the decisions and the probe, in that order: one plan of what the write transaction must do. */
async function planFromDatabase(session: SqlSession, io: OwnerBootstrapIo, logNotes: boolean): Promise<WritePlan> {
  const facts = await readFacts(session);
  const notes = decideBeforeProbe(facts);
  if (logNotes) for (const note of notes) io.log(note);
  const source = io.passwordSource ?? 'file';
  // L4: an A4 reset (a new password for an existing role) never runs while another database of the cluster uses the role.
  if (source === 'new' && facts.ownerExists) await assertNoOtherDatabase(session);
  const probe = facts.ownerExists && source === 'file' ? await io.probeOwner() : null;
  return planWrite(facts, probe, source);
}

const UNCHANGED: OwnerBootstrapResult = { outcome: 'unchanged', exitCode: 0, created: false, passwordSet: false, grantAdded: false, code: null };

/**
 * One attempt. The facts are read twice: once WITHOUT the lock (a restart with everything in place opens no transaction at
 * all), and again UNDER the advisory lock, after any concurrent start on this database has committed. Only the post-lock
 * plan decides what is written AND the outcome reported: a second replica that started at the same moment as the first
 * reports what it really did ("unchanged", or "password set"), never the "created" its pre-lock read suggested.
 * Returns 'race' when a concurrent start on another database of the cluster collided (re-run from the facts).
 */
async function attempt(session: SqlSession, io: OwnerBootstrapIo): Promise<OwnerBootstrapResult | 'race'> {
  const preLock = await planFromDatabase(session, io, true);
  if (!preLock.write) return { ...UNCHANGED };
  // A new password reaches the file BEFORE anything is written to the database, once per run (race retries reuse it).
  if ((io.passwordSource ?? 'file') === 'new' && io.persistPassword && !io.passwordPersisted) {
    try {
      io.persistPassword();
      io.passwordPersisted = true;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.passwordFileRace, 'EEXIST');
      throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.passwordFileWriteFailed(errorCode(error)), errorCode(error));
    }
  }

  let plan: WritePlan;
  await session.query(OWNER_BOOTSTRAP_BEGIN);
  try {
    await session.query(OWNER_BOOTSTRAP_Q4A_LOCK);
    plan = await planFromDatabase(session, io, false);
    if (!plan.write) {
      await session.query(OWNER_BOOTSTRAP_ROLLBACK);
      return { ...UNCHANGED };
    }
    // Only computed when it is needed; never sent when the password stays (an empty value, unused by the DO block).
    const verifier = plan.needPassword ? io.verifier() : '';
    await session.query(OWNER_BOOTSTRAP_Q4B_SET_INPUTS, [verifier, plan.needPassword ? 'true' : 'false']);
    await session.query(OWNER_BOOTSTRAP_Q4C_DO);
    const { rows } = await session.query(OWNER_BOOTSTRAP_Q4D_REVERIFY);
    if (rows.length !== 1 || rows[0]?.ok !== true) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed);
    await session.query(OWNER_BOOTSTRAP_COMMIT);
  } catch (error) {
    await session.query(OWNER_BOOTSTRAP_ROLLBACK).catch(() => undefined);
    const classified = classifyWriteError(error);
    if (classified === 'race') return 'race';
    throw classified;
  }

  const after = await io.probeOwner();
  if (!after.ok) {
    // Only the grant was added (the stored password could not be checked before): a wrong stored password is the refusal.
    if (after.code === '28P01' && !plan.needPassword) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.passwordFileStale, after.code);
    throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed, after.code);
  }
  assertFactsExact(await readFacts(session));
  // Security review L1: only now (COMMIT + a login with it) does the new password become the stored password.
  if (io.passwordPersisted && io.promotePassword) {
    try {
      io.promotePassword();
    } catch (error) {
      throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.passwordPromoteFailed(errorCode(error)), errorCode(error));
    }
  }
  return {
    outcome: plan.create ? 'created' : 'updated',
    exitCode: 0,
    created: plan.create,
    passwordSet: plan.needPassword,
    grantAdded: plan.needGrant,
    code: null,
  };
}

/** The admin / bundled mode on an already-known password. Exported for the integration harness and the unit tests. */
export async function bootstrapOwnerWithIo(io: OwnerBootstrapIo, retryWindowMs = ADMIN_CONNECT_RETRY_WINDOW_MS): Promise<OwnerBootstrapResult> {
  let session: SqlSession | null = null;
  try {
    session = await connectAdminWithRetry(io, retryWindowMs);
    await session.query(OWNER_BOOTSTRAP_Q0_SESSION);
    await session.query(OWNER_BOOTSTRAP_Q1_SUPERUSER_LOGGING);
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const result = await attempt(session, io);
      if (result !== 'race') return result;
      if (i < MAX_ATTEMPTS) {
        io.log(OWNER_BOOTSTRAP_MESSAGES.raceRetry);
        await io.sleep(200 + Math.floor(Math.random() * 500)); // jitter, so two colliding starts do not collide again
      }
    }
    throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.raceExhausted);
  } finally {
    await closeQuietly(session);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The OWNER-URL mode: PG_DATABASE_URL names an existing crewflow_owner. Twenty runs no setup step for an external database
// (secret-db-url.yaml:24-30); Crewflow keeps the read-only RLS refusals: log in with the URL's own password, pin the
// session (Q0), O1 + Q2, refuse anything privileged. NEVER a write to the database, never a password change.
// ---------------------------------------------------------------------------------------------------------------------

export interface OwnerUrlIo {
  /** A session as crewflow_owner with the URL's own password (one attempt). */
  openUrl(): Promise<SqlSession>;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface OwnerSessionFacts {
  sessionLogin: string;
  currentLogin: string;
}

/** The refusals of the owner-URL mode, on a session that should be crewflow_owner itself. Throws OwnerBootstrapRefusal; returns notes. */
export function decideOwnerSelf(session: OwnerSessionFacts, f: OwnerFacts): string[] {
  const notes: string[] = [];
  if (!(f.serverVersionNum >= MIN_SERVER_VERSION_NUM)) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.pgTooOld);
  if (session.sessionLogin !== OWNER_LOGIN || session.currentLogin !== session.sessionLogin) {
    throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.ownerNotSelf);
  }
  if (!f.ownerExists) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('crewflow_owner session without a crewflow_owner role'));
  const privileged = privilegedAttributesOf(f);
  if (privileged.length > 0) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.privilegedAttributes(privileged));
  if (f.oCreateRole === false) notes.push(OWNER_BOOTSTRAP_MESSAGES.noCreateRoleHardened);
  if ((f.oPrivilegedMemberships ?? 0) > 0) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.privilegedMembership);
  if (f.oExpired === true) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.expired);
  if (!f.oHasDbGrant) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.ownerNoDbGrant);
  return notes;
}

async function readOwnerSelf(session: SqlSession): Promise<{ who: OwnerSessionFacts; facts: OwnerFacts }> {
  const { rows } = await session.query(OWNER_SELF_O1_SESSION);
  const row = rows[0];
  const who = { sessionLogin: String(row?.session_login ?? ''), currentLogin: String(row?.current_login ?? '') };
  return { who, facts: await readFacts(session) };
}

async function connectWithRetry(open: () => Promise<SqlSession>, io: Pick<OwnerUrlIo, 'sleep' | 'now'>, windowMs: number): Promise<SqlSession> {
  const deadline = io.now() + windowMs;
  for (;;) {
    try {
      return await open();
    } catch (error) {
      const code = errorCode(error);
      if (!RETRYABLE_CONNECT_CODES.has(code) || io.now() + ADMIN_CONNECT_RETRY_INTERVAL_MS > deadline) throw error;
      await io.sleep(ADMIN_CONNECT_RETRY_INTERVAL_MS);
    }
  }
}

const OWNER_URL_UNCHANGED: OwnerBootstrapResult = { outcome: 'pass-through', exitCode: 0, created: false, passwordSet: false, grantAdded: false, code: null };

/** The owner-URL mode: read-only. Q0, O1, Q2, the refusals. Exported for the unit tests. */
export async function setupOwnerUrlWithIo(io: OwnerUrlIo, retryWindowMs = ADMIN_CONNECT_RETRY_WINDOW_MS): Promise<OwnerBootstrapResult> {
  let session: SqlSession | null = null;
  try {
    try {
      session = await connectWithRetry(() => io.openUrl(), io, retryWindowMs);
    } catch (error) {
      throw classifyAdminConnectError(error, RETRYABLE_CONNECT_CODES.has(errorCode(error)));
    }
    await session.query(OWNER_BOOTSTRAP_Q0_SESSION);
    const { who, facts } = await readOwnerSelf(session);
    for (const note of decideOwnerSelf(who, facts)) io.log(note);
    return { ...OWNER_URL_UNCHANGED };
  } finally {
    await closeQuietly(session);
  }
}

function describeReady(result: OwnerBootstrapResult): string {
  if (result.outcome === 'pass-through') return 'existing crewflow_owner URL, unchanged; its password stored';
  if (result.created) return 'created';
  const parts: string[] = [];
  if (result.passwordSet) parts.push('password reset because the password file was missing (Crewflow addition)');
  if (result.grantAdded) parts.push('database grant added');
  return parts.length > 0 ? parts.join(', ') : 'unchanged';
}

export function failureResult(error: unknown): OwnerBootstrapResult {
  if (error instanceof OwnerBootstrapRefusal) {
    return { outcome: 'refused', exitCode: 64, created: false, passwordSet: false, grantAdded: false, code: error.code };
  }
  const code = error instanceof OwnerBootstrapFailure ? error.code : errorCode(error);
  return { outcome: 'failed', exitCode: 70, created: false, passwordSet: false, grantAdded: false, code };
}

/** The one place a connection is constructed here: the factory's explicit config, with this step's fixed application_name. */
function openClient(config: PgDriverConfig): Client {
  return new Client(config);
}

/** H1: every bootstrap connection carries the fixed session pin (search_path, read-write) as startup options. */
function pinned(config: PgDriverConfig, startupOptions: string = BOOTSTRAP_SESSION_STARTUP_OPTIONS): PgDriverConfig {
  const options = [config.options, startupOptions].filter((o) => typeof o === 'string' && o !== '').join(' ');
  return { ...config, options };
}

/**
 * Every driver config the bootstrap child uses: the URL's own login as the admin (bootstrap mode), the same login as
 * crewflow_owner in the owner-URL mode (`ownerUrl`: READ-ONLY, security review I1), and the crewflow_owner probe with this
 * run's password, each pinned (H1). Exported for the spec that asserts the pin is on all of them.
 */
export function bootstrapDriverConfigs(
  resolved: ResolvedPgEnvironment,
  runtimeUrl: string,
): { admin: PgDriverConfig; ownerUrl: PgDriverConfig; probe: PgDriverConfig } {
  const urlLogin: PgDriverConfig = {
    ...pgClientConfig(resolved, {
      endpoint: 'primary',
      purpose: 'owner-bootstrap',
      sessionAffinity: true,
      statementTimeoutMs: 30_000,
      queryTimeoutMs: 35_000,
      idleInTransactionTimeoutMs: 60_000,
      connectTimeoutMs: 10_000,
    }),
    application_name: OWNER_BOOTSTRAP_APPLICATION_NAME,
  };
  const admin = pinned(urlLogin);
  const ownerUrl = pinned(urlLogin, OWNER_URL_SESSION_STARTUP_OPTIONS);
  const probe = pinned({
    ...pgClientConfig(resolved, {
      url: runtimeUrl,
      urlLabel: 'the crewflow_owner connection',
      purpose: 'owner-probe',
      sessionAffinity: true,
      statementTimeoutMs: 10_000,
      queryTimeoutMs: 15_000,
      connectTimeoutMs: 10_000,
    }),
    application_name: OWNER_PROBE_APPLICATION_NAME,
  });
  return { admin, ownerUrl, probe };
}

/** One connected session (one attempt; the callers retry). */
async function connectSession(config: PgDriverConfig): Promise<SqlSession> {
  const client = openClient(config);
  client.on('error', () => undefined); // a dropped idle connection must not crash the process with its message
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return client as unknown as SqlSession;
}

/**
 * db-setup's two password files (owner-password-file.ts on the entry's paths; security review L1): `owner-password` (main)
 * and the pending `owner-password.next`. None of them logs.
 */
export interface OwnerPasswordFiles {
  readMain(): OwnerPasswordRead;
  readNext(): OwnerPasswordRead;
  /** Atomically replaces `owner-password` (owner-URL mode only). */
  writeMain(password: string): void;
  /** Creates `owner-password.next` exclusively (EEXIST when it exists). */
  writeNextExclusive(password: string): void;
  /** Renames `owner-password.next` over `owner-password`. */
  promoteNext(): void;
  /** Deletes `owner-password.next` (no error when it is gone). */
  removeNext(): void;
}

export type StoredPassword = { source: 'file'; readonly password: string } | { source: 'new' };

function storedFromFile(password: string): StoredPassword {
  const out = { source: 'file' as const } as Extract<StoredPassword, { source: 'file' }>;
  Object.defineProperty(out, 'password', { value: password, enumerable: false });
  return out;
}

/**
 * The bootstrap mode's start (security review L1): settle a pending `owner-password.next` left by an earlier run, then read
 * `owner-password`.
 *   pending file not usable (empty, symlink, FIFO, ...)        -> deleted (it was never the stored password);
 *   pending password authenticates (ok, or 42501: no CONNECT)  -> promoted over `owner-password`; it is this run's password;
 *   pending password does not log in (28P01)                   -> deleted; `owner-password` decides as before;
 *   anything else (unreachable, TLS, pg_hba, ...)              -> failure 70, the pending file is kept for the next start.
 * Then `owner-password`: ready -> `file`; missing -> `new`; anything else wrong -> refusal 64. Exported for the unit tests.
 */
export async function resolveStoredPassword(
  files: OwnerPasswordFiles,
  probeWith: (password: string) => Promise<ProbeResult>,
  io: Pick<OwnerBootstrapIo, 'log' | 'sleep' | 'now'>,
  retryWindowMs = ADMIN_CONNECT_RETRY_WINDOW_MS,
): Promise<StoredPassword> {
  const removeNext = () => {
    try {
      files.removeNext();
    } catch (error) {
      throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.pendingRemoveFailed(errorCode(error)), errorCode(error));
    }
  };
  let pending: OwnerPasswordRead;
  try {
    pending = files.readNext();
  } catch (error) {
    if (!(error instanceof OwnerPasswordFileError)) throw error;
    removeNext();
    io.log(OWNER_BOOTSTRAP_MESSAGES.pendingUnusable);
    pending = { state: 'missing' };
  }
  if (pending.state === 'ready') {
    const deadline = io.now() + retryWindowMs;
    let probe: ProbeResult;
    for (;;) {
      probe = await probeWith(pending.password);
      if (probe.ok || !RETRYABLE_CONNECT_CODES.has(probe.code) || io.now() + ADMIN_CONNECT_RETRY_INTERVAL_MS > deadline) break;
      await io.sleep(ADMIN_CONNECT_RETRY_INTERVAL_MS);
    }
    if (probe.ok || probe.code === '42501') {
      try {
        files.promoteNext();
      } catch (error) {
        throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.passwordPromoteFailed(errorCode(error)), errorCode(error));
      }
      io.log(OWNER_BOOTSTRAP_MESSAGES.pendingPromoted);
      return storedFromFile(pending.password);
    }
    if (probe.code !== '28P01') throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.pendingProbeFailed(sqlstateClass(probe.code)), probe.code);
    removeNext();
    io.log(OWNER_BOOTSTRAP_MESSAGES.pendingDiscarded);
  }
  let stored: OwnerPasswordRead;
  try {
    stored = files.readMain();
  } catch (error) {
    if (error instanceof OwnerPasswordFileError) throw new OwnerBootstrapRefusal(error.message);
    throw error;
  }
  return stored.state === 'missing' ? { source: 'new' } : storedFromFile(stored.password);
}

/** Q3 as crewflow_owner on `config`: ok, or the error code ('TLS' for a TLS failure). One attempt. */
async function probeOwnerOnce(config: PgDriverConfig): Promise<ProbeResult> {
  const client = openClient(config);
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.query(OWNER_BOOTSTRAP_Q3_PROBE);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: isTlsError(error) ? 'TLS' : errorCode(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export interface RunOwnerBootstrapOptions {
  log?: (line: string) => void;
  /** db-setup's password files. Required. */
  passwordFiles?: OwnerPasswordFiles;
  /**
   * Publishes the credential-free database target after a SUCCESSFUL run (the entry writes CREWFLOW_DB_TARGET_FILE
   * atomically). A throw turns the run into a failure (exit 70) and the target is withdrawn.
   */
  publishTarget?: (target: DbTarget) => void;
  /** Removes any stale target after a refusal or failure, so the apps keep waiting. The password file is never removed. */
  withdrawTarget?: () => void;
  /** Test seam (integration harness): a shorter connect-retry window. */
  retryWindowMs?: number;
}

/**
 * The whole step for one environment (the child passes process.env). Never throws: every failure becomes a result with
 * exit code 64 or 70, and the one printed line for it is fixed text. Reads ONLY PG_DATABASE_URL (and the TLS settings);
 * APP_SECRET plays no part.
 */
export async function runOwnerBootstrap(env: Record<string, string | undefined>, options: RunOwnerBootstrapOptions = {}): Promise<OwnerBootstrapResult> {
  const log = options.log ?? (() => undefined);
  try {
    const files = options.passwordFiles;
    if (!files) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('no password file I/O'));
    // The single decision (owner-credential.ts), refused (fixed text) BEFORE anything connects. Only PG_DATABASE_URL.
    const primary = readPrimaryDatabaseUrl(env);
    let plan: DbSetupPlan;
    try {
      plan = planDbSetup(primary?.name === 'PG_DATABASE_URL' ? primary.value : undefined);
    } catch (error) {
      if (error instanceof OwnerCredentialError) throw new OwnerBootstrapRefusal(error.message);
      throw error;
    }
    if (plan.mode === 'owner-url') log(OWNER_BOOTSTRAP_MESSAGES.passThrough);

    let resolved: ResolvedPgEnvironment;
    try {
      // The migrate process role: the same URL policy and TLS as every process, and a transaction-pooler shape is refused
      // (the bootstrap needs one real session). The runtime login check does not apply to this step.
      resolved = resolvePgEnvironment(env, { processRole: 'migrate' });
    } catch (error) {
      if (error instanceof PgConfigError) throw new OwnerBootstrapRefusal(error.message);
      throw error;
    }
    if (resolved.primary.target.sessionRoleOption) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.sessionRoleOption);
    if (!sameTarget(resolved.primary.target, plan.urlTarget)) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('admin target mismatch'));

    const databaseUrl = primary?.value as string;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const now = () => Date.now();
    const retryWindowMs = options.retryWindowMs ?? ADMIN_CONNECT_RETRY_WINDOW_MS;

    // This run's crewflow_owner password: the URL's own (owner-URL mode), the stored one (a pending one from an earlier run
    // settled first: L1), or a new random one (file missing).
    let source: PasswordSource = 'file';
    let ownerPassword: string;
    if (plan.mode === 'owner-url') ownerPassword = plan.ownerPassword;
    else {
      const probeWith = (password: string): Promise<ProbeResult> => {
        let url: string;
        try {
          url = buildRuntimeDatabaseUrl(databaseUrl, password);
        } catch (error) {
          if (error instanceof OwnerCredentialError) throw new OwnerBootstrapRefusal(error.message);
          throw error;
        }
        return probeOwnerOnce(bootstrapDriverConfigs(resolved, url).probe);
      };
      const stored = await resolveStoredPassword(files, probeWith, { log, sleep, now }, retryWindowMs);
      if (stored.source === 'file') ownerPassword = stored.password;
      else {
        source = 'new';
        ownerPassword = generateOwnerPassword();
      }
    }
    let runtimeUrl: string;
    let target: DbTarget;
    try {
      runtimeUrl = buildRuntimeDatabaseUrl(databaseUrl, ownerPassword);
      // Computed BEFORE anything connects: a target that cannot be described credential-free refuses here.
      target = dbTargetFromRuntimeUrl(runtimeUrl, ownerPassword);
    } catch (error) {
      if (error instanceof DbTargetError || error instanceof OwnerCredentialError) throw new OwnerBootstrapRefusal(error.message);
      throw error;
    }

    const { admin: adminConfig, ownerUrl: ownerUrlConfig, probe: probeConfig } = bootstrapDriverConfigs(resolved, runtimeUrl);
    let result: OwnerBootstrapResult;
    if (plan.mode === 'owner-url') {
      // I1: the crewflow_owner session is read-only (default_transaction_read_only=on as a startup option).
      result = await setupOwnerUrlWithIo({ openUrl: () => connectSession(ownerUrlConfig), log, sleep, now }, retryWindowMs);
      // Only after every read-only refusal passed: the URL's password becomes the stored password (the apps read it), and a
      // pending file of the bootstrap mode is dropped. Unchanged when the file already holds it (a restart writes nothing).
      try {
        files.removeNext();
        let current: OwnerPasswordRead = { state: 'missing' };
        try {
          current = files.readMain();
        } catch {
          current = { state: 'missing' }; // an unreadable / invalid file is simply replaced by the URL's password
        }
        if (!(current.state === 'ready' && current.password === ownerPassword)) files.writeMain(ownerPassword);
      } catch (error) {
        throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.passwordFileWriteFailed(errorCode(error)), errorCode(error));
      }
    } else {
      if (source === 'new') log(OWNER_BOOTSTRAP_MESSAGES.passwordFileLost);
      const io: OwnerBootstrapIo = {
        openAdmin: () => connectSession(adminConfig),
        probeOwner: () => probeOwnerOnce(probeConfig),
        verifier: () => scramSha256Verifier(ownerPassword),
        passwordSource: source,
        persistPassword: () => files.writeNextExclusive(ownerPassword),
        promotePassword: () => files.promoteNext(),
        log,
        sleep,
        now,
      };
      result = await bootstrapOwnerWithIo(io, retryWindowMs);
    }
    if (options.publishTarget) {
      try {
        options.publishTarget(target);
      } catch (error) {
        throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.targetPublishFailed(errorCode(error)), errorCode(error));
      }
      log(OWNER_BOOTSTRAP_MESSAGES.targetPublished);
    }
    log(OWNER_BOOTSTRAP_MESSAGES.ready(describeReady(result)));
    return result;
  } catch (error) {
    if (error instanceof OwnerBootstrapRefusal || error instanceof OwnerBootstrapFailure) log(error.message);
    else log(OWNER_BOOTSTRAP_MESSAGES.unexpected(errorCode(error)));
    if (options.withdrawTarget) {
      try {
        options.withdrawTarget();
      } catch (removeError) {
        log(OWNER_BOOTSTRAP_MESSAGES.targetWithdrawFailed(errorCode(removeError)));
      }
    }
    return failureResult(error);
  }
}

/** The one machine-readable line (enums, booleans and a SQLSTATE only). */
export function resultLine(result: OwnerBootstrapResult): string {
  return `${OWNER_BOOTSTRAP_RESULT_PREFIX} ${JSON.stringify(result)}`;
}
