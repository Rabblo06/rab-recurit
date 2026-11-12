/**
 * DB setup like Twenty (DB-SETUP-PLAN §3, area 2): the core of the bootstrap child. The ONLY code in Crewflow that connects
 * with the database ADMIN URL. It makes sure `crewflow_owner` exists with exactly the 01-crewflow-owner.sql attributes, the
 * derived password (HKDF of APP_SECRET, area 1) and `CONNECT, CREATE, TEMPORARY ... WITH GRANT OPTION` on the current
 * database, then exits. The entry is bootstrap-owner-login.ts; api-prestart.sh runs it before the migrate child.
 *
 * Flow
 *   1. planOwnerLogin (area 1, owner-credential.ts): URL login crewflow_owner => PASS-THROUGH (§7.1): no connection at all,
 *      APP_SECRET plays no part, exit 0. Otherwise the derived password and runtime URL, BEFORE anything connects; a
 *      missing/short APP_SECRET, a policy-refused URL or a pooler shape refuses here (exit 64).
 *   2-3. The same URL resolved through the shared factory (URL policy, TLS: verify-full in production).
 *   4. Admin session (application_name crewflow-owner-bootstrap; retried for up to 60 s on connection-refused / 57P03):
 *      Q0, Q1 (session hardening), Q2 (facts). Decisions (§3.3) — a refusal is exit 64 with a fixed message.
 *   5. Q3 probe (only when the role exists): a second, short connection as crewflow_owner with the derived password.
 *      Success => the password is NOT touched (idempotent restart: the stored verifier, salt included, stays byte-identical).
 *   6. Only when something is missing: the write transaction (Q4a lock, Q4b inputs as bind parameters, Q4c DO block,
 *      Q4d re-verify), COMMIT; then the probe again (must succeed) and Q2 again (must be exact), else exit 70.
 *
 * Exit codes: 0 ok (incl. pass-through), 64 refusal (configuration / rights / a privileged crewflow_owner), 70 unexpected.
 *
 * Output: fixed strings plus a SQLSTATE at most. Never a URL, a password, a verifier, a host, a database or a login name,
 * and never a driver error's message / detail / where (they can quote values). The plaintext password exists only in this
 * process's memory; the server only ever receives the SCRAM verifier (§3.6).
 */
import { Client } from 'pg';

import { OwnerCredentialError, type OwnerLoginPlan, planOwnerLogin, scramSha256Verifier } from '../../../owner-login/owner-credential';
import { pgClientConfig, PgConfigError, PgDriverConfig, readPrimaryDatabaseUrl, resolvePgEnvironment, ResolvedPgEnvironment, sameTarget } from '../../../postgres';
import {
  OWNER_BOOTSTRAP_BEGIN,
  OWNER_BOOTSTRAP_COMMIT,
  OWNER_BOOTSTRAP_Q0_SESSION,
  OWNER_BOOTSTRAP_Q1_SUPERUSER_LOGGING,
  OWNER_BOOTSTRAP_Q2_FACTS,
  OWNER_BOOTSTRAP_Q3_PROBE,
  OWNER_BOOTSTRAP_Q4A_LOCK,
  OWNER_BOOTSTRAP_Q4B_SET_INPUTS,
  OWNER_BOOTSTRAP_Q4C_DO,
  OWNER_BOOTSTRAP_Q4D_REVERIFY,
  OWNER_BOOTSTRAP_ROLLBACK,
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
/** CREATE ROLE races between two DATABASES of one cluster (the advisory lock is per database): re-run from the facts. */
export const MAX_ATTEMPTS = 3;

/** Every fixed line this module can print (tests assert them exactly). */
export const OWNER_BOOTSTRAP_MESSAGES = Object.freeze({
  passThrough: 'PG_DATABASE_URL is the crewflow_owner login: the database setup step is skipped.',
  pgTooOld: 'PostgreSQL 16 or later is required.',
  privilegedAttributes: (attributes: readonly string[]) =>
    `crewflow_owner exists with ${attributes.join(', ')}; Crewflow never runs as a privileged login. Fix the role (ALTER ROLE crewflow_owner NOSUPERUSER ...) or drop it; the API never changes an existing role's attributes.`,
  noCreateRoleHardened: "crewflow_owner is NOCREATEROLE (hardened); a release that creates roles will need it back.",
  privilegedMembership: 'crewflow_owner is a member of a superuser, BYPASSRLS or predefined privileged role.',
  expired: "crewflow_owner's VALID UNTIL has passed; clear it (ALTER ROLE crewflow_owner VALID UNTIL 'infinity').",
  adminCannotCreateRoles: "The PG_DATABASE_URL login cannot create roles (needs CREATEROLE, or use the provider's admin login).",
  adminCannotGrantDb:
    'The PG_DATABASE_URL login cannot grant CONNECT, CREATE, TEMPORARY on this database (it must own the database or hold those privileges WITH GRANT OPTION).',
  adminNoAdminOption:
    "crewflow_owner's password must be reset but the PG_DATABASE_URL login has no ADMIN OPTION on it (it was created by another login). Run, as that login or a superuser: GRANT crewflow_owner TO <your admin> WITH ADMIN OPTION; or reset it by hand with 01-crewflow-owner.sql.",
  adminCannotResetPassword:
    "crewflow_owner's password must be reset but the PG_DATABASE_URL login cannot change another role's password (it needs CREATEROLE and ADMIN OPTION on crewflow_owner, or superuser). Or reset it by hand with 01-crewflow-owner.sql.",
  probeFailed: (sqlstateClass: string) =>
    `crewflow_owner could not log in for a reason other than its password (SQLSTATE class ${sqlstateClass}); check pg_hba.conf and the role. Refusing.`,
  sessionRoleOption: 'PG_DATABASE_URL carries options=-c role=...; the database setup step connects as the URL login itself. Remove it. Refusing.',
  adminAuth: (sqlstate: string) =>
    `The database refused the PG_DATABASE_URL login (SQLSTATE ${sqlstate}: wrong password, or pg_hba.conf does not allow it). Refusing.`,
  adminNoDatabase: 'The database named in PG_DATABASE_URL does not exist (SQLSTATE 3D000). Refusing.',
  adminTls: 'TLS to the database failed (certificate, host name, or the server has no TLS). Check sslmode in PG_DATABASE_URL and PG_SSL_CA_CERT_PATH. Refusing.',
  adminUnreachable: 'The database did not accept a connection within 60 s. Giving up (the restart policy retries).',
  adminConnectFailed: (code: string) => `Connecting with PG_DATABASE_URL failed (${code}).`,
  writeRefused: (sqlstate: string) =>
    `The database refused to create or update crewflow_owner (SQLSTATE ${sqlstate}): the PG_DATABASE_URL login lacks a needed right, or the provider refuses a pre-hashed password (then set crewflow_owner up by hand with 01-crewflow-owner.sql and put its URL in PG_DATABASE_URL). Refusing.`,
  writeFailed: (sqlstate: string) => `Setting up crewflow_owner failed (SQLSTATE ${sqlstate}). Nothing was committed.`,
  reverifyFailed: 'crewflow_owner is not exactly as required after the setup step (attributes, grant or login). Refusing to continue.',
  raceRetry: 'crewflow_owner was being created by another start at the same moment; reading the facts again.',
  raceExhausted: 'crewflow_owner kept changing while this start tried to set it up. Giving up (the restart policy retries).',
  unexpected: (code: string) => `Unexpected failure (${code}). Nothing secret is printed; see the database log for the SQLSTATE.`,
  ready: (what: string) => `crewflow_owner is ready (${what}).`,
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
}

type Row = Record<string, unknown>;

const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : v === true);

export function factsFromRow(row: Row | undefined): OwnerFacts {
  if (!row) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('facts query returned no row'));
  const count = row.o_privileged_memberships;
  return {
    serverVersionNum: Number(row.server_version_num),
    adminSuper: row.admin_super === true,
    adminCreateRole: row.admin_createrole === true,
    adminCanGrantDb: row.admin_can_grant_db === true,
    ownerExists: row.owner_exists === true,
    oLogin: bool(row.o_login),
    oSuper: bool(row.o_super),
    oBypassRls: bool(row.o_bypassrls),
    oReplication: bool(row.o_replication),
    oCreateDb: bool(row.o_createdb),
    oCreateRole: bool(row.o_createrole),
    oInherit: bool(row.o_inherit),
    oExpired: bool(row.o_expired),
    adminHasAdminOption: row.admin_has_admin_option === true,
    oPrivilegedMemberships: count === null || count === undefined ? null : Number(count),
    oHasDbGrant: row.o_has_db_grant === true,
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
 * §3.4 + the last row of §3.3. `probe` is null when the role does not exist (nothing to probe).
 *   success                          => the password is right; never touched;
 *   28P01                            => the password must be set (needs superuser, or CREATEROLE + ADMIN OPTION);
 *   42501 while the grant is missing => CONNECT is not granted yet, so the password is unknown: set it with the grant;
 *   anything else                    => refused with the SQLSTATE class only.
 */
export function planWrite(f: OwnerFacts, probe: ProbeResult | null): WritePlan {
  const create = !f.ownerExists;
  let needPassword = create;
  if (!create) {
    if (!probe) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('no probe for an existing role'));
    if (!probe.ok) {
      if (probe.code === '28P01' || (probe.code === '42501' && !f.oHasDbGrant)) needPassword = true;
      else throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.probeFailed(sqlstateClass(probe.code)), probe.code);
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
  const code = errorCode(error);
  if (code === '42710' || code === '23505') return 'race';
  if (code === '42501' || code === '22023' || code === '28P01') return new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.writeRefused(code), code);
  if (error instanceof OwnerBootstrapRefusal || error instanceof OwnerBootstrapFailure) return error;
  return new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.writeFailed(code), code);
}

export interface SqlSession {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}

export interface OwnerBootstrapIo {
  /** Opens one admin session (one attempt; the runner retries). */
  openAdmin(): Promise<SqlSession>;
  /** Q3 as crewflow_owner with the derived password; resolves to ok, or the error code. */
  probeOwner(): Promise<ProbeResult>;
  /** A fresh SCRAM verifier of the derived password. */
  verifier(): string;
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

/** One attempt: facts, decisions, probe, write. Returns 'race' when a concurrent CREATE ROLE won (re-run from the facts). */
async function attempt(session: SqlSession, io: OwnerBootstrapIo): Promise<OwnerBootstrapResult | 'race'> {
  const facts = await readFacts(session);
  for (const note of decideBeforeProbe(facts)) io.log(note);
  const probe = facts.ownerExists ? await io.probeOwner() : null;
  const plan = planWrite(facts, probe);
  if (!plan.write) return { outcome: 'unchanged', exitCode: 0, created: false, passwordSet: false, grantAdded: false, code: null };

  // Only computed when it is needed; never sent when the password stays (an empty value, unused by the DO block).
  const verifier = plan.needPassword ? io.verifier() : '';
  await session.query(OWNER_BOOTSTRAP_BEGIN);
  try {
    await session.query(OWNER_BOOTSTRAP_Q4A_LOCK);
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
  if (!after.ok) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed, after.code);
  assertFactsExact(await readFacts(session));
  return {
    outcome: plan.create ? 'created' : 'updated',
    exitCode: 0,
    created: plan.create,
    passwordSet: plan.needPassword,
    grantAdded: plan.needGrant,
    code: null,
  };
}

/** Steps 4-6 on an already-derived credential. Exported for the integration harness and the unit tests. */
export async function bootstrapOwnerWithIo(io: OwnerBootstrapIo, retryWindowMs = ADMIN_CONNECT_RETRY_WINDOW_MS): Promise<OwnerBootstrapResult> {
  let session: SqlSession | null = null;
  try {
    session = await connectAdminWithRetry(io, retryWindowMs);
    await session.query(OWNER_BOOTSTRAP_Q0_SESSION);
    await session.query(OWNER_BOOTSTRAP_Q1_SUPERUSER_LOGGING);
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const result = await attempt(session, io);
      if (result !== 'race') return result;
      if (i < MAX_ATTEMPTS) io.log(OWNER_BOOTSTRAP_MESSAGES.raceRetry);
    }
    throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.raceExhausted);
  } finally {
    await closeQuietly(session);
  }
}

function describeReady(result: OwnerBootstrapResult): string {
  if (result.created) return 'created';
  const parts: string[] = [];
  if (result.passwordSet) parts.push('password set');
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

export interface RunOwnerBootstrapOptions {
  log?: (line: string) => void;
  /** Test seam (integration harness): a shorter connect-retry window. */
  retryWindowMs?: number;
}

/**
 * The whole step for one environment (the child passes process.env). Never throws: every failure becomes a result with
 * exit code 64 or 70, and the one printed line for it is fixed text.
 */
export async function runOwnerBootstrap(env: Record<string, string | undefined>, options: RunOwnerBootstrapOptions = {}): Promise<OwnerBootstrapResult> {
  const log = options.log ?? (() => undefined);
  try {
    // Area 1's single decision (owner-credential.ts), shared with the derive step so the two can never disagree. Pure:
    // pass-through for a crewflow_owner URL (APP_SECRET not read), else the derived password and runtime URL, refused
    // (OwnerCredentialError, fixed text) BEFORE anything connects. Only PG_DATABASE_URL, never a legacy name.
    const primary = readPrimaryDatabaseUrl(env);
    let plan: OwnerLoginPlan;
    try {
      plan = planOwnerLogin({ databaseUrl: primary?.name === 'PG_DATABASE_URL' ? primary.value : undefined, appSecret: env.APP_SECRET });
    } catch (error) {
      if (error instanceof OwnerCredentialError) throw new OwnerBootstrapRefusal(error.message);
      throw error;
    }
    if (plan.mode === 'pass-through') {
      log(OWNER_BOOTSTRAP_MESSAGES.passThrough);
      return { outcome: 'pass-through', exitCode: 0, created: false, passwordSet: false, grantAdded: false, code: null };
    }

    let resolved: ResolvedPgEnvironment;
    try {
      // The migrate process role: the same URL policy and TLS as every process, and a transaction-pooler shape is refused
      // (the bootstrap needs one real session). The runtime login check (area 4) does not apply to this step.
      resolved = resolvePgEnvironment(env, { processRole: 'migrate' });
    } catch (error) {
      if (error instanceof PgConfigError) throw new OwnerBootstrapRefusal(error.message);
      throw error;
    }
    if (resolved.primary.target.sessionRoleOption) throw new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.sessionRoleOption);
    if (!sameTarget(resolved.primary.target, plan.adminTarget)) throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.unexpected('admin target mismatch'));
    const ownerPassword = plan.ownerPassword;

    const adminConfig: PgDriverConfig = {
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
    const probeConfig: PgDriverConfig = {
      ...pgClientConfig(resolved, {
        url: plan.runtimeUrl,
        urlLabel: 'the derived crewflow_owner connection',
        purpose: 'owner-probe',
        sessionAffinity: true,
        statementTimeoutMs: 10_000,
        queryTimeoutMs: 15_000,
        connectTimeoutMs: 10_000,
      }),
      application_name: OWNER_PROBE_APPLICATION_NAME,
    };

    const io: OwnerBootstrapIo = {
      async openAdmin() {
        const client = openClient(adminConfig);
        client.on('error', () => undefined); // a dropped idle connection must not crash the process with its message
        try {
          await client.connect();
        } catch (error) {
          await client.end().catch(() => undefined);
          throw error;
        }
        return client as unknown as SqlSession;
      },
      async probeOwner() {
        const client = openClient(probeConfig);
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
      },
      verifier: () => scramSha256Verifier(ownerPassword),
      log,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    };
    const result = await bootstrapOwnerWithIo(io, options.retryWindowMs ?? ADMIN_CONNECT_RETRY_WINDOW_MS);
    log(OWNER_BOOTSTRAP_MESSAGES.ready(describeReady(result)));
    return result;
  } catch (error) {
    if (error instanceof OwnerBootstrapRefusal || error instanceof OwnerBootstrapFailure) log(error.message);
    else log(OWNER_BOOTSTRAP_MESSAGES.unexpected(errorCode(error)));
    return failureResult(error);
  }
}

/** The one machine-readable line (enums, booleans and a SQLSTATE only). */
export function resultLine(result: OwnerBootstrapResult): string {
  return `${OWNER_BOOTSTRAP_RESULT_PREFIX} ${JSON.stringify(result)}`;
}
