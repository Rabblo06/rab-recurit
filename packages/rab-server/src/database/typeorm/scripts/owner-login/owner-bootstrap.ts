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
 * not complete, a CREATEROLE crewflow_owner is MARKED (COMMENT ON ROLE, an expiring mark: owner-login-posture.ts) so the boot gate
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
 * in this process's memory (it came from the environment); the server only ever receives the SCRAM verifier (§3.6): Crewflow
 * NEVER sends a plain-text password (owner decision 2026-11-19).
 *
 * Provider-neutral by rule (owner decision 2026-11-19: "no provider-specific code ... Decide by capability, detected at run
 * time"): no host-name matching, no provider flag. What differs between servers is detected by what the server does:
 *   - the password FORM (owner decision 2026-11-19, option 1 "Create login, you set password"): the SCRAM verifier is always
 *     tried first; when the server refuses it (isPasswordFormRefusal: the SQLSTATE of the CREATE / ALTER ROLE step, or of
 *     the COMMIT, which is where some managed servers check a password), db-setup creates crewflow_owner WITHOUT a password
 *     (an existing role's password is left alone), adds the grant, and stops (64) with fixed steps: the operator sets the
 *     password once in the provider's SQL editor, to PG_DATABASE_APP_PASSWORD, and redeploys; the next run's login probe
 *     then succeeds and setup continues. When the server refuses a login role without a password too, nothing is created and
 *     the steps print the reviewed SQL (OWNER_MANUAL_ROLE_SQL) with a placeholder. Never a loop on a password write: one
 *     verifier attempt and at most one passwordless transaction per run. The log names the reason, never a provider;
 *   - a connection POOLER in PG_ADMIN_URL: refused when the admin session is not session-stable (pg-session-probe.ts, before
 *     any write) or when the server refuses the session settings sent at connect (08P01); never by its address. The refusal
 *     says to put the direct address in PG_ADMIN_URL or in PG_ADMIN_DIRECT_URL (db-setup and
 *     db-harden only; the same login and database as PG_ADMIN_URL). Host names are never guessed;
 *   - every refusal is reported as what it is: its SQLSTATE and its stage (write statement or COMMIT). XX000 is a race only
 *     for PostgreSQL's fixed "tuple concurrently updated", never at COMMIT.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import {
  ADMIN_URL_LABEL,
  DB_SETUP_INPUT_MESSAGES,
  type DbSetupInput,
  OWNER_LOGIN,
  OwnerCredentialError,
  scramSha256Verifier,
  selectDbSetupInput,
} from '../../../owner-login/owner-credential';
import {
  parsePgUrl,
  pgClientConfig,
  PgConfigError,
  PgDriverConfig,
  PgSessionProbeError,
  probePgSessionAffinity,
  resolvePgEnvironment,
  ResolvedPgEnvironment,
  sameTarget,
} from '../../../postgres';
import { isSupportedPostgresMajor, postgresMajorFromVersionNum, unsupportedPostgresMessage } from '../../../postgres/supported-majors';
import { OWNER_CREATEROLE_MARK_PREFIX } from '../../../boot-checks/owner-login-posture';
import { LEGACY_NOLOGIN_SQL } from '../migrate/owner-login/legacy-logins';
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
  OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD,
  OWNER_BOOTSTRAP_Q4D_NO_PASSWORD_REVERIFY,
  OWNER_BOOTSTRAP_L1_LOCK_TIMEOUT,
  OWNER_BOOTSTRAP_Q4D_REVERIFY,
  OWNER_BOOTSTRAP_ROLLBACK,
  OWNER_HARDEN_H1_NOCREATEROLE,
  OWNER_HARDEN_H2_CLEAR_MARK,
  OWNER_HARDEN_R1_LEGACY_LOGINS,
  OWNER_HARDEN_M1_TRY_MIGRATION_LOCK,
  OWNER_MANUAL_ROLE_SQL,
  OWNER_HARDEN_M2_RELEASE_MIGRATION_LOCK,
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
 * CREATE ROLE (42710 / 23505), a serialization failure or deadlock (40001 / 40P01), and a concurrent ALTER ROLE / GRANT on
 * the same catalog row, which PostgreSQL reports as XX000 with its fixed text "tuple concurrently updated" (the DO blocks keep
 * exactly that text: isConcurrentUpdate). Owner decision 2026-11-19: XX000 itself is NOT a race. A server that refuses a
 * pre-hashed password at COMMIT raises XX000 there, and the earlier rule turned that refusal into three "being created by
 * another start" retries and exit 70 (production, 0.6.0). The transaction is rolled back and the attempt re-runs from the
 * facts and the probe, so a role another start just finished needs nothing. The same re-run handles a crewflow_owner whose
 * password still does not log in after a grant-only transaction.
 */
export const MAX_ATTEMPTS = 3;
export const RACE_SQLSTATES: ReadonlySet<string> = new Set(['42710', '23505', '40001', '40P01']);
/** PostgreSQL's fixed primary message for a concurrent update of the same catalog row (SQLSTATE XX000). */
export const CONCURRENT_UPDATE_MESSAGE = 'tuple concurrently updated';
/**
 * The SQLSTATEs that mean "the server refused the password FORM" when they come from the CREATE / ALTER ROLE step of a
 * transaction that set a password (DO-block HINT crewflow-stage=role), or from that transaction's COMMIT: 22023
 * invalid_parameter_value and 28P01 invalid_password (a check_password_hook refusing it), 0A000 feature_not_supported, and
 * XX000 internal_error (an extension's elog(ERROR), including a check made at COMMIT), except the concurrent-update race.
 * Never 42501 (a missing right is not a password form) and never the DO block's own shape check (stage `check`).
 */
export const PASSWORD_FORM_REFUSAL_SQLSTATES: ReadonlySet<string> = new Set(['22023', '28P01', '0A000', 'XX000']);
/** The name of the optional direct admin address (db-setup and db-harden only). */
export const ADMIN_DIRECT_URL_LABEL = 'PG_ADMIN_DIRECT_URL' as const;
/**
 * PR #258 (feat/twenty-pooler): the crewflow_owner SESSION address, set when PG_DATABASE_URL is a pooled address: the same
 * login, password and database as PG_DATABASE_URL, a real session. db-setup's crewflow_owner sessions use it.
 */
export const APP_SESSION_URL_LABEL = 'PG_DATABASE_SESSION_URL' as const;

/** Where a write failed: a statement of the transaction, or its COMMIT. */
export type WriteStage = 'statement' | 'commit';
export interface WriteFailureInfo {
  stage: WriteStage;
  code: string;
}

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
  // ---- a connection pooler in PG_ADMIN_URL, detected by capability (owner decision 2026-11-19) ----
  adminStartupRefused: (code: string) =>
    `The database refused the session settings db-setup sends when it connects (SQLSTATE ${code}). PG_ADMIN_URL looks like a connection pooler, and db-setup needs one real database session. Put the database's direct address in PG_ADMIN_URL, or keep PG_ADMIN_URL and set PG_ADMIN_DIRECT_URL to the direct address (the same login and database). Refusing.`,
  adminNotSessionStable:
    'The PG_ADMIN_URL connection is not session-stable (two transactions or two connections did not behave like separate real database sessions with their own session locks): it looks like a connection pooler, and db-setup needs one real database session. Put the database\'s direct address in PG_ADMIN_URL, or keep PG_ADMIN_URL and set PG_ADMIN_DIRECT_URL to the direct address (the same login and database). Nothing was changed. Refusing.',
  adminTargetMismatch: `${DB_SETUP_INPUT_MESSAGES.targetMismatch} If PG_ADMIN_URL is a pooled address of the same database, keep it as it is and set PG_ADMIN_DIRECT_URL to the direct address (the same login and database).`,
  adminDirectUsed: 'PG_ADMIN_DIRECT_URL is set: db-setup connects with it instead of PG_ADMIN_URL (the same login and database, checked).',
  appSessionWithoutApp: 'PG_DATABASE_SESSION_URL is set without PG_DATABASE_URL. It is only the session address of the PG_DATABASE_URL login: set both. Refusing.',
  appSessionMismatch:
    'PG_DATABASE_SESSION_URL must log in as the same user, with the same password, to the same database as PG_DATABASE_URL (only the address may differ). Values not shown. Refusing.',
  appSessionUsed: 'PG_DATABASE_SESSION_URL is set: db-setup\'s crewflow_owner sessions use it instead of PG_DATABASE_URL (the same login, password and database, checked).',
  adminDirectWithoutAdmin: 'PG_ADMIN_DIRECT_URL is set without PG_ADMIN_URL. It is only the direct address of the PG_ADMIN_URL login: set both, or put the direct address in PG_ADMIN_URL. Refusing.',
  adminDirectMismatch:
    'PG_ADMIN_DIRECT_URL must log in as the same user, to the same database, as PG_ADMIN_URL (only the address may differ). Values not shown. Refusing.',
  writeRefused: (sqlstate: string) =>
    `The database refused to create or update crewflow_owner (SQLSTATE ${sqlstate}): the PG_ADMIN_URL login lacks a needed right. Nothing was committed. Refusing.`,
  writeFailed: (sqlstate: string) => `Setting up crewflow_owner failed (SQLSTATE ${sqlstate}). Nothing was committed.`,
  writeInternalError: (sqlstate: string) =>
    `Creating or updating crewflow_owner failed with an internal error (SQLSTATE ${sqlstate}) that is not a concurrent update, typically a server extension refusing the operation. Nothing was committed. Refusing.`,
  commitInternalError: (sqlstate: string) =>
    `The database refused to COMMIT the crewflow_owner setup with an internal error (SQLSTATE ${sqlstate}), typically a server extension refusing the role change. Nothing was committed. Refusing.`,
  commitFailed: (sqlstate: string) => `Committing the crewflow_owner setup failed (SQLSTATE ${sqlstate}). Nothing was committed.`,
  // ---- a server that refuses pre-hashed passwords (owner decision 2026-11-19, option 1) ----
  verifierRefused: (stage: WriteStage, sqlstate: string) =>
    `The server refused a pre-hashed password (SQLSTATE ${sqlstate} ${stageText(stage)}). Crewflow never sends a plain-text password.`,
  passwordlessCreated: 'crewflow_owner was created WITHOUT a password and NOLOGIN (nothing can log in as it yet), with its database grant.',
  passwordlessKept: 'crewflow_owner exists and does not log in with PG_DATABASE_APP_PASSWORD; its password and LOGIN were left unchanged.',
  setPasswordStep:
    "Set crewflow_owner's password once in your database provider's SQL editor: ALTER ROLE crewflow_owner LOGIN PASSWORD '<the value of PG_DATABASE_APP_PASSWORD>'; then redeploy. Use exactly that value (32+ characters, openssl rand -hex 32; if you set PG_DATABASE_URL yourself, the password inside it), never a console password reset (it generates a different, shorter password). If your provider allows it, run SET log_statement = 'none'; first, and clear the SQL editor's history afterwards. db-setup then checks the login and continues.",
  awaitingPassword: 'crewflow_owner has no usable password yet: db-setup exits 64 until crewflow_owner logs in with PG_DATABASE_APP_PASSWORD. Refusing.',
  passwordlessRefused: (stage: WriteStage, sqlstate: string) =>
    `The server also refused to create crewflow_owner without a password (SQLSTATE ${sqlstate} ${stageText(stage)}). Nothing was created.`,
  manualRoleStep:
    "Create crewflow_owner once in your database provider's SQL editor, connected to this database as your admin login, with exactly the SQL below; replace <PG_DATABASE_APP_PASSWORD> with that value (32+ characters, openssl rand -hex 32; if you set PG_DATABASE_URL yourself, the password inside it). If your provider allows it, run SET log_statement = 'none'; first, and clear the SQL editor's history afterwards. Then redeploy: db-setup then only checks the login and handles CREATEROLE.",
  serverIgnoresPassword:
    'The server lets crewflow_owner log in WITHOUT its password (a deliberately wrong password was accepted): a pg_hba trust, peer, cert or similar rule applies to it. Crewflow never runs on a login that needs no password: require password authentication (scram-sha-256) for crewflow_owner, then start again. Refusing.',
  awaitingManualRole: 'crewflow_owner does not exist yet: db-setup exits 64 until you create it with the SQL above. Refusing.',
  reverifyFailed: 'crewflow_owner is not exactly as required after the setup step (attributes, grant or login). Refusing to continue.',
  raceRetry: (stage: WriteStage, sqlstate: string) =>
    `crewflow_owner changed in another start at the same moment (SQLSTATE ${sqlstate} ${stageText(stage)}: a concurrent CREATE ROLE, ALTER ROLE or GRANT); reading the facts again.`,
  passwordRecheck: 'The database grant was added, and the crewflow_owner password inside PG_DATABASE_URL still does not log in: reading the facts again to set it.',
  raceExhausted: (stage: WriteStage, sqlstate: string) =>
    `crewflow_owner kept changing while this start tried to set it up (last: SQLSTATE ${sqlstate} ${stageText(stage)}). Giving up (the restart policy retries).`,
  unexpected: (code: string) => `Unexpected failure (${code}). Nothing secret is printed; see the database log for the SQLSTATE.`,
  ready: (what: string) => `crewflow_owner is ready (${what}).`,
  // ---- the CREATEROLE step (owner decision 2026-11-18) ----
  migrationsUnlisted: 'Could not list this image\'s migration files, so the schema bootstrap cannot be judged complete or not. Refusing to continue.',
  createRoleRemoved: 'The schema is complete for this image: CREATEROLE was removed from crewflow_owner (ALTER ROLE crewflow_owner NOCREATEROLE).',
  createRoleMarked:
    'The schema bootstrap is not complete yet: crewflow_owner keeps CREATEROLE for it and is marked, so the first start may use it; the next db-setup run (docker compose up -d) removes it once the schema is current.',
  createRoleKeptMarked: 'The schema bootstrap is not complete yet: crewflow_owner keeps CREATEROLE (already marked) until the schema is current.',
  createRoleMarkCleared: 'crewflow_owner is NOCREATEROLE; its leftover CREATEROLE mark was removed.',
  createRoleOtherDatabase:
    'The CREATEROLE step would change crewflow_owner (remove CREATEROLE, or set or clear its mark), but crewflow_owner owns objects in, or holds a grant on, another database of this PostgreSQL cluster: another Crewflow deployment uses it, and roles are cluster-wide. Crewflow supports one deployment per PostgreSQL cluster when using an admin URL. Nothing was changed. Refusing.',
  createRoleNoRights:
    "The CREATEROLE step needs to change crewflow_owner (remove CREATEROLE once the schema is complete, or mark it while it is not), but the PG_ADMIN_URL login cannot: it needs superuser, or CREATEROLE and ADMIN OPTION on crewflow_owner (GRANT crewflow_owner TO <your admin> WITH ADMIN OPTION, as the login that created it). Refusing.",
  ownerUrlCreateRoleComplete:
    "crewflow_owner has CREATEROLE although the schema is complete, and it is not marked as waiting for the bootstrap: rab-api and rab-worker refuse it in production. Without PG_ADMIN_URL db-setup never changes the role: as your admin run ALTER ROLE crewflow_owner NOCREATEROLE (or set PG_ADMIN_URL so db-setup removes it). Refusing.",
  ownerUrlCreateRolePendingUnmarked:
    "crewflow_owner has CREATEROLE for the schema bootstrap, but no admin marked it, so rab-api would refuse it in production once the bootstrap ran. Without PG_ADMIN_URL db-setup never changes the role: as your admin run step 5b of own-database-app-login.sql (the COMMENT ON ROLE mark, valid 24 h), or set PG_ADMIN_URL. Refusing.",
  ownerUrlCreateRoleExpired:
    'crewflow_owner still has CREATEROLE and its grace period (the admin\'s mark) has expired; the schema is complete, so rab-api and rab-worker refuse it in production. Without PG_ADMIN_URL db-setup never changes the role: as your admin run ALTER ROLE crewflow_owner NOCREATEROLE; COMMENT ON ROLE crewflow_owner IS NULL; (or set PG_ADMIN_URL so db-setup removes it). Refusing.',
  ownerUrlCreateRoleExpiredBeforeStart:
    "crewflow_owner's CREATEROLE mark expired before the schema bootstrap ran. Without PG_ADMIN_URL db-setup never changes the role: as your admin renew it (step 5b of own-database-app-login.sql, valid 24 h) right before the first start, or set PG_ADMIN_URL. Refusing.",
  ownerUrlCreateRoleCompleteMarked:
    'crewflow_owner still has CREATEROLE (marked for the bootstrap) although the schema is complete. Without PG_ADMIN_URL db-setup never changes the role: as your admin run ALTER ROLE crewflow_owner NOCREATEROLE; COMMENT ON ROLE crewflow_owner IS NULL; before the mark expires (24 h after it was set), or rab-api and rab-worker refuse to start.',
  // ---- db-harden (owner decision M1) ----
  hardenNoAdmin: 'No admin login (mode c, PG_DATABASE_URL only): nothing to harden; the operator removes CREATEROLE (own-database-app-login.sql step 10).',
  hardenTimeoutSetting: 'CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS must be whole seconds from 60 to 7200 (unset = 1200; 1-7200 only with NODE_ENV=test). Refusing.',
  hardenWaitingForRole: 'Waiting for db-setup: crewflow_owner does not exist yet.',
  hardenWaitingForSchema: 'Waiting for the schema bootstrap: the ledger does not hold every migration of this image yet (read-only, polled).',
  hardenAlready: 'crewflow_owner is already NOCREATEROLE and unmarked: nothing to harden.',
  legacyLoginsDisabled: (count: number) =>
    `${count} legacy login(s) (crewflow / crewflow_app) were still LOGIN: made NOLOGIN, password removed, as the admin, before removing CREATEROLE (BC-17).`,
  legacyLoginsNoRights:
    "crewflow / crewflow_app are still LOGIN, and once CREATEROLE is removed crewflow_owner can no longer change that, but the PG_ADMIN_URL login cannot make them NOLOGIN (it needs superuser, or CREATEROLE and ADMIN OPTION on them). Nothing was changed; CREATEROLE stays. As a superuser run: ALTER ROLE crewflow NOLOGIN PASSWORD NULL; ALTER ROLE crewflow_app NOLOGIN PASSWORD NULL; Refusing.",
  hardenWaitingForMigration: 'Waiting for the running migration to finish (its lock is held): CREATEROLE is removed only after the migrate child has finished.',
  createRoleBusyKept:
    'The schema is complete, but a migration is running right now (its lock is held), so CREATEROLE is kept this time; db-harden (or the next db-setup run) removes it.',
  hardenTimeout: (seconds: number) =>
    // sql-injection-reviewed: an error MESSAGE (printed, never executed); seconds is a validated integer.
    `The schema was not complete within ${seconds} s (CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS), so CREATEROLE was NOT removed; nothing was changed. The next db-setup or db-harden run removes it once the schema is complete (or, as your admin: ALTER ROLE crewflow_owner NOCREATEROLE; COMMENT ON ROLE crewflow_owner IS NULL;).`,
});

function stageText(stage: WriteStage): string {
  return stage === 'commit' ? 'at COMMIT' : 'in the write transaction';
}

/**
 * Owner decision 2026-11-19 (option 1), both exit 64: `awaiting-password` (crewflow_owner exists, created now without a
 * password or kept, and does not log in yet: the operator sets the password), `awaiting-manual-role` (the server refused a
 * passwordless (NOLOGIN) role too; nothing was created: the operator runs the printed SQL).
 */
export type OwnerBootstrapOutcome =
  | 'pass-through'
  | 'unchanged'
  | 'created'
  | 'updated'
  | 'refused'
  | 'failed'
  | 'awaiting-password'
  | 'awaiting-manual-role';

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
  /** crewflow_owner carries a valid CREATEROLE mark (owner-login-posture.ts; false when the role or the mark is missing). */
  oCreateRolePending: boolean;
  /** That mark's expiry has passed, by the server clock (false without a valid mark). */
  oCreateRoleMarkExpired: boolean;
  /** H1: a database-wide or crewflow_owner-level search_path default exists. */
  searchPathDefaultSet: boolean;
  /**
   * Security re-review R1 of #259: crewflow_owner is NOLOGIN and carries OWNER_AWAITING_PASSWORD_MARK (db-setup created it
   * without a password; the operator's ALTER ROLE ... LOGIN PASSWORD is pending). The only NOLOGIN state accepted.
   */
  oAwaitingPassword: boolean;
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
    oCreateRoleMarkExpired: strictBool(row, 'o_createrole_mark_expired'),
    searchPathDefaultSet: strictBool(row, 'search_path_default_set'),
    oAwaitingPassword: strictBool(row, 'o_awaiting_password'),
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
  // Security re-review R1 of #259: NOLOGIN is accepted ONLY in the awaiting-password state (db-setup's passwordless role).
  if (f.oLogin === false && !f.oAwaitingPassword) out.push('NOLOGIN');
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
  // A transaction pooler refuses the startup options every bootstrap connection carries (the search_path pin) with 08P01.
  if (code === '08P01') return new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminStartupRefused(code), code);
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

/** A failure of the write transaction's COMMIT (some servers check a role's password only there). */
export class WriteCommitError extends Error {
  constructor(readonly original: unknown) {
    super('commit failed');
    this.name = 'WriteCommitError';
  }
}

/** PostgreSQL's genuine concurrent-update race: XX000 with its fixed text (compared, never printed). */
export function isConcurrentUpdate(error: unknown): boolean {
  return errorCode(error) === 'XX000' && error instanceof Error && error.message === CONCURRENT_UPDATE_MESSAGE;
}

/** The DO blocks' fixed HINT `crewflow-stage=<check|role|grant>`, or null (any other hint, or none). */
export function doBlockStage(error: unknown): 'check' | 'role' | 'grant' | null {
  const hint = (error as { hint?: unknown } | null)?.hint;
  const m = typeof hint === 'string' ? /^crewflow-stage=(check|role|grant)$/.exec(hint) : null;
  return m ? (m[1] as 'check' | 'role' | 'grant') : null;
}

/** Where a write failure happened, and its SQLSTATE (never a message). */
export function writeFailureInfo(error: unknown): WriteFailureInfo {
  const commit = error instanceof WriteCommitError;
  return { stage: commit ? 'commit' : 'statement', code: errorCode(commit ? error.original : error) };
}

/**
 * Did the server refuse the password FORM? Only for a transaction that sent a password (`passwordSent`): a
 * PASSWORD_FORM_REFUSAL_SQLSTATES error from the CREATE / ALTER ROLE step (DO-block HINT crewflow-stage=role) or from the
 * COMMIT, never the concurrent-update race. Pure; reads the SQLSTATE and the fixed hint only.
 */
export function isPasswordFormRefusal(error: unknown, passwordSent: boolean): boolean {
  if (!passwordSent) return false;
  const commit = error instanceof WriteCommitError;
  const original = commit ? error.original : error;
  if (isConcurrentUpdate(original) || !PASSWORD_FORM_REFUSAL_SQLSTATES.has(errorCode(original))) return false;
  return commit || doBlockStage(original) === 'role';
}

/**
 * The write transaction's failure: 'verifier-refused' (the server refused the SCRAM verifier, or, for the passwordless
 * transaction, the passwordless (NOLOGIN) role: the caller takes the owner's option-1 / option-2 path), a race (retried by the
 * caller), a refusal (64) or a failure (70). `passwordSent`: the transaction set a password (or created the passwordless
 * login role), so a refusal of its role step or COMMIT is a refusal of that form.
 */
export function classifyWriteError(
  error: unknown,
  ctx: { passwordSent?: boolean } = {},
): OwnerBootstrapRefusal | OwnerBootstrapFailure | 'race' | 'verifier-refused' {
  // A decision taken under the lock (it may carry a probe SQLSTATE such as 42501) keeps its own message.
  if (error instanceof OwnerBootstrapRefusal || error instanceof OwnerBootstrapFailure) return error;
  const { code } = writeFailureInfo(error);
  if (isPasswordFormRefusal(error, ctx.passwordSent === true)) return 'verifier-refused';
  if (error instanceof WriteCommitError) {
    // A serialization failure or deadlock can surface at COMMIT; XX000 there is never a race.
    if (code === '40001' || code === '40P01') return 'race';
    if (code === 'XX000') return new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.commitInternalError(code), code);
    return new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.commitFailed(code), code);
  }
  if (RACE_SQLSTATES.has(code) || isConcurrentUpdate(error)) return 'race';
  if (code === '42501' || code === '22023' || code === '28P01') return new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.writeRefused(code), code);
  if (code === 'XX000') return new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.writeInternalError(code), code);
  return new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.writeFailed(code), code);
}

/** COMMIT, with a failure tagged as such (classifyWriteError tells a COMMIT refusal from a statement's). */
async function commitTagged(session: SqlSession): Promise<void> {
  try {
    await session.query(OWNER_BOOTSTRAP_COMMIT);
  } catch (error) {
    throw new WriteCommitError(error);
  }
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
   * Security re-review R1 of #259: Q3 as crewflow_owner with a deliberately WRONG password. `ok` means the server does not
   * check the password for crewflow_owner (trust / peer / cert / ...): refused. Absent = skipped (unit tests of other steps).
   */
  probeWrongPassword?(): Promise<ProbeResult>;
  /**
   * The capability check of PG_ADMIN_URL: throws PgSessionProbeError when the admin connection is not session-stable (a
   * pooler). Run once after the session pin, before any read or write. Absent = skipped (unit tests).
   */
  sessionProbe?(): Promise<void>;
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
async function assertNoOtherDatabase(session: SqlSession, refusal: string = OWNER_BOOTSTRAP_MESSAGES.ownerInOtherDatabase): Promise<void> {
  const { rows } = await session.query(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES);
  const v = rows.length === 1 ? rows[0]?.o_other_database : undefined;
  if (typeof v !== 'boolean') throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('other-database fact'));
  if (v) throw new OwnerBootstrapRefusal(refusal);
}

/** The facts, the decisions and the probe, in that order: one plan of what the write transaction must do. */
/** Security re-review R1 of #259: refused (64) when crewflow_owner can log in with a deliberately wrong password. */
async function assertPasswordRequired(io: OwnerBootstrapIo): Promise<void> {
  if (!io.probeWrongPassword) return;
  const wrong = await io.probeWrongPassword();
  if (wrong.ok) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.serverIgnoresPassword);
}

async function planFromDatabase(session: SqlSession, io: OwnerBootstrapIo, logNotes: boolean): Promise<WritePlan> {
  const facts = await readFacts(session);
  const notes = decideBeforeProbe(facts);
  if (logNotes) for (const note of notes) io.log(note);
  const probe = facts.ownerExists ? await io.probeOwner() : null;
  // A login that works is trusted only if a wrong password does NOT work (checked once per run, before the lock).
  if (logNotes && probe?.ok) await assertPasswordRequired(io);
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
type AttemptOutcome = OwnerBootstrapResult | 'recheck' | { race: WriteFailureInfo } | { verifierRefused: WriteFailureInfo };

async function attempt(session: SqlSession, io: OwnerBootstrapIo): Promise<AttemptOutcome> {
  const preLock = await planFromDatabase(session, io, true);
  if (!preLock.write) return { ...UNCHANGED };

  let plan: WritePlan = preLock;
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
    // Re-review F1 remainder: a blocked ALTER / CREATE ROLE fails (55P03) before log_lock_waits could quote the verifier.
    if (plan.needPassword) await session.query(OWNER_BOOTSTRAP_L1_LOCK_TIMEOUT);
    await session.query(OWNER_BOOTSTRAP_Q4C_DO);
    const { rows } = await session.query(OWNER_BOOTSTRAP_Q4D_REVERIFY);
    if (rows.length !== 1 || rows[0]?.ok !== true) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed);
    await commitTagged(session);
  } catch (error) {
    await session.query(OWNER_BOOTSTRAP_ROLLBACK).catch(() => undefined);
    const classified = classifyWriteError(error, { passwordSent: plan.needPassword });
    if (classified === 'race') return { race: writeFailureInfo(error) };
    if (classified === 'verifier-refused') return { verifierRefused: writeFailureInfo(error) };
    throw classified;
  }

  const after = await io.probeOwner();
  if (!after.ok) {
    // Only the grant was added (the password could not be checked before): a wrong password is set by the next attempt.
    if (after.code === '28P01' && !plan.needPassword) return 'recheck';
    throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed, after.code);
  }
  await assertPasswordRequired(io);
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

export function decideCreateRole(
  f: Pick<OwnerFacts, 'ownerExists' | 'oCreateRole' | 'oCreateRolePending' | 'oCreateRoleMarkExpired'>,
  schemaComplete: boolean,
): CreateRoleAction {
  if (!f.ownerExists) return 'none';
  if (f.oCreateRole === true) {
    if (schemaComplete) return 'remove';
    // Not complete yet: mark it (again, when an earlier mark expired: a first migrate that failed for a day).
    return f.oCreateRolePending && !f.oCreateRoleMarkExpired ? 'none' : 'mark';
  }
  return f.oCreateRolePending ? 'clear-mark' : 'none';
}

/**
 * Mode c (no admin): the same rule, read-only. Refuses (64) what the boot gate would refuse in production; returns the
 * notes to log otherwise.
 */
export function decideOwnerUrlCreateRole(
  f: Pick<OwnerFacts, 'oCreateRole' | 'oCreateRolePending' | 'oCreateRoleMarkExpired'>,
  schemaComplete: boolean,
): string[] {
  if (f.oCreateRole !== true) return [];
  if (schemaComplete) {
    if (!f.oCreateRolePending) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleComplete);
    if (f.oCreateRoleMarkExpired) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleExpired);
    return [OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleCompleteMarked];
  }
  if (!f.oCreateRolePending) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRolePendingUnmarked);
  if (f.oCreateRoleMarkExpired) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleExpiredBeforeStart);
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
async function applyCreateRoleStep(session: SqlSession, io: OwnerBootstrapIo, schemaComplete: boolean): Promise<CreateRoleOutcome | { race: WriteFailureInfo } | 'busy'> {
  const before = await readFacts(session);
  const preview = decideCreateRole(before, schemaComplete);
  if (preview === 'none') {
    if (before.ownerExists && before.oCreateRole === true) io.log(OWNER_BOOTSTRAP_MESSAGES.createRoleKeptMarked);
    return before.ownerExists && before.oCreateRole === true ? 'kept' : 'none';
  }
  // A removal never runs while a migrate child holds the migration lock (see OWNER_HARDEN_M1_TRY_MIGRATION_LOCK).
  let migrationLock = false;
  if (preview === 'remove') {
    const { rows } = await session.query(OWNER_HARDEN_M1_TRY_MIGRATION_LOCK);
    if (rows.length !== 1 || rows[0]?.got !== true) return 'busy';
    migrationLock = true;
  }
  try {
    return await applyCreateRoleTransaction(session, io, schemaComplete);
  } finally {
    if (migrationLock) await session.query(OWNER_HARDEN_M2_RELEASE_MIGRATION_LOCK).catch(() => undefined);
  }
}

async function applyCreateRoleTransaction(session: SqlSession, io: OwnerBootstrapIo, schemaComplete: boolean): Promise<CreateRoleOutcome | { race: WriteFailureInfo }> {
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
    // Security review of PR #246, L1: the role is cluster-wide, so a change another database's deployment would feel (its
    // CREATEROLE, its mark) runs only when no other database of the cluster uses crewflow_owner (Q2b, under the lock).
    await assertNoOtherDatabase(session, OWNER_BOOTSTRAP_MESSAGES.createRoleOtherDatabase);
    if (action === 'remove') {
      // Re-review R1: the legacy logins first (crewflow_owner could make them NOLOGIN only while it has CREATEROLE).
      const legacy = (await session.query(OWNER_HARDEN_R1_LEGACY_LOGINS)).rows.map((r) => String(r.name));
      for (const name of legacy) {
        const statement = LEGACY_NOLOGIN_SQL[name];
        if (!statement) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('legacy login'));
        try {
          await session.query(statement);
        } catch (error) {
          if (errorCode(error) === '42501') throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.legacyLoginsNoRights, '42501');
          throw error;
        }
      }
      if ((await session.query(OWNER_HARDEN_R1_LEGACY_LOGINS)).rows.length !== 0) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed);
      if (legacy.length) io.log(OWNER_BOOTSTRAP_MESSAGES.legacyLoginsDisabled(legacy.length));
      await session.query(OWNER_HARDEN_H1_NOCREATEROLE);
      if (f.oCreateRolePending) await session.query(OWNER_HARDEN_H2_CLEAR_MARK);
    } else if (action === 'clear-mark') {
      await session.query(OWNER_HARDEN_H2_CLEAR_MARK);
    } else {
      await session.query(OWNER_HARDEN_H3_MARK_PENDING);
    }
    const after = await readFacts(session);
    const ok =
      action === 'mark'
        ? after.oCreateRole === true && after.oCreateRolePending && !after.oCreateRoleMarkExpired
        : after.oCreateRole === false && !after.oCreateRolePending;
    if (!ok) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed);
    await commitTagged(session);
  } catch (error) {
    await session.query(OWNER_BOOTSTRAP_ROLLBACK).catch(() => undefined);
    const classified = classifyWriteError(error);
    // A concurrent db-setup on ANOTHER database of the cluster changed the same role row (roles are cluster-wide, the
    // advisory lock is per database): the caller re-runs the step from the facts, as attempt() does.
    if (classified === 'race') return { race: writeFailureInfo(error) };
    if (classified === 'verifier-refused') throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('password refusal without a password'));
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

/**
 * Owner decision 2026-11-19, option 1 ("Create login, you set password"): the server refused the pre-hashed password. Under
 * the advisory lock and the same refusals: a missing crewflow_owner is created WITHOUT a password, an existing one is left
 * exactly as it is (its password is never written here), and the grant is added when missing; then the fixed steps and
 * exit 64 (`awaiting-password`). When the server refuses the passwordless (NOLOGIN) role as well (the same classification),
 * nothing is created: the reviewed SQL with a placeholder is printed (option 2) and exit 64 (`awaiting-manual-role`).
 * One transaction (race retries aside); never a password write. Exported through bootstrapOwnerWithIo only.
 */
async function passwordlessSetup(session: SqlSession, io: OwnerBootstrapIo, refusedCode: string): Promise<OwnerBootstrapResult> {
  let lastRace: WriteFailureInfo | null = null;
  for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
    let existed = false;
    let needGrant = false;
    await session.query(OWNER_BOOTSTRAP_BEGIN);
    try {
      await session.query(OWNER_BOOTSTRAP_Q4A_LOCK);
      const f = await readFacts(session);
      decideBeforeProbe(f);
      existed = f.ownerExists;
      needGrant = !f.oHasDbGrant;
      if (existed && !needGrant) {
        await session.query(OWNER_BOOTSTRAP_ROLLBACK);
      } else {
        await session.query(OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT);
        await session.query(OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD);
        const { rows } = await session.query(OWNER_BOOTSTRAP_Q4D_NO_PASSWORD_REVERIFY);
        if (rows.length !== 1 || rows[0]?.ok !== true) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed);
        await commitTagged(session);
      }
    } catch (error) {
      await session.query(OWNER_BOOTSTRAP_ROLLBACK).catch(() => undefined);
      // Only a transaction that CREATED the passwordless (NOLOGIN) role can be a refusal of that form.
      const classified = classifyWriteError(error, { passwordSent: !existed });
      if (classified === 'verifier-refused') {
        const { stage, code } = writeFailureInfo(error);
        io.log(OWNER_BOOTSTRAP_MESSAGES.passwordlessRefused(stage, code));
        io.log(OWNER_BOOTSTRAP_MESSAGES.manualRoleStep);
        for (const line of OWNER_MANUAL_ROLE_SQL) io.log(`  ${line}`);
        io.log(OWNER_BOOTSTRAP_MESSAGES.awaitingManualRole);
        return { outcome: 'awaiting-manual-role', exitCode: 64, created: false, passwordSet: false, grantAdded: false, createRole: 'not-run', code };
      }
      if (classified !== 'race') throw classified;
      lastRace = writeFailureInfo(error);
      if (i < MAX_ATTEMPTS) {
        io.log(OWNER_BOOTSTRAP_MESSAGES.raceRetry(lastRace.stage, lastRace.code));
        await io.sleep(200 + Math.floor(Math.random() * 500));
      }
      continue;
    }
    assertFactsExact(await readFacts(session));
    io.log(existed ? OWNER_BOOTSTRAP_MESSAGES.passwordlessKept : OWNER_BOOTSTRAP_MESSAGES.passwordlessCreated);
    io.log(OWNER_BOOTSTRAP_MESSAGES.setPasswordStep);
    io.log(OWNER_BOOTSTRAP_MESSAGES.awaitingPassword);
    return { outcome: 'awaiting-password', exitCode: 64, created: !existed, passwordSet: false, grantAdded: needGrant, createRole: 'not-run', code: refusedCode };
  }
  throw new OwnerBootstrapFailure(raceExhaustedMessage(lastRace), lastRace?.code ?? null);
}

/** The race-exhausted line with the last race's stage and SQLSTATE (a re-check loop has none). */
function raceExhaustedMessage(race: WriteFailureInfo | null): string {
  return OWNER_BOOTSTRAP_MESSAGES.raceExhausted(race?.stage ?? 'statement', race?.code ?? 'none');
}

/** Modes a and b on the admin login. Exported for the integration harness and the unit tests. */
export async function bootstrapOwnerWithIo(io: OwnerBootstrapIo, retryWindowMs = ADMIN_CONNECT_RETRY_WINDOW_MS): Promise<OwnerBootstrapResult> {
  let session: SqlSession | null = null;
  try {
    session = await connectAdminWithRetry(io, retryWindowMs);
    await session.query(OWNER_BOOTSTRAP_Q0_SESSION);
    await session.query(OWNER_BOOTSTRAP_Q1_SUPERUSER_LOGGING);
    // Capability, not a host name: a PG_ADMIN_URL that is not session-stable is a pooler (refused before any read or write).
    if (io.sessionProbe) {
      try {
        await io.sessionProbe();
      } catch (error) {
        if (error instanceof PgSessionProbeError) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminNotSessionStable);
        throw error;
      }
    }
    let result: OwnerBootstrapResult | null = null;
    let lastRace: WriteFailureInfo | null = null;
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const r = await attempt(session, io);
      if (r !== 'recheck' && 'verifierRefused' in r) {
        // Owner decision 2026-11-19, option 1: never a plain-text password; a passwordless crewflow_owner and fixed steps.
        const { stage, code } = r.verifierRefused;
        io.log(OWNER_BOOTSTRAP_MESSAGES.verifierRefused(stage, code));
        return await passwordlessSetup(session, io, code);
      }
      if (r !== 'recheck' && !('race' in r)) {
        result = r;
        break;
      }
      if (r !== 'recheck') lastRace = r.race;
      if (i < MAX_ATTEMPTS) {
        io.log(r === 'recheck' ? OWNER_BOOTSTRAP_MESSAGES.passwordRecheck : OWNER_BOOTSTRAP_MESSAGES.raceRetry(r.race.stage, r.race.code));
        await io.sleep(200 + Math.floor(Math.random() * 500)); // jitter, so two colliding starts do not collide again
      }
    }
    if (!result) throw new OwnerBootstrapFailure(raceExhaustedMessage(lastRace), lastRace?.code ?? null);
    if (!io.schemaComplete) return result;
    const complete = await io.schemaComplete();
    lastRace = null;
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const createRole = await applyCreateRoleStep(session, io, complete);
      if (createRole === 'busy') {
        io.log(OWNER_BOOTSTRAP_MESSAGES.createRoleBusyKept);
        return { ...result, createRole: 'kept' };
      }
      if (typeof createRole === 'string') return { ...result, createRole };
      lastRace = createRole.race;
      if (i < MAX_ATTEMPTS) {
        io.log(OWNER_BOOTSTRAP_MESSAGES.raceRetry(createRole.race.stage, createRole.race.code));
        await io.sleep(200 + Math.floor(Math.random() * 500));
      }
    }
    throw new OwnerBootstrapFailure(raceExhaustedMessage(lastRace), lastRace?.code ?? null);
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
  // Lead audit 2026-11-19 (item 6) asked mode c to refuse a crewflow_owner that owns the database. NOT done: the reviewed
  // N1 rule (security re-review N1; transition-from-separated.sql, runbook §5) keeps mode c the supported path for exactly
  // that database shape (owner rab_owner, crewflow_owner an INHERIT member), and the live harness scenario
  // n1-transition-shaped-database fails with the refusal. Owner decision pending; the admin path keeps refusing it (H1).
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

/**
 * PG_ADMIN_DIRECT_URL (owner decision 2026-11-19; db-setup and db-harden only): the direct address of the PG_ADMIN_URL login,
 * for an operator who pastes a pooled admin URL as-is. Both must parse and name the SAME user and database (only the address
 * may differ; host names are never derived). When set, db-setup connects with it: the copy of the environment it returns has
 * PG_ADMIN_URL = PG_ADMIN_DIRECT_URL (the rest of db-setup, including selectDbSetupInput, sees only the direct address).
 * process.env is never changed. Throws OwnerBootstrapRefusal (fixed text, values never shown).
 */
export function applyAdminDirectUrl(env: Record<string, string | undefined>): { env: Record<string, string | undefined>; used: boolean } {
  const value = (name: string): string | undefined => {
    const v = env[name];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const direct = value(ADMIN_DIRECT_URL_LABEL);
  if (direct === undefined) return { env, used: false };
  const admin = value(ADMIN_URL_LABEL);
  if (admin === undefined) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminDirectWithoutAdmin);
  let a;
  let d;
  try {
    a = parsePgUrl(admin, ADMIN_URL_LABEL);
    d = parsePgUrl(direct, ADMIN_DIRECT_URL_LABEL);
  } catch (error) {
    if (error instanceof PgConfigError) throw new OwnerBootstrapRefusal(error.message);
    throw error;
  }
  if (a.user !== d.user || a.database !== d.database) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminDirectMismatch);
  const copy: Record<string, string | undefined> = { ...env, [ADMIN_URL_LABEL]: direct };
  delete copy[ADMIN_DIRECT_URL_LABEL];
  return { env: copy, used: true };
}

/**
 * PG_DATABASE_SESSION_URL (PR #258): when set, db-setup's crewflow_owner sessions (the probe, the ledger read, mode c) use
 * it instead of PG_DATABASE_URL, and the "same database as the admin" rule compares the admin address with it. It must parse
 * and name the same user, password and database as PG_DATABASE_URL (otherwise the password db-setup sets would not be the
 * one rab-api / rab-worker log in with). The copy of the environment returned has PG_DATABASE_URL = the session URL;
 * process.env is never changed. Throws OwnerBootstrapRefusal (fixed text).
 */
export function applyAppSessionUrl(env: Record<string, string | undefined>): { env: Record<string, string | undefined>; used: boolean } {
  const value = (name: string): string | undefined => {
    const v = env[name];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const session = value(APP_SESSION_URL_LABEL);
  if (session === undefined) return { env, used: false };
  const app = value('PG_DATABASE_URL');
  if (app === undefined) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.appSessionWithoutApp);
  let a;
  let d;
  try {
    a = parsePgUrl(app, 'PG_DATABASE_URL');
    d = parsePgUrl(session, APP_SESSION_URL_LABEL);
  } catch (error) {
    if (error instanceof PgConfigError) throw new OwnerBootstrapRefusal(error.message);
    throw error;
  }
  if (a.user !== d.user || a.database !== d.database || a.password !== d.password) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.appSessionMismatch);
  const copy: Record<string, string | undefined> = { ...env, PG_DATABASE_URL: session };
  delete copy[APP_SESSION_URL_LABEL];
  return { env: copy, used: true };
}

/** selectDbSetupInput, with a host / port / database mismatch worded with the direct-address option. */
function selectInput(env: Record<string, string | undefined>, directUsed: boolean): DbSetupInput {
  try {
    return selectDbSetupInput(env);
  } catch (error) {
    if (error instanceof OwnerCredentialError) {
      if (error.message === DB_SETUP_INPUT_MESSAGES.targetMismatch && !directUsed) {
        throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminTargetMismatch);
      }
      throw new OwnerBootstrapRefusal(error.message);
    }
    throw error;
  }
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
    // PG_ADMIN_DIRECT_URL first (db-setup's own copy of the environment), then the single decision (owner-credential.ts
    // selectDbSetupInput), refused (fixed text) BEFORE anything connects.
    const direct = applyAdminDirectUrl(env);
    env = direct.env;
    if (direct.used) log(OWNER_BOOTSTRAP_MESSAGES.adminDirectUsed);
    const appSession = applyAppSessionUrl(env);
    env = appSession.env;
    if (appSession.used) log(OWNER_BOOTSTRAP_MESSAGES.appSessionUsed);
    const input = selectInput(env, direct.used);
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
    // Security re-review R1 of #259: the same crewflow_owner login with a random WRONG password (never a real secret).
    const wrongUrl = new URL(input.appUrl);
    wrongUrl.password = randomBytes(24).toString('hex');
    const { probe: wrongProbeConfig } = bootstrapDriverConfigs(resolved, wrongUrl.toString());
    let result: OwnerBootstrapResult;
    if (input.mode === 'owner-url') {
      // I1: the crewflow_owner session is read-only (default_transaction_read_only=on as a startup option).
      result = await setupOwnerUrlWithIo({ openUrl: () => connectSession(ownerUrlConfig), expectedMigrations, log, sleep, now }, retryWindowMs);
    } else {
      const io: OwnerBootstrapIo = {
        openAdmin: () => connectSession(adminConfig),
        probeOwner: () => probeOwnerOnce(probeConfig),
        verifier: () => scramSha256Verifier(ownerPassword),
        probeWrongPassword: () => probeOwnerOnce(wrongProbeConfig),
        sessionProbe: async () => {
          await probePgSessionAffinity(adminConfig, { label: 'PG_ADMIN_URL connection' });
        },
        schemaComplete: () => schemaCompleteOn(ownerUrlConfig, expectedMigrations),
        log,
        sleep,
        now,
      };
      result = await bootstrapOwnerWithIo(io, retryWindowMs);
    }
    if (result.exitCode === 0) log(OWNER_BOOTSTRAP_MESSAGES.ready(describeReady(result)));
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

/** Re-exported for the specs and the harness: the prefix of the mark db-setup writes (`<prefix><unix expiry>`). */
export { OWNER_CREATEROLE_MARK_PREFIX };

// ---------------------------------------------------------------------------------------------------------------------
// db-harden (owner decision M1, "auto-close plus a grace period"): the one-shot service that removes CREATEROLE in the SAME
// deploy as the first migrate. Same code path as db-setup's CREATEROLE step (applyCreateRoleStep: the advisory lock, the facts
// again under it, the Q2b other-database refusal, the statements, the re-check). It never creates a role, never sets a
// password, never touches a grant. It polls by itself (OpenShip may ignore depends_on conditions) and nothing waits for it.
// ---------------------------------------------------------------------------------------------------------------------

export const HARDEN_DEFAULT_TIMEOUT_SECONDS = 1200;
export const HARDEN_POLL_INTERVAL_MS = 10_000;
/** Connect / login errors that only mean "not ready yet" while polling (the db starting, db-setup still running). */
const HARDEN_NOT_READY_CODES = new Set(['ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', '57P03', '28P01', '28000', '3D000']);

/** CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: unset = 1200; whole seconds 60-7200 (1-7200 with NODE_ENV=test). Throws a refusal. */
export function hardenTimeoutSeconds(env: Record<string, string | undefined>): number {
  const raw = env.CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS;
  if (raw === undefined || raw.trim() === '') return HARDEN_DEFAULT_TIMEOUT_SECONDS;
  const min = env.NODE_ENV === 'test' ? 1 : 60;
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < min || Number(raw) > 7200) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.hardenTimeoutSetting);
  return Number(raw);
}

export interface HardenIo {
  /** One admin session (one attempt; a not-ready error is retried by the poll loop). */
  openAdmin(): Promise<SqlSession>;
  /** Is the schema complete for this image? null = not readable yet (crewflow_owner cannot log in yet, db starting). */
  schemaComplete(): Promise<boolean | null>;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  timeoutSeconds: number;
  pollIntervalMs?: number;
  /** Security review F5 of #259: the capability check of the admin connection, once, before any change (as in db-setup). */
  sessionProbe?(): Promise<void>;
}

/**
 * The db-harden loop. Each round: open the admin session (a not-ready error waits), read the facts: no crewflow_owner yet ->
 * wait (db-setup has not run yet); NOCREATEROLE and unmarked -> "already hardened", exit 0 at once; otherwise ask whether the
 * schema is complete (read-only, as crewflow_owner): yes -> the CREATEROLE step (remove, or clear a leftover mark) and exit 0;
 * no -> wait. Past the deadline -> failure 70, nothing changed. A refusal (rights, Q2b, a privileged role) stops at once.
 */
export async function hardenOwnerWithIo(io: HardenIo): Promise<OwnerBootstrapResult> {
  const deadline = io.now() + io.timeoutSeconds * 1000;
  const pollMs = io.pollIntervalMs ?? HARDEN_POLL_INTERVAL_MS;
  let waitingLogged: string | null = null;
  const waiting = (line: string) => {
    if (waitingLogged !== line) io.log(line);
    waitingLogged = line;
  };
  const base: OwnerBootstrapResult = { outcome: 'unchanged', exitCode: 0, created: false, passwordSet: false, grantAdded: false, createRole: 'none', code: null };
  let probed = false;
  for (;;) {
    let session: SqlSession | null = null;
    try {
      try {
        session = await io.openAdmin();
      } catch (error) {
        const code = errorCode(error);
        if (!RETRYABLE_CONNECT_CODES.has(code) && !['ENOTFOUND'].includes(code)) throw classifyAdminConnectError(error, false);
      }
      if (session) {
        await session.query(OWNER_BOOTSTRAP_Q0_SESSION);
        await session.query(OWNER_BOOTSTRAP_Q1_SUPERUSER_LOGGING);
        if (io.sessionProbe && !probed) {
          try {
            await io.sessionProbe();
          } catch (error) {
            if (error instanceof PgSessionProbeError) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.adminNotSessionStable);
            throw error;
          }
          probed = true;
        }
        const f = await readFacts(session);
        if (!f.ownerExists) waiting(OWNER_BOOTSTRAP_MESSAGES.hardenWaitingForRole);
        else if (f.oCreateRole !== true && !f.oCreateRolePending) {
          io.log(OWNER_BOOTSTRAP_MESSAGES.hardenAlready);
          return { ...base };
        } else {
          const complete = await io.schemaComplete();
          if (complete === true) {
            const stepIo: OwnerBootstrapIo = { openAdmin: io.openAdmin, probeOwner: async () => ({ ok: true }), verifier: () => '', log: io.log, sleep: io.sleep, now: io.now };
            let busy = false;
            let lastRace: WriteFailureInfo | null = null;
            for (let i = 1; i <= MAX_ATTEMPTS && !busy; i += 1) {
              const createRole = await applyCreateRoleStep(session, stepIo, true);
              if (createRole === 'busy') busy = true;
              else if (typeof createRole === 'string') return { ...base, createRole };
              else {
                lastRace = createRole.race;
                if (i < MAX_ATTEMPTS) await io.sleep(200 + Math.floor(Math.random() * 500));
              }
            }
            if (!busy) throw new OwnerBootstrapFailure(raceExhaustedMessage(lastRace), lastRace?.code ?? null);
            waiting(OWNER_BOOTSTRAP_MESSAGES.hardenWaitingForMigration);
          } else waiting(OWNER_BOOTSTRAP_MESSAGES.hardenWaitingForSchema);
        }
      }
    } finally {
      await closeQuietly(session);
    }
    if (io.now() + pollMs > deadline) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.hardenTimeout(io.timeoutSeconds), 'TIMEOUT');
    await io.sleep(pollMs);
  }
}

/** Is the schema complete? null when the crewflow_owner session cannot be opened yet (HARDEN_NOT_READY_CODES). */
async function schemaCompleteOrNotReady(config: PgDriverConfig, expected: () => string[]): Promise<boolean | null> {
  try {
    return await schemaCompleteOn(config, expected);
  } catch (error) {
    if (error instanceof OwnerBootstrapFailure && error.code && HARDEN_NOT_READY_CODES.has(error.code)) return null;
    throw error;
  }
}

export interface RunOwnerHardenOptions extends RunOwnerBootstrapOptions {
  /** Test seam: the poll interval (default 10 s). */
  pollIntervalMs?: number;
}

/** db-harden for one environment (the child passes process.env with `--harden`). Never throws; exit 0, 64 or 70. */
export async function runOwnerHarden(env: Record<string, string | undefined>, options: RunOwnerHardenOptions = {}): Promise<OwnerBootstrapResult> {
  const log = options.log ?? (() => undefined);
  try {
    const timeoutSeconds = hardenTimeoutSeconds(env);
    const direct = applyAdminDirectUrl(env);
    env = direct.env;
    if (direct.used) log(OWNER_BOOTSTRAP_MESSAGES.adminDirectUsed);
    const appSession = applyAppSessionUrl(env);
    env = appSession.env;
    if (appSession.used) log(OWNER_BOOTSTRAP_MESSAGES.appSessionUsed);
    const input = selectInput(env, direct.used);
    if (input.mode === 'owner-url') {
      log(OWNER_BOOTSTRAP_MESSAGES.hardenNoAdmin);
      return { outcome: 'unchanged', exitCode: 0, created: false, passwordSet: false, grantAdded: false, createRole: 'not-run', code: null };
    }
    const resolved = resolveFor(env, input.url, input.name);
    const appResolved = resolveFor(env, input.appUrl, 'PG_DATABASE_URL');
    if (resolved.primary.target.sessionRoleOption || appResolved.primary.target.sessionRoleOption) {
      throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.sessionRoleOption);
    }
    const expectedMigrations = options.expectedMigrations ?? (() => imageMigrationNames());
    const { admin: adminConfig, ownerUrl: ownerUrlConfig } = bootstrapDriverConfigs(resolved, input.appUrl);
    const result = await hardenOwnerWithIo({
      openAdmin: () => connectSession(adminConfig),
      schemaComplete: () => schemaCompleteOrNotReady(ownerUrlConfig, expectedMigrations),
      log,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      timeoutSeconds,
      pollIntervalMs: options.pollIntervalMs,
      sessionProbe: async () => {
        await probePgSessionAffinity(adminConfig, { label: 'PG_ADMIN_URL connection' });
      },
    });
    return result;
  } catch (error) {
    if (error instanceof OwnerBootstrapRefusal || error instanceof OwnerBootstrapFailure) log(error.message);
    else if (error instanceof OwnerCredentialError) log(error.message);
    else log(OWNER_BOOTSTRAP_MESSAGES.unexpected(errorCode(error)));
    if (error instanceof OwnerCredentialError) return failureResult(new OwnerBootstrapRefusal(error.message));
    return failureResult(error);
  }
}
