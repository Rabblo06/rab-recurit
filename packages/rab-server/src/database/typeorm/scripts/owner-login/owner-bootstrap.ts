/**
 * Database setup the Twenty way (owner decision 2026-11-18, "change PR #125 option 2 to Twenty's way"): the core of the
 * bootstrap child, run by the one-shot db-setup service, the ONLY holder of PG_ADMIN_URL. Entry: bootstrap-owner-login.ts.
 *
 * Twenty (twentyhq/twenty@eedb0a73, packages/twenty-docker/helm/twenty/templates/):
 *   - server and worker receive PG_DATABASE_URL, the APP user's URL (deployment-server.yaml:148-155,
 *     deployment-worker.yaml:81-88);
 *   - the `ensure-database-exists` init container alone holds the superuser secret and creates the app user WITH THE APP
 *     USER'S OWN PASSWORD (`CREATE USER %I WITH PASSWORD %L`, only if it does not exist; deployment-server.yaml:82-128);
 *   - an external database gets no setup step at all (secret-db-url.yaml:24-45);
 *   - APP_SECRET is never part of any database credential.
 *
 * Modes (owner-credential.ts selectDbSetupInput). PG_DATABASE_URL (crewflow_owner) is ALWAYS given: it is the very URL
 * rab-api and rab-worker use.
 *   - BOOTSTRAP, PG_ADMIN_URL + PG_DATABASE_URL (a: the bundled db's superuser; b: your database's admin):
 *       crewflow_owner missing                   -> created with the password inside PG_DATABASE_URL (SCRAM verifier only);
 *       exists, that password logs in            -> never touched (only a missing database grant is added);
 *       exists, that password does not log in    -> (28P01) the password is SET to it with the admin login, after the same
 *                                                   safety checks as before: not used by another database of the cluster
 *                                                   (Q2b), the admin holds ADMIN OPTION and CREATEROLE (or is superuser);
 *       then the CREATEROLE step (below).
 *   - OWNER-URL, PG_DATABASE_URL only (c): O1 + Q2 + the ledger and the read-only refusals only, logged in with the URL's own
 *     password. Never a write to the database, never a password change; a password that does not log in is refused.
 *
 * The CREATEROLE step (modes a and b; owner decision 2026-11-18): crewflow_owner needs CREATEROLE only for the schema
 * bootstrap (the first start's migrate child creates the schema roles). On a read-only crewflow_owner session the ledger is
 * compared with this image's migration files: when every one of them is applied (the schema is complete: CURRENT, or
 * AHEAD after a rollback), the admin runs ALTER ROLE crewflow_owner NOCREATEROLE (and removes the pending mark); while it is
 * not complete, a CREATEROLE crewflow_owner is MARKED (COMMENT ON ROLE, OWNER_CREATEROLE_PENDING_COMMENT) so the boot gate
 * accepts it for that first start. db-setup never grants CREATEROLE. Mode c applies the same rule read-only: it refuses
 * what the boot gate would refuse.
 *
 * Every write runs in a transaction that first takes the advisory lock OWNER_BOOTSTRAP_LOCK_KEY and re-reads the facts under
 * it (two db-setup runs on one database never interleave); there is no file and no file lock any more.
 *
 * Admin session: application_name crewflow-owner-bootstrap, retried for up to 60 s on connection-refused / 57P03; every
 * connection pinned (H1: search_path=pg_catalog,pg_temp).
 *
 * Exit codes: 0 ok, 64 refusal (configuration / rights / a privileged crewflow_owner / a password that does not log in
 * without an admin), 70 unexpected. Output: fixed strings plus a SQLSTATE at most. Never a URL, a password, a verifier, a
 * host, a database or a login name, and never a driver error's message / detail / where. The plaintext password exists only
 * in this process's memory (it came from the environment); the server only ever receives the SCRAM verifier (§3.6).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import {
  ADMIN_URL_LABEL,
  type DbSetupInput,
  OWNER_LOGIN,
  OwnerCredentialError,
  scramSha256Verifier,
  selectDbSetupInput,
} from '../../../owner-login/owner-credential';
import { pgClientConfig, PgConfigError, PgDriverConfig, resolvePgEnvironment, ResolvedPgEnvironment, sameTarget } from '../../../postgres';
import { isSupportedPostgresMajor, postgresMajorFromVersionNum, unsupportedPostgresMessage } from '../../../postgres/supported-majors';
import { OWNER_CREATEROLE_PENDING_COMMENT } from '../../../boot-checks/owner-login-posture';
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
  OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT,
  OWNER_BOOTSTRAP_Q4C_DO,
  OWNER_BOOTSTRAP_Q4D_REVERIFY,
  OWNER_BOOTSTRAP_ROLLBACK,
  OWNER_HARDEN_H1_NOCREATEROLE,
  OWNER_HARDEN_H2_CLEAR_MARK,
  OWNER_HARDEN_H3_MARK_PENDING,
  OWNER_SCHEMA_S1_HAS_LEDGER,
  OWNER_SCHEMA_S2_LEDGER,
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
 * The same re-run handles a crewflow_owner whose password still does not log in after a grant-only transaction.
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
  passThrough: 'PG_DATABASE_URL is the crewflow_owner login and there is no PG_ADMIN_URL: checking it (read-only); the database is not changed.',
  ownerNotSelf: 'The PG_DATABASE_URL session is not crewflow_owner itself (session_user and current_user must both be crewflow_owner). Refusing.',
  ownerNoDbGrant:
    'crewflow_owner lacks CONNECT, CREATE, TEMPORARY WITH GRANT OPTION on this database (01-crewflow-owner.sql grants it). Grant it as the database owner, or put the database admin URL in PG_ADMIN_URL. Refusing.',
  ownerUrlAuth: (sqlstate: string) =>
    `The database refused the crewflow_owner login of PG_DATABASE_URL (SQLSTATE ${sqlstate}: wrong password, or pg_hba.conf does not allow it). Without PG_ADMIN_URL db-setup never changes the password: put crewflow_owner's real password in PG_DATABASE_URL, or set PG_ADMIN_URL (your admin URL) so db-setup sets it. Refusing.`,
  passwordSet: 'The crewflow_owner password inside PG_DATABASE_URL did not log in: it is now set with the admin login (PG_ADMIN_URL).',
  /**
   * The server's major is not one of database/postgres/supported-majors.ts (15 and earlier, or a major above the newest
   * reviewed one). Read from the Q2 facts, before the probe and any write: nothing is created.
   */
  unsupportedPostgres: (major: number | null) => `${unsupportedPostgresMessage(major)} Nothing was created. Refusing.`,
  ownerInOtherDatabase:
    'The crewflow_owner password inside PG_DATABASE_URL does not log in, so it would be set, but crewflow_owner owns objects in, or holds a grant on, another database of this PostgreSQL cluster: another Crewflow deployment uses it, and the change would break that deployment. Crewflow supports one deployment per PostgreSQL cluster when using an admin URL. Put crewflow_owner\'s real password in PG_DATABASE_URL. Refusing.',
  ownerOwnsDatabase:
    'crewflow_owner owns this database (directly or through a role it is a member of, e.g. rab_owner after transition-from-separated.sql). The database setup step never runs as the admin in a database the app login owns (it could plant objects the admin session would run). Remove PG_ADMIN_URL (db-setup then only checks crewflow_owner, read-only). Refusing.',
  searchPathDefault:
    'A database-wide or crewflow_owner search_path default is set (ALTER DATABASE ... SET search_path / ALTER ROLE crewflow_owner SET search_path). Remove it (ALTER DATABASE ... RESET search_path / ALTER ROLE crewflow_owner RESET search_path). Refusing.',
  privilegedAttributes: (attributes: readonly string[]) =>
    // sql-injection-reviewed: an error MESSAGE (printed, never executed); attributes are the fixed attribute names of the facts row.
    `crewflow_owner exists with ${attributes.join(', ')}; Crewflow never runs as a privileged login. Fix the role (ALTER ROLE crewflow_owner NOSUPERUSER ...) or drop it; the API never changes an existing role's attributes.`,
  noCreateRoleHardened: "crewflow_owner is NOCREATEROLE (hardened); a release that creates roles will need it back.",
  privilegedMembership: 'crewflow_owner is a member of a superuser, BYPASSRLS or predefined privileged role.',
  expired: "crewflow_owner's VALID UNTIL has passed; clear it (ALTER ROLE crewflow_owner VALID UNTIL 'infinity').",
  adminCannotCreateRoles: "The PG_ADMIN_URL login cannot create roles (needs CREATEROLE, or use the provider's admin login).",
  adminCannotGrantDb:
    'The PG_ADMIN_URL login cannot grant CONNECT, CREATE, TEMPORARY on this database (it must own the database or hold those privileges WITH GRANT OPTION).',
  adminNoAdminOption:
    "The crewflow_owner password inside PG_DATABASE_URL does not log in, so it must be set, but the PG_ADMIN_URL login has no ADMIN OPTION on crewflow_owner (it was created by another login). Run, as that login or a superuser: GRANT crewflow_owner TO <your admin> WITH ADMIN OPTION; or put crewflow_owner's real password in PG_DATABASE_URL. Refusing.",
  adminCannotResetPassword:
    "The crewflow_owner password inside PG_DATABASE_URL does not log in, so it must be set, but the PG_ADMIN_URL login cannot change another role's password (it needs CREATEROLE and ADMIN OPTION on crewflow_owner, or superuser); or put crewflow_owner's real password in PG_DATABASE_URL. Refusing.",
  probeFailed: (sqlstateClass: string) =>
    `crewflow_owner could not log in for a reason other than its password (SQLSTATE class ${sqlstateClass}); check pg_hba.conf and the role. Refusing.`,
  sessionRoleOption: 'The database URL (PG_ADMIN_URL or PG_DATABASE_URL) carries options=-c role=...; the database setup step connects as the URL login itself. Remove it. Refusing.',
  adminAuth: (sqlstate: string) =>
    `The database refused the login of PG_ADMIN_URL (SQLSTATE ${sqlstate}: wrong password, or pg_hba.conf does not allow it). Refusing.`,
  adminNoDatabase:
    'The database named in the database URL (PG_ADMIN_URL or PG_DATABASE_URL) does not exist (SQLSTATE 3D000). db-setup never creates a database: create it at your provider (the bundled db creates its own), then start again. Refusing.',
  adminTls: 'TLS to the database failed (certificate, host name, or the server has no TLS). Check sslmode in the database URL (PG_ADMIN_URL or PG_DATABASE_URL) and PG_SSL_CA_CERT / PG_SSL_CA_CERT_PATH. Refusing.',
  adminUnreachable: 'The database did not accept a connection within 60 s. Giving up (the restart policy retries).',
  adminConnectFailed: (code: string) => `Connecting with the database URL (PG_ADMIN_URL or PG_DATABASE_URL) failed (${code}).`,
  writeRefused: (sqlstate: string) =>
    `The database refused to create or update crewflow_owner (SQLSTATE ${sqlstate}): the PG_ADMIN_URL login lacks a needed right, or the provider refuses pre-hashed passwords. ${PREHASHED_REFUSED_UNSUPPORTED} Refusing.`,
  writeFailed: (sqlstate: string) => `Setting up crewflow_owner failed (SQLSTATE ${sqlstate}). Nothing was committed.`,
  reverifyFailed: 'crewflow_owner is not exactly as required after the setup step (attributes, grant or login). Refusing to continue.',
  raceRetry: 'crewflow_owner was being created by another start at the same moment; reading the facts again.',
  passwordRecheck: 'The database grant was added, and the crewflow_owner password inside PG_DATABASE_URL still does not log in: reading the facts again to set it.',
  raceExhausted: 'crewflow_owner kept changing while this start tried to set it up. Giving up (the restart policy retries).',
  unexpected: (code: string) => `Unexpected failure (${code}). Nothing secret is printed; see the database log for the SQLSTATE.`,
  ready: (what: string) => `crewflow_owner is ready (${what}).`,
  // ---- the CREATEROLE step (owner decision 2026-11-18) ----
  migrationsUnlisted: 'Could not list this image\'s migration files, so the schema bootstrap cannot be judged complete or not. Refusing to continue.',
  createRoleRemoved: 'The schema is complete for this image: CREATEROLE was removed from crewflow_owner (ALTER ROLE crewflow_owner NOCREATEROLE).',
  createRoleMarked:
    'The schema bootstrap is not complete yet: crewflow_owner keeps CREATEROLE for it and is marked, so the first start may use it; the next db-setup run (docker compose up -d) removes it once the schema is current.',
  createRoleKeptMarked: 'The schema bootstrap is not complete yet: crewflow_owner keeps CREATEROLE (already marked) until the schema is current.',
  createRoleMarkCleared: 'crewflow_owner is NOCREATEROLE; its leftover CREATEROLE mark was removed.',
  createRoleNoRights:
    "The CREATEROLE step needs to change crewflow_owner (remove CREATEROLE once the schema is complete, or mark it while it is not), but the PG_ADMIN_URL login cannot: it needs superuser, or CREATEROLE and ADMIN OPTION on crewflow_owner (GRANT crewflow_owner TO <your admin> WITH ADMIN OPTION, as the login that created it). Refusing.",
  ownerUrlCreateRoleComplete:
    "crewflow_owner has CREATEROLE although the schema is complete, and it is not marked as waiting for the bootstrap: rab-api and rab-worker refuse it in production. Without PG_ADMIN_URL db-setup never changes the role: as your admin run ALTER ROLE crewflow_owner NOCREATEROLE (or set PG_ADMIN_URL so db-setup removes it). Refusing.",
  ownerUrlCreateRolePendingUnmarked:
    "crewflow_owner has CREATEROLE for the schema bootstrap, but it is not marked, so rab-api would refuse it in production once the bootstrap ran. Without PG_ADMIN_URL db-setup never changes the role: as your admin run COMMENT ON ROLE crewflow_owner IS 'crewflow:createrole-until-schema-current' (own-database-app-login.sql does it), or set PG_ADMIN_URL. Refusing.",
  ownerUrlCreateRoleCompleteMarked:
    'crewflow_owner still has CREATEROLE (marked for the bootstrap) although the schema is complete. Without PG_ADMIN_URL db-setup never changes the role: as your admin run ALTER ROLE crewflow_owner NOCREATEROLE; COMMENT ON ROLE crewflow_owner IS NULL.',
});

export type OwnerBootstrapOutcome = 'pass-through' | 'unchanged' | 'created' | 'updated' | 'refused' | 'failed';

/**
 * What the CREATEROLE step did: `removed` (NOCREATEROLE now), `marked` (kept and marked: bootstrap pending), `kept` (kept,
 * already marked), `mark-cleared` (NOCREATEROLE, leftover mark removed), `none` (nothing to do, or mode c), `not-run`.
 */
export type CreateRoleOutcome = 'removed' | 'marked' | 'kept' | 'mark-cleared' | 'none' | 'not-run';

export interface OwnerBootstrapResult {
  outcome: OwnerBootstrapOutcome;
  exitCode: 0 | 64 | 70;
  created: boolean;
  passwordSet: boolean;
  grantAdded: boolean;
  createRole: CreateRoleOutcome;
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
  /** crewflow_owner carries OWNER_CREATEROLE_PENDING_COMMENT (false when it does not exist). */
  oCreateRolePending: boolean;
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
    oCreateRolePending: strictBool(row, 'o_createrole_pending'),
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
 * The version gate of db-setup (both modes), first of every refusal: only a major in SUPPORTED_POSTGRES_MAJORS goes on.
 * MIN_SERVER_VERSION_NUM stays the floor (below it the facts' PG16-only role semantics do not hold); the list is the ceiling
 * too, so a PostgreSQL 19 is refused here, before crewflow_owner is created, instead of by the migrate child afterwards.
 */
export function assertSupportedServerVersion(f: Pick<OwnerFacts, 'serverVersionNum'>): void {
  const major = postgresMajorFromVersionNum(f.serverVersionNum);
  if (!(f.serverVersionNum >= MIN_SERVER_VERSION_NUM) || !isSupportedPostgresMajor(major)) {
    throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.unsupportedPostgres(major));
  }
}

/**
 * §3.3, the checks that need no probe, in the plan's order. Throws OwnerBootstrapRefusal; returns the notes to log
 * (D2: an existing NOCREATEROLE crewflow_owner is accepted — the documented hardening — with one line).
 */
export function decideBeforeProbe(f: OwnerFacts): string[] {
  const notes: string[] = [];
  assertSupportedServerVersion(f);
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
 * §3.4, the Twenty way. `probe` (Q3: a login as crewflow_owner with the password inside PG_DATABASE_URL) is null when the
 * role does not exist.
 *   role missing                          => CREATE ROLE with that password (Twenty: CREATE USER ... WITH PASSWORD);
 *   probe ok                              => the password is right; never touched (Twenty: an existing user is skipped);
 *   28P01                                 => the password does not log in: SET it to the one in PG_DATABASE_URL (needs
 *                                            superuser, or CREATEROLE + ADMIN OPTION; the caller has already run the
 *                                            other-database check Q2b);
 *   42501 while the grant is missing      => CONNECT is not granted yet: add only the grant (the probe after COMMIT
 *                                            decides; a 28P01 then re-runs the attempt, which sets the password);
 *   anything else                         => refused with the SQLSTATE class only.
 */
export function planWrite(f: OwnerFacts, probe: ProbeResult | null): WritePlan {
  const create = !f.ownerExists;
  let needPassword = create;
  if (!create) {
    if (!probe) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('no probe for an existing role'));
    if (!probe.ok) {
      if (probe.code === '28P01') needPassword = true;
      else if (!(probe.code === '42501' && !f.oHasDbGrant)) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.probeFailed(sqlstateClass(probe.code)), probe.code);
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

/** The same for the crewflow_owner session of mode c: a login refusal names PG_DATABASE_URL and the no-admin rule. */
export function classifyOwnerUrlConnectError(error: unknown, retriesExhausted: boolean): OwnerBootstrapRefusal | OwnerBootstrapFailure {
  const code = errorCode(error);
  if (code === '28P01' || code === '28000') return new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.ownerUrlAuth(code), code);
  return classifyAdminConnectError(error, retriesExhausted);
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
  /** Q3 as crewflow_owner with the password inside PG_DATABASE_URL; resolves to ok, or the error code. */
  probeOwner(): Promise<ProbeResult>;
  /** A fresh SCRAM verifier of that password. */
  verifier(): string;
  /**
   * The CREATEROLE step's input: is the schema complete for this image (every migration file of the image in the ledger)?
   * Read on a READ-ONLY crewflow_owner session (schemaCompleteOn). A throw is a failure (70). Absent = the step is skipped
   * (unit tests of the role transaction only).
   */
  schemaComplete?(): Promise<boolean>;
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
 * Security review L4 (owner-approved, read-only): before the password of an EXISTING crewflow_owner is set, Q2b. Refused
 * (64) when crewflow_owner is used by another database of the cluster. Strict: anything but one boolean row is a failure (70).
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
  const probe = facts.ownerExists ? await io.probeOwner() : null;
  const plan = planWrite(facts, probe);
  // L4: the password of an existing role is never set while another database of the cluster uses the role.
  if (plan.needPassword && !plan.create) await assertNoOtherDatabase(session);
  return plan;
}

const UNCHANGED: OwnerBootstrapResult = { outcome: 'unchanged', exitCode: 0, created: false, passwordSet: false, grantAdded: false, createRole: 'not-run', code: null };

/**
 * One attempt. The facts are read twice: once WITHOUT the lock (a restart with everything in place opens no transaction at
 * all), and again UNDER the advisory lock, after any concurrent start on this database has committed. Only the post-lock
 * plan decides what is written AND the outcome reported. Returns 'race' when a concurrent start on another database of the
 * cluster collided, or when a grant-only transaction still leaves a password that does not log in (re-run from the facts).
 */
async function attempt(session: SqlSession, io: OwnerBootstrapIo): Promise<OwnerBootstrapResult | 'race' | 'recheck'> {
  const preLock = await planFromDatabase(session, io, true);
  if (!preLock.write) return { ...UNCHANGED };

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
    // No self-grant of crewflow_owner to the admin login (createrole_self_grant), transaction-local, before CREATE ROLE.
    await session.query(OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT);
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
    // Only the grant was added (the password could not be checked before): a wrong password is set by the next attempt.
    if (after.code === '28P01' && !plan.needPassword) return 'recheck';
    throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed, after.code);
  }
  assertFactsExact(await readFacts(session));
  if (plan.needPassword && !plan.create) io.log(OWNER_BOOTSTRAP_MESSAGES.passwordSet);
  return {
    outcome: plan.create ? 'created' : 'updated',
    exitCode: 0,
    created: plan.create,
    passwordSet: plan.needPassword,
    grantAdded: plan.needGrant,
    createRole: 'not-run',
    code: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The CREATEROLE step (owner decision 2026-11-18).
// ---------------------------------------------------------------------------------------------------------------------

/** The CREATEROLE decision over the facts and the schema state. Pure. */
export type CreateRoleAction = 'remove' | 'mark' | 'clear-mark' | 'none';

export function decideCreateRole(f: Pick<OwnerFacts, 'ownerExists' | 'oCreateRole' | 'oCreateRolePending'>, schemaComplete: boolean): CreateRoleAction {
  if (!f.ownerExists) return 'none';
  if (f.oCreateRole === true) {
    if (schemaComplete) return 'remove';
    return f.oCreateRolePending ? 'none' : 'mark';
  }
  return f.oCreateRolePending ? 'clear-mark' : 'none';
}

/**
 * Mode c (no admin): the same rule, read-only. Refuses (64) what the boot gate would refuse in production; returns the
 * notes to log otherwise.
 */
export function decideOwnerUrlCreateRole(f: Pick<OwnerFacts, 'oCreateRole' | 'oCreateRolePending'>, schemaComplete: boolean): string[] {
  if (f.oCreateRole !== true) return [];
  if (schemaComplete) {
    if (!f.oCreateRolePending) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleComplete);
    return [OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleCompleteMarked];
  }
  if (!f.oCreateRolePending) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRolePendingUnmarked);
  return [OWNER_BOOTSTRAP_MESSAGES.createRoleKeptMarked];
}

/**
 * This image's migration names, from the migration FILES (`<13-digit timestamp>-<Name>.(ts|js)` → `<Name><timestamp>`, the
 * class name TypeORM records in core.migrations; owner-bootstrap.spec.ts proves the two agree for every file). Read with
 * readdirSync, never by loading the migrations (db-setup stays small: no TypeORM, no entities). Empty = cannot judge.
 */
export function imageMigrationNames(dir: string = join(__dirname, '..', '..', 'core', 'migrations')): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    const m = /^(\d{13})-([A-Za-z0-9]+)\.(ts|js)$/.exec(file);
    if (m) names.add(`${m[2]}${m[1]}`);
  }
  return [...names].sort();
}

/** Complete = every migration of this image is in the ledger (CURRENT, or AHEAD after a rollback). Pure. */
export function isSchemaComplete(expected: readonly string[], ledger: readonly string[] | null): boolean {
  if (expected.length === 0) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.migrationsUnlisted);
  if (ledger === null) return false;
  const applied = new Set(ledger);
  return expected.every((name) => applied.has(name));
}

/** S1 + S2 on a (read-only, pinned) crewflow_owner session: the ledger's names, or null when there is no ledger. */
export async function readLedgerNames(session: SqlSession): Promise<string[] | null> {
  const { rows } = await session.query(OWNER_SCHEMA_S1_HAS_LEDGER);
  const has = rows.length === 1 ? rows[0]?.has_ledger : undefined;
  if (typeof has !== 'boolean') throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('ledger fact'));
  if (!has) return null;
  return (await session.query(OWNER_SCHEMA_S2_LEDGER)).rows.map((r) => String(r.name));
}

/**
 * The CREATEROLE step's transaction, on the admin session: BEGIN, the advisory lock, the facts again UNDER the lock, the
 * decision, the statement(s), the facts again (must show the result), COMMIT. Needs superuser, or CREATEROLE + ADMIN OPTION
 * on crewflow_owner (refused, 64, otherwise; nothing changed).
 */
async function applyCreateRoleStep(session: SqlSession, io: OwnerBootstrapIo, schemaComplete: boolean): Promise<CreateRoleOutcome | 'race'> {
  const before = await readFacts(session);
  const preview = decideCreateRole(before, schemaComplete);
  if (preview === 'none') {
    if (before.ownerExists && before.oCreateRole === true) io.log(OWNER_BOOTSTRAP_MESSAGES.createRoleKeptMarked);
    return before.ownerExists && before.oCreateRole === true ? 'kept' : 'none';
  }
  let action: CreateRoleAction;
  await session.query(OWNER_BOOTSTRAP_BEGIN);
  try {
    await session.query(OWNER_BOOTSTRAP_Q4A_LOCK);
    const f = await readFacts(session);
    action = decideCreateRole(f, schemaComplete);
    if (action === 'none') {
      await session.query(OWNER_BOOTSTRAP_ROLLBACK);
      return f.oCreateRole === true ? 'kept' : 'none';
    }
    if (!(f.adminSuper || (f.adminCreateRole && f.adminHasAdminOption))) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.createRoleNoRights);
    if (action === 'remove') {
      await session.query(OWNER_HARDEN_H1_NOCREATEROLE);
      if (f.oCreateRolePending) await session.query(OWNER_HARDEN_H2_CLEAR_MARK);
    } else if (action === 'clear-mark') {
      await session.query(OWNER_HARDEN_H2_CLEAR_MARK);
    } else {
      await session.query(OWNER_HARDEN_H3_MARK_PENDING);
    }
    const after = await readFacts(session);
    const ok =
      action === 'mark' ? after.oCreateRole === true && after.oCreateRolePending : after.oCreateRole === false && !after.oCreateRolePending;
    if (!ok) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed);
    await session.query(OWNER_BOOTSTRAP_COMMIT);
  } catch (error) {
    await session.query(OWNER_BOOTSTRAP_ROLLBACK).catch(() => undefined);
    const classified = classifyWriteError(error);
    // A concurrent db-setup on ANOTHER database of the cluster changed the same role row (roles are cluster-wide, the
    // advisory lock is per database): the caller re-runs the step from the facts, as attempt() does.
    if (classified === 'race') return 'race';
    throw classified;
  }
  if (action === 'remove') {
    io.log(OWNER_BOOTSTRAP_MESSAGES.createRoleRemoved);
    return 'removed';
  }
  if (action === 'clear-mark') {
    io.log(OWNER_BOOTSTRAP_MESSAGES.createRoleMarkCleared);
    return 'mark-cleared';
  }
  io.log(OWNER_BOOTSTRAP_MESSAGES.createRoleMarked);
  return 'marked';
}

/** Modes a and b on the admin login. Exported for the integration harness and the unit tests. */
export async function bootstrapOwnerWithIo(io: OwnerBootstrapIo, retryWindowMs = ADMIN_CONNECT_RETRY_WINDOW_MS): Promise<OwnerBootstrapResult> {
  let session: SqlSession | null = null;
  try {
    session = await connectAdminWithRetry(io, retryWindowMs);
    await session.query(OWNER_BOOTSTRAP_Q0_SESSION);
    await session.query(OWNER_BOOTSTRAP_Q1_SUPERUSER_LOGGING);
    let result: OwnerBootstrapResult | null = null;
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const r = await attempt(session, io);
      if (r !== 'race' && r !== 'recheck') {
        result = r;
        break;
      }
      if (i < MAX_ATTEMPTS) {
        io.log(r === 'recheck' ? OWNER_BOOTSTRAP_MESSAGES.passwordRecheck : OWNER_BOOTSTRAP_MESSAGES.raceRetry);
        await io.sleep(200 + Math.floor(Math.random() * 500)); // jitter, so two colliding starts do not collide again
      }
    }
    if (!result) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.raceExhausted);
    if (!io.schemaComplete) return result;
    const complete = await io.schemaComplete();
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const createRole = await applyCreateRoleStep(session, io, complete);
      if (createRole !== 'race') return { ...result, createRole };
      if (i < MAX_ATTEMPTS) {
        io.log(OWNER_BOOTSTRAP_MESSAGES.raceRetry);
        await io.sleep(200 + Math.floor(Math.random() * 500));
      }
    }
    throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.raceExhausted);
  } finally {
    await closeQuietly(session);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The OWNER-URL mode (c): PG_DATABASE_URL only. Twenty runs no setup step for an external database (secret-db-url.yaml:
// 24-45); Crewflow keeps the read-only RLS refusals: log in with the URL's own password, pin the session (Q0), O1 + Q2 +
// the ledger, refuse anything privileged. NEVER a write to the database, never a password change.
// ---------------------------------------------------------------------------------------------------------------------

export interface OwnerUrlIo {
  /** A session as crewflow_owner with the URL's own password (one attempt). */
  openUrl(): Promise<SqlSession>;
  /** This image's migration names (imageMigrationNames). Absent = the CREATEROLE rule is skipped (unit tests). */
  expectedMigrations?(): string[];
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
  assertSupportedServerVersion(f);
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

const OWNER_URL_UNCHANGED: OwnerBootstrapResult = { outcome: 'pass-through', exitCode: 0, created: false, passwordSet: false, grantAdded: false, createRole: 'none', code: null };

/** The owner-URL mode: read-only. Q0, O1, Q2, the ledger, the refusals. Exported for the unit tests. */
export async function setupOwnerUrlWithIo(io: OwnerUrlIo, retryWindowMs = ADMIN_CONNECT_RETRY_WINDOW_MS): Promise<OwnerBootstrapResult> {
  let session: SqlSession | null = null;
  try {
    try {
      session = await connectWithRetry(() => io.openUrl(), io, retryWindowMs);
    } catch (error) {
      throw classifyOwnerUrlConnectError(error, RETRYABLE_CONNECT_CODES.has(errorCode(error)));
    }
    await session.query(OWNER_BOOTSTRAP_Q0_SESSION);
    const { who, facts } = await readOwnerSelf(session);
    for (const note of decideOwnerSelf(who, facts)) io.log(note);
    if (io.expectedMigrations) {
      const complete = isSchemaComplete(io.expectedMigrations(), await readLedgerNames(session));
      for (const note of decideOwnerUrlCreateRole(facts, complete)) io.log(note);
    }
    return { ...OWNER_URL_UNCHANGED };
  } finally {
    await closeQuietly(session);
  }
}

function describeReady(result: OwnerBootstrapResult): string {
  if (result.outcome === 'pass-through') return 'existing crewflow_owner, checked read-only, unchanged';
  if (result.created) return 'created with the password inside PG_DATABASE_URL';
  const parts: string[] = [];
  if (result.passwordSet) parts.push('password set to the one inside PG_DATABASE_URL');
  if (result.grantAdded) parts.push('database grant added');
  return parts.length > 0 ? parts.join(', ') : 'unchanged';
}

export function failureResult(error: unknown): OwnerBootstrapResult {
  if (error instanceof OwnerBootstrapRefusal) {
    return { outcome: 'refused', exitCode: 64, created: false, passwordSet: false, grantAdded: false, createRole: 'not-run', code: error.code };
  }
  const code = error instanceof OwnerBootstrapFailure ? error.code : errorCode(error);
  return { outcome: 'failed', exitCode: 70, created: false, passwordSet: false, grantAdded: false, createRole: 'not-run', code };
}

/** The one place a connection is constructed here: the factory's explicit config, with this step's fixed application_name. */
function openClient(config: PgDriverConfig): Client {
  return new Client(config);
}

/**
 * H1: every bootstrap connection carries a fixed session pin as startup options: search_path=pg_catalog,pg_temp always;
 * read-write for the admin and probe sessions (BOOTSTRAP_SESSION_STARTUP_OPTIONS), read-only for the crewflow_owner
 * session that only reads (OWNER_URL_SESSION_STARTUP_OPTIONS, I1).
 */
function pinned(config: PgDriverConfig, startupOptions: string = BOOTSTRAP_SESSION_STARTUP_OPTIONS): PgDriverConfig {
  const options = [config.options, startupOptions].filter((o) => typeof o === 'string' && o !== '').join(' ');
  return { ...config, options };
}

/**
 * Every driver config the bootstrap child uses: the connect URL's own login (`admin`: the admin in modes a and b), the
 * crewflow_owner READ-ONLY session (`ownerUrl`: mode c's checks, and the ledger read of the CREATEROLE step; security review
 * I1), and the crewflow_owner probe (`probe`), each pinned (H1). `appUrl` is PG_DATABASE_URL. Exported for the spec that
 * asserts the pin is on all of them.
 */
export function bootstrapDriverConfigs(
  resolved: ResolvedPgEnvironment,
  appUrl: string,
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
  const ownerLogin = (purpose: 'owner-probe', applicationName: string): PgDriverConfig => ({
    ...pgClientConfig(resolved, {
      url: appUrl,
      urlLabel: 'PG_DATABASE_URL',
      purpose,
      sessionAffinity: true,
      statementTimeoutMs: 10_000,
      queryTimeoutMs: 15_000,
      connectTimeoutMs: 10_000,
    }),
    application_name: applicationName,
  });
  const admin = pinned(urlLogin);
  const ownerUrl = pinned(ownerLogin('owner-probe', OWNER_BOOTSTRAP_APPLICATION_NAME), OWNER_URL_SESSION_STARTUP_OPTIONS);
  const probe = pinned(ownerLogin('owner-probe', OWNER_PROBE_APPLICATION_NAME));
  return { admin, ownerUrl, probe };
}

/** One connected, pinned session on an explicit bootstrap config (one attempt; the callers retry). Exported for the live harness. */
export async function connectSession(config: PgDriverConfig): Promise<SqlSession> {
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

/** Is the schema complete for this image? On a fresh READ-ONLY crewflow_owner session (S1 + S2). */
async function schemaCompleteOn(config: PgDriverConfig, expected: () => string[]): Promise<boolean> {
  const names = expected();
  let session: SqlSession | null = null;
  try {
    session = await connectSession(config);
    await session.query(OWNER_BOOTSTRAP_Q0_SESSION);
    return isSchemaComplete(names, await readLedgerNames(session));
  } catch (error) {
    if (error instanceof OwnerBootstrapRefusal || error instanceof OwnerBootstrapFailure) throw error;
    throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected(`ledger read ${errorCode(error)}`), errorCode(error));
  } finally {
    await closeQuietly(session);
  }
}

export interface RunOwnerBootstrapOptions {
  log?: (line: string) => void;
  /** Test seam (integration harness): a shorter connect-retry window. */
  retryWindowMs?: number;
  /** Test seam: this image's migration names (default: imageMigrationNames(), the migration files beside this script). */
  expectedMigrations?: () => string[];
}

/** Fails closed when the URL policy refuses: the message names the variable the operator actually set. */
function resolveFor(env: Record<string, string | undefined>, url: string, label: string): ResolvedPgEnvironment {
  try {
    // The migrate process role: the same URL policy and TLS as every process, and a transaction-pooler shape is refused
    // (the bootstrap needs one real session). The policy reads the one URL under PG_DATABASE_URL, so the URL is handed to
    // it under that name in a COPY of the environment (PG_ADMIN_URL removed).
    const pgEnv: Record<string, string | undefined> = { ...env, PG_DATABASE_URL: url };
    delete pgEnv[ADMIN_URL_LABEL];
    return resolvePgEnvironment(pgEnv, { processRole: 'migrate' });
  } catch (error) {
    if (error instanceof PgConfigError) throw new OwnerBootstrapRefusal(label === ADMIN_URL_LABEL ? error.message.split('PG_DATABASE_URL').join(ADMIN_URL_LABEL) : error.message);
    throw error;
  }
}

/**
 * The whole step for one environment (the child passes process.env). Never throws: every failure becomes a result with
 * exit code 64 or 70, and the one printed line for it is fixed text. Reads ONLY PG_ADMIN_URL / PG_DATABASE_URL
 * (owner-credential.ts selectDbSetupInput) and the TLS settings; APP_SECRET plays no part.
 */
export async function runOwnerBootstrap(env: Record<string, string | undefined>, options: RunOwnerBootstrapOptions = {}): Promise<OwnerBootstrapResult> {
  const log = options.log ?? (() => undefined);
  try {
    // The single decision (owner-credential.ts selectDbSetupInput), refused (fixed text) BEFORE anything connects.
    let input: DbSetupInput;
    try {
      input = selectDbSetupInput(env);
    } catch (error) {
      if (error instanceof OwnerCredentialError) throw new OwnerBootstrapRefusal(error.message);
      throw error;
    }
    if (input.mode === 'owner-url') log(OWNER_BOOTSTRAP_MESSAGES.passThrough);
    // A password the SCRAM computation refuses (non-ASCII) is refused here, before anything connects (OwnerCredentialError).
    if (input.mode === 'bootstrap') scramSha256Verifier(input.ownerPassword);

    const resolved = resolveFor(env, input.url, input.name);
    // The app URL passes the same policy (pooler, TLS, parameters) before anything connects.
    const appResolved = input.mode === 'bootstrap' ? resolveFor(env, input.appUrl, 'PG_DATABASE_URL') : resolved;
    if (resolved.primary.target.sessionRoleOption || appResolved.primary.target.sessionRoleOption) {
      throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.sessionRoleOption);
    }
    if (!sameTarget(resolved.primary.target, input.plan.urlTarget)) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('admin target mismatch'));

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const now = () => Date.now();
    const retryWindowMs = options.retryWindowMs ?? ADMIN_CONNECT_RETRY_WINDOW_MS;
    const expectedMigrations = options.expectedMigrations ?? (() => imageMigrationNames());
    const ownerPassword = input.ownerPassword;

    const { admin: adminConfig, ownerUrl: ownerUrlConfig, probe: probeConfig } = bootstrapDriverConfigs(resolved, input.appUrl);
    let result: OwnerBootstrapResult;
    if (input.mode === 'owner-url') {
      // I1: the crewflow_owner session is read-only (default_transaction_read_only=on as a startup option).
      result = await setupOwnerUrlWithIo({ openUrl: () => connectSession(ownerUrlConfig), expectedMigrations, log, sleep, now }, retryWindowMs);
    } else {
      const io: OwnerBootstrapIo = {
        openAdmin: () => connectSession(adminConfig),
        probeOwner: () => probeOwnerOnce(probeConfig),
        verifier: () => scramSha256Verifier(ownerPassword),
        schemaComplete: () => schemaCompleteOn(ownerUrlConfig, expectedMigrations),
        log,
        sleep,
        now,
      };
      result = await bootstrapOwnerWithIo(io, retryWindowMs);
    }
    log(OWNER_BOOTSTRAP_MESSAGES.ready(describeReady(result)));
    return result;
  } catch (error) {
    if (error instanceof OwnerBootstrapRefusal || error instanceof OwnerBootstrapFailure) log(error.message);
    else if (error instanceof OwnerCredentialError) log(error.message);
    else log(OWNER_BOOTSTRAP_MESSAGES.unexpected(errorCode(error)));
    if (error instanceof OwnerCredentialError) return failureResult(new OwnerBootstrapRefusal(error.message));
    return failureResult(error);
  }
}

/** The one machine-readable line (enums, booleans and a SQLSTATE only). */
export function resultLine(result: OwnerBootstrapResult): string {
  return `${OWNER_BOOTSTRAP_RESULT_PREFIX} ${JSON.stringify(result)}`;
}

/** Re-exported for the boot gate spec and the harness: the exact mark db-setup writes. */
export { OWNER_CREATEROLE_PENDING_COMMENT };
