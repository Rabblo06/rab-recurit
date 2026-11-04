// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, function, role and policy names, numeric limits) or a validated identifier; no request or row data reaches these templates. Reviewed 2026-11-04 (owner-login SQL-injection lint).
/**
 * Phase B database boot gates: the RULES (pure decisions over an injected query function, and the bounded retry).
 * No DataSource, no connection options: unit-testable without a database. The entrypoint that opens the connection
 * is database-boot-gates.ts (runDatabaseBootGates), which re-exports everything here. See that file for the gate list.
 */
import { assertDeploymentIdentity, DeploymentIdentityError, Query } from '../deployment-identity/deployment-identity';
import { dispatchNotifyFor } from '../postgres/pg-config';
import { PgConfigError } from '../postgres/pg-url-policy';
import { OWNER_LOGIN_ROLE, ownerLoginObjectPostureProblems, ownerLoginRolePostureProblems } from './owner-login-posture';
import { SchemaCompatibilityError } from './schema-compatibility';

export type BootProcess = 'api' | 'worker' | 'cli' | 'provisioner';
export type BootRole = 'crewflow_owner' | 'crewflow_app' | 'crewflow' | 'crewflow_worker';

/**
 * Owner-login architecture (owner's final decision 2026-11-04, PERMANENT): every process — API, Worker (either claim
 * mode), CLI, provisioner (in-process), replica validation and the migration child — connects as the ONE schema-owning
 * login `crewflow_owner` (M0 §5.1 shape). A code constant, never env. The former per-process restricted logins
 * (crewflow_app for the API/CLI, crewflow_worker for the global-mode Worker, crewflow for the provisioner) are SCHEMA roles
 * now; a process that connects as one of them is refused (gate 1). Every behaviour that changed is catalogued with a test
 * and a severity in owner-login-behaviour-catalogue.ts.
 */
export const OWNER_LOGIN: BootRole = OWNER_LOGIN_ROLE as BootRole;
/** The runtime login every gate expects (the owner login). Kept under its historical name for existing importers. */
export const RUNTIME_ROLE: BootRole = OWNER_LOGIN;
/**
 * Phase D: the Worker-only SCHEMA role (created by the operator / rolemaker bootstrap, never by a migration). It still holds
 * EXECUTE on the dispatch-claim functions and must have ZERO members (WorkerDispatchPointer1786721300000 preflight,
 * secure-owner invariant 8); no process connects as it any more.
 */
export const WORKER_ROLE: BootRole = 'crewflow_worker';
/** WORKER_CLAIM_MODE (environment-variables.ts): still selects the Worker's claim behaviour; it no longer selects a login. */
export type WorkerClaimMode = 'per_scope' | 'global';
/** The due-work functions every Worker calls (manager-confirmation timeouts). D5 moves their EXECUTE to crewflow_worker. */
export const DUE_WORK_FUNCTIONS: readonly string[] = ['worker_claim_due_work', 'worker_complete_due_work', 'worker_reschedule_due_work'];
/** The Phase D global-claim functions (migration WorkerDispatchPointer1786721300000). EXECUTE: crewflow_worker only. */
export const DISPATCH_CLAIM_FUNCTIONS: readonly string[] = [
  'worker_claim_email_dispatch',
  'worker_claim_push_dispatch',
  'worker_claim_realtime_publish',
  'worker_claim_statement_dispatch',
  'worker_release_dispatch_claim',
];
export const MIN_SERVER_VERSION_NUM = 160000;
export const REQUIRED_EXTENSIONS: readonly string[] = ['btree_gist', 'citext', 'pg_trgm', 'pgcrypto', 'unaccent'];
/** Tenant tables that must be ENABLE + FORCE on every install (verified on a migrations-only database, 242 migrations). */
export const FORCE_RLS_SPOT_CHECK_TABLES: readonly string[] = [
  'attendance',
  'audit_log',
  'job_offer',
  'payroll_record',
  'payroll_run',
  'payslip',
  'shift',
  'shift_assignment',
  'staff_profile',
  'user_role',
  'venue',
];
/** The owner SCHEMA roles. The owner login is a member of them by design; any OTHER login that is, is refused (gate 1). */
export const OWNER_ROLES: readonly string[] = ['crewflow', 'rab_owner', 'rab_secure_owner'];

export class DatabaseBootGateError extends Error {
  constructor(
    readonly gate: string,
    message: string,
  ) {
    super(`Database boot gate "${gate}" refused: ${message}`);
    this.name = 'DatabaseBootGateError';
  }
}

export interface BootGateFacts {
  who: string;
  login: string;
  super: boolean;
  bypassrls: boolean;
  loginPrivileged: boolean;
  /** The LOGIN role has REPLICATION or CREATEDB (owner-login shape: neither). */
  loginReplicationOrCreatedb: boolean;
  /** Comma-separated owner roles the current role is a member of (other than itself), or null. */
  ownerRoles: string | null;
  serverVersionNum: number;
  database: string;
  extensions: string[];
  /** null when pg_stat_ssl has no row for this backend. */
  ssl: boolean | null;
  /**
   * Phase D: the login (or the role it acts as) is crewflow_worker or a member of it (any membership). False when the
   * crewflow_worker role does not exist. A non-Worker process with this set could reach the dispatch-claim grants.
   */
  workerMember: boolean;
}

/**
 * Membership semantics (PostgreSQL 16, relied on by gate 2's minimum): `pg_has_role(..., 'MEMBER')` is true for ANY direct
 * or indirect membership "without regard to what specific privileges may be conferred" — i.e. regardless of the PG16
 * grant options INHERIT TRUE/FALSE and SET TRUE/FALSE. 'USAGE' would miss an INHERIT FALSE grant (still SET ROLE-able)
 * and 'SET' an INHERIT TRUE, SET FALSE grant (privileges inherited). The owner-role rule therefore uses MEMBER, so it holds
 * for crewflow_worker too: its expected crewflow_app membership (INHERIT TRUE, SET FALSE) is not an owner role, and any
 * path from it to crewflow / rab_owner / rab_secure_owner — whatever the grant options — is refused.
 */
export const BOOT_FACTS_SQL = `
SELECT current_user::text AS who,
       session_user::text AS login,
       r.rolsuper AS super,
       r.rolbypassrls AS bypassrls,
       (SELECT s.rolsuper OR s.rolbypassrls FROM pg_catalog.pg_roles s WHERE s.rolname = session_user) AS login_privileged,
       (SELECT s.rolreplication OR s.rolcreatedb FROM pg_catalog.pg_roles s WHERE s.rolname = session_user) AS login_repl_createdb,
       (SELECT pg_catalog.string_agg(o.rolname::text, ',' ORDER BY o.rolname)
          FROM pg_catalog.pg_roles o
         WHERE o.rolname IN ('crewflow', 'rab_owner', 'rab_secure_owner') AND o.rolname <> current_user
           AND (pg_catalog.pg_has_role(current_user, o.oid, 'MEMBER') OR pg_catalog.pg_has_role(session_user, o.oid, 'MEMBER'))) AS owner_roles,
       COALESCE((SELECT pg_catalog.pg_has_role(current_user, w.oid, 'MEMBER') OR pg_catalog.pg_has_role(session_user, w.oid, 'MEMBER')
                   FROM pg_catalog.pg_roles w WHERE w.rolname = 'crewflow_worker'), false) AS worker_member,
       pg_catalog.current_setting('server_version_num')::int AS server_version_num,
       pg_catalog.current_database()::text AS database,
       (SELECT pg_catalog.string_agg(e.extname::text, ',' ORDER BY e.extname) FROM pg_catalog.pg_extension e) AS extensions,
       (SELECT s.ssl FROM pg_catalog.pg_stat_ssl s WHERE s.pid = pg_catalog.pg_backend_pid()) AS ssl
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

export const FORCE_RLS_SQL = `
SELECT c.relname::text AS relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname = ANY ($1::text[])`;

export const RLS_DISABLED_TENANT_TABLES_SQL = `
SELECT c.relname::text AS relname
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organisation_id' AND a.attnum > 0 AND NOT a.attisdropped
 WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
 ORDER BY 1`;

/**
 * Gate 1's expected login — a code constant (an env var naming the role would let a misconfigured deployment redefine it).
 * The owner login for every process, every CLI command and every WORKER_CLAIM_MODE. The parameters are kept so callers
 * keep compiling; they no longer change the answer.
 */
export function expectedRolesFor(_processName: BootProcess, _cliCommand?: string, _workerClaimMode: WorkerClaimMode = 'per_scope'): readonly BootRole[] {
  return [OWNER_LOGIN];
}

/**
 * WORKER_CLAIM_MODE as the boot gate reads it (the same rule as environment-variables.ts: unset/empty → per_scope;
 * exactly `per_scope` or `global`; anything else is refused rather than guessed).
 */
export function workerClaimModeFrom(env: Record<string, string | undefined>): WorkerClaimMode {
  const raw = env.WORKER_CLAIM_MODE;
  if (raw === undefined || raw === '') return 'per_scope';
  if (raw === 'per_scope' || raw === 'global') return raw;
  throw new DatabaseBootGateError('config', 'WORKER_CLAIM_MODE must be exactly per_scope or global.');
}

/** Production as the PROCESS declares it: runtime NODE_ENV/RAB_RUNTIME_ENV, CLI DB_TARGET. Never a hostname. */
export function isProductionProcess(processName: BootProcess, env: Record<string, string | undefined>): boolean {
  if (processName === 'cli') return env.DB_TARGET?.trim() === 'production';
  return env.NODE_ENV === 'production' || env.RAB_RUNTIME_ENV?.trim() === 'production';
}

export function parseBootFacts(row: Record<string, unknown> | undefined): BootGateFacts {
  if (!row) throw new DatabaseBootGateError('role', 'the connecting role could not be read.');
  return {
    who: String(row.who),
    login: String(row.login),
    super: row.super === true,
    bypassrls: row.bypassrls === true,
    loginPrivileged: row.login_privileged === true,
    loginReplicationOrCreatedb: row.login_repl_createdb === true,
    ownerRoles: row.owner_roles ? String(row.owner_roles) : null,
    serverVersionNum: Number(row.server_version_num),
    database: String(row.database),
    extensions: row.extensions ? String(row.extensions).split(',') : [],
    ssl: row.ssl === null || row.ssl === undefined ? null : row.ssl === true,
    workerMember: row.worker_member === true,
  };
}

/**
 * Gate 1 (synchronous part, from BOOT_FACTS_SQL): the connection is the owner login itself — never a legacy schema-role
 * login (crewflow_app, crewflow_worker, crewflow), never through SET ROLE — and the login is not SUPERUSER, BYPASSRLS,
 * REPLICATION or CREATEDB, and not a member of crewflow_worker (that role must have zero members). Membership of the owner
 * roles is EXPECTED now (catalogue entry BC-01); the exact role layout and the reachability walk are the asynchronous part
 * (assertOwnerLoginRoleGate), run after the version gate.
 */
export function assertRoleGate(facts: BootGateFacts, expected: readonly BootRole[], label: string): void {
  if (facts.who === WORKER_ROLE || facts.login === WORKER_ROLE) {
    throw new DatabaseBootGateError(
      'role',
      `the ${label} connects as "${WORKER_ROLE}", a schema role that holds the Worker-only dispatch-claim grants; every process connects as ${expected.join(' or ')}.`,
    );
  }
  if (!(expected as readonly string[]).includes(facts.who)) {
    throw new DatabaseBootGateError(
      'role',
      `the ${label} connects as "${facts.who}"; expected ${expected.join(' or ')}. Point PG_DATABASE_URL at the owner login (the legacy logins crewflow_app / crewflow / crewflow_worker are schema roles now).`,
    );
  }
  if (facts.login !== facts.who) {
    throw new DatabaseBootGateError('role', `the ${label} login is "${facts.login}" acting as "${facts.who}" (SET ROLE is not accepted). Connect as ${facts.who} itself.`);
  }
  if (facts.super || facts.bypassrls || facts.loginPrivileged) {
    throw new DatabaseBootGateError('role', `the ${label} login "${facts.who}" has SUPERUSER or BYPASSRLS; row-level security would not apply. Remove the attribute.`);
  }
  if (facts.loginReplicationOrCreatedb) {
    throw new DatabaseBootGateError('role', `the ${label} login "${facts.who}" has REPLICATION or CREATEDB. Remove the attribute (ALTER ROLE … NOREPLICATION NOCREATEDB).`);
  }
  if (facts.workerMember) {
    throw new DatabaseBootGateError(
      'role',
      `the ${label} login "${facts.who}" is a member of ${WORKER_ROLE}, which must have zero members. Revoke the membership (GRANT/REVOKE as the role's administrator).`,
    );
  }
}

/**
 * Gate 1 (asynchronous part, after gate 2 — it reads PG16 pg_auth_members columns): nothing dangerous is reachable from
 * the owner login (MEMBER semantics: INHERIT, SET and ADMIN-only edges, indirect, predefined and provider-admin roles) and
 * the role layout is exactly the reviewed owner-login inventory (owner-login-posture.ts).
 */
export async function assertOwnerLoginRoleGate(query: Query, label: string): Promise<void> {
  const problems = await ownerLoginRolePostureProblems(query);
  if (problems.length) {
    throw new DatabaseBootGateError('role', `the ${label} role posture is not the reviewed owner-login layout: ${problems.join('; ')}. Do not serve; investigate the roles.`);
  }
}

/** After gate 7: FORCE (tenant, M-T1 pre-auth, deployment identity) and the expected object ownership. */
export async function assertOwnerLoginObjectGate(query: Query): Promise<void> {
  const problems = await ownerLoginObjectPostureProblems(query);
  if (problems.length) {
    throw new DatabaseBootGateError('objects', `the owner-login object posture drifted: ${problems.join('; ')}. Do not serve; investigate the schema.`);
  }
}

/*
 * Former gate 1b (the crewflow_worker LOGIN shape) is gone: no process connects as crewflow_worker any more (gate 1 refuses
 * it). The role's reviewed SCHEMA shape — LOGIN, member of exactly crewflow_app WITH INHERIT TRUE / SET FALSE, ZERO members,
 * owns nothing — is still enforced where it matters: the WorkerDispatchPointer1786721300000 preflight (workerRoleProblems),
 * secure-owner invariant 8, tools/check-rls-coverage.ts and the owner-login inventory (owner-login-posture.ts).
 */

/**
 * Gate 1c "dispatch-notify" (Phase D wave 3, owner-approved). The dispatch-pointer triggers NOTIFY only when the session
 * setting `crewflow.dispatch_notify` is 'on', and that must only ever come from the process's own startup option
 * (`-c crewflow.dispatch_notify=on`: event mode, API/Worker writable sessions — pg-config.ts dispatchNotifyFor). A STORED
 * setting (ALTER ROLE … [IN DATABASE …] SET / ALTER DATABASE … SET) would switch NOTIFY on for every session of that
 * role/database — poll-mode processes, the CLI, the provisioner — without any process opting in. pg_db_role_setting is
 * readable by every role. Scope: rows for this database or every database (setdatabase = 0), for every role
 * (setrole = 0) or for a role the connecting role is a member of (any membership — stricter than PostgreSQL, which applies
 * only the session role's own rows). `current_user` is the connecting role: gate 1 has already refused SET ROLE
 * (login ≠ current_user), so this runs after it. The name is compared case-insensitively (GUC names are). SELECT only, on
 * the gate's own session (bounded by its statement_timeout).
 * Not covered (superuser-only, and not visible to a non-superuser: placeholder GUCs are absent from pg_settings):
 * postgresql.conf / ALTER SYSTEM. A poll-mode process still catches those through the session assertion below.
 */
export const DISPATCH_NOTIFY_STORED_SQL = `
SELECT CASE WHEN s.setrole = 0 THEN NULL ELSE r.rolname::text END AS role_name,
       CASE WHEN s.setdatabase = 0 THEN NULL ELSE d.datname::text END AS database_name
  FROM pg_catalog.pg_db_role_setting s
  LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
  LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
 WHERE (s.setdatabase = 0 OR d.datname = pg_catalog.current_database())
   AND (CASE WHEN s.setrole = 0 THEN true
             WHEN r.oid IS NULL THEN false
             ELSE pg_catalog.pg_has_role(current_user, s.setrole, 'MEMBER') END)
   AND EXISTS (SELECT 1 FROM pg_catalog.unnest(s.setconfig) AS c(cfg)
                WHERE pg_catalog.lower(pg_catalog.split_part(c.cfg, '=', 1)) = 'crewflow.dispatch_notify')
 ORDER BY d.datname NULLS FIRST, r.rolname NULLS FIRST`;

/** The gate session's own value (missing_ok: NULL when absent, never an error). */
export const DISPATCH_NOTIFY_SESSION_SQL = `SELECT pg_catalog.current_setting('crewflow.dispatch_notify', true) AS dispatch_notify`;

/**
 * Whether this process's sessions must carry `crewflow.dispatch_notify=on`: exactly the connection factory's rule
 * (pg-config.ts dispatchNotifyFor — event mode AND api|worker), so the gate and the factory can never disagree. A
 * malformed WORKER_DISPATCH_MODE refuses at gate `config`.
 */
export function expectedDispatchNotify(processName: BootProcess, env: Record<string, string | undefined>): boolean {
  try {
    return dispatchNotifyFor(env, processName);
  } catch (error) {
    if (error instanceof PgConfigError) throw new DatabaseBootGateError('config', error.message);
    throw error;
  }
}

/** Gate 1c (pure). Returns what the session carries ('on' | 'absent') for the boot report. */
export function assertDispatchNotifyGate(
  storedRows: Array<Record<string, unknown>>,
  sessionRow: Record<string, unknown> | undefined,
  input: { expectOn: boolean; label: string },
): 'on' | 'absent' {
  if (storedRows.length > 0) {
    const scopes = storedRows.map((row) => {
      const role = row.role_name === null || row.role_name === undefined ? 'every role' : `role ${String(row.role_name)}`;
      const database = row.database_name === null || row.database_name === undefined ? 'every database' : `database ${String(row.database_name)}`;
      return `${role} in ${database}`;
    });
    throw new DatabaseBootGateError(
      'dispatch-notify',
      `the database holds a persistent setting of crewflow.dispatch_notify (${scopes.join('; ')}). It must only ever come from the ` +
        "process's own connection option in WORKER_DISPATCH_MODE=event; a stored value switches NOTIFY on for every session of that " +
        'role/database. Remove it (ALTER ROLE … [IN DATABASE …] RESET crewflow.dispatch_notify / ALTER DATABASE … RESET crewflow.dispatch_notify) before serving.',
    );
  }
  const raw = sessionRow?.dispatch_notify;
  const value = raw === null || raw === undefined ? null : String(raw);
  const shown = value === null ? 'absent' : `'${value}'`;
  if (input.expectOn && value !== 'on') {
    throw new DatabaseBootGateError(
      'dispatch-notify',
      `the ${input.label} is in event mode (WORKER_DISPATCH_MODE=event) but its database session sees crewflow.dispatch_notify ${shown}, ` +
        "expected 'on' from its own connection option. A pooler or proxy may be dropping startup parameters: connect directly.",
    );
  }
  if (!input.expectOn && value !== null) {
    throw new DatabaseBootGateError(
      'dispatch-notify',
      `the ${input.label} (poll mode, or a process that never notifies) sees crewflow.dispatch_notify=${shown} in its database session; ` +
        'its sessions must not carry the setting at all (only an event-mode API/Worker sets it, through its own connection option). ' +
        'Find where it comes from (connection options, PGOPTIONS, server configuration) and remove it.',
    );
  }
  return value === 'on' ? 'on' : 'absent';
}

/**
 * Gate 8 facts: which of the named core functions exist and whether the gate's role (current_user) may EXECUTE them.
 * `has_function_privilege(oid, ...)` follows role inheritance, exactly as a call would.
 */
export const ROUTINE_GRANTS_SQL = `
SELECT p.proname::text AS name, pg_catalog.has_function_privilege(p.oid, 'EXECUTE') AS can_execute
  FROM pg_catalog.pg_proc p
 WHERE p.pronamespace = 'core'::regnamespace AND p.proname = ANY ($1::text[])`;

export type RoutineGrantState = 'granted' | 'not-granted' | 'absent' | 'partial';

/** Summarises ROUTINE_GRANTS_SQL rows for a set of function names (a name may appear more than once: overloads). Pure. */
export function routineGrantState(
  rows: Array<Record<string, unknown>>,
  names: readonly string[],
): { state: RoutineGrantState; missing: string[]; denied: string[]; executable: string[] } {
  const missing = names.filter((n) => !rows.some((r) => String(r.name) === n));
  const denied = names.filter((n) => rows.some((r) => String(r.name) === n && r.can_execute !== true));
  const executable = names.filter((n) => rows.some((r) => String(r.name) === n && r.can_execute === true));
  const granted = names.filter((n) => !missing.includes(n) && !denied.includes(n));
  let state: RoutineGrantState;
  if (missing.length === names.length) state = 'absent';
  else if (granted.length === names.length) state = 'granted';
  else if (executable.length === 0) state = 'not-granted';
  else state = 'partial';
  return { state, missing, denied, executable };
}

export interface RoutineGrantsReport {
  dueWork: RoutineGrantState;
  dispatchClaims: RoutineGrantState;
}

function grantDetail(g: { missing: string[]; denied: string[] }, missingHint = ''): string {
  return [g.missing.length ? `missing core.${g.missing.join(', core.')}${missingHint}` : null, g.denied.length ? `no EXECUTE on core.${g.denied.join(', core.')}` : null]
    .filter(Boolean)
    .join('; ');
}

/**
 * Gate 8 (Phase D). Pure.
 *  - Worker (any mode): must be able to EXECUTE every due-work function (it always runs manager-confirmation timeouts).
 *  - Worker in global mode: must be able to EXECUTE every dispatch-claim function (the owner login can, through its
 *    ownership of them via rab_secure_owner).
 *  - Any other process (the API, the CLI): it CAN execute the dispatch-claim functions — with one login it always can.
 *    That is the loss of the DBA-01 API/Worker separation, NOT listed among the protections the owner accepted in the
 *    final prompt §2: it is catalogued as BC-08 (NEEDS OWNER APPROVAL) and RECORDED as a boot warning on every start
 *    (ownerLoginGrantWarnings), never silently treated as passing. It no longer refuses: no single-login process could boot.
 */
export function assertRoutineGrantsGate(
  rows: Array<Record<string, unknown>>,
  input: { processName: BootProcess; who: string; claimMode: WorkerClaimMode; label: string },
): RoutineGrantsReport {
  const dueWork = routineGrantState(rows, DUE_WORK_FUNCTIONS);
  const dispatch = routineGrantState(rows, DISPATCH_CLAIM_FUNCTIONS);
  if (input.processName === 'worker') {
    if (dueWork.state !== 'granted') {
      throw new DatabaseBootGateError(
        'grants',
        `the ${input.label} login "${input.who}" cannot run the due-work functions (${grantDetail(dueWork)}). Since the D5 cutover ` +
          `(WorkerDueWorkClaimsToWorkerRole1786721330000) only ${WORKER_ROLE} holds EXECUTE: point this Worker's PG_DATABASE_URL at the ` +
          `${WORKER_ROLE} login. A Worker that cannot run manager-confirmation timeouts must not start (mixed-version rollout).`,
      );
    }
    if (input.claimMode === 'global' && dispatch.state !== 'granted') {
      throw new DatabaseBootGateError(
        'grants',
        `WORKER_CLAIM_MODE=global but the ${input.label} login "${input.who}" cannot run the dispatch-claim functions ` +
          `(${grantDetail(dispatch, ' (apply the Phase D migrations)')}). Set WORKER_CLAIM_MODE=per_scope until the schema and the ${WORKER_ROLE} grants are in place.`,
      );
    }
  }
  return { dueWork: dueWork.state, dispatchClaims: dispatch.state };
}

/** Gate 8 record for a non-Worker process (BC-08, NEEDS OWNER APPROVAL): which Worker-only functions it can EXECUTE. Pure. */
export function ownerLoginGrantWarnings(rows: Array<Record<string, unknown>>, input: { processName: BootProcess; who: string; label: string }): string[] {
  if (input.processName === 'worker') return [];
  const dispatch = routineGrantState(rows, DISPATCH_CLAIM_FUNCTIONS);
  if (dispatch.executable.length === 0) return [];
  return [
    `BC-08 (DBA-01 API/Worker separation lost — PENDING OWNER APPROVAL): the ${input.label} login "${input.who}" can EXECUTE the ` +
      `Worker-only functions core.${dispatch.executable.join(', core.')}.`,
  ];
}

/** Gate 2. */
export function assertVersionGate(facts: BootGateFacts): void {
  if (!Number.isFinite(facts.serverVersionNum) || facts.serverVersionNum < MIN_SERVER_VERSION_NUM) {
    throw new DatabaseBootGateError('version', `PostgreSQL server_version_num ${facts.serverVersionNum} is below the minimum ${MIN_SERVER_VERSION_NUM} (PostgreSQL 16).`);
  }
}

/** Gate 3. */
export function assertExtensionsGate(facts: BootGateFacts): void {
  const missing = REQUIRED_EXTENSIONS.filter((e) => !facts.extensions.includes(e));
  if (missing.length) {
    throw new DatabaseBootGateError('extensions', `required extension(s) missing: ${missing.join(', ')}. Apply the migrations with the migration identity.`);
  }
}

/** Gate 5 (pure part). */
export function assertForceRlsGate(rows: Array<Record<string, unknown>>, disabledTenantTables: string[]): void {
  const byName = new Map(rows.map((r) => [String(r.relname), r]));
  const problems: string[] = [];
  for (const table of FORCE_RLS_SPOT_CHECK_TABLES) {
    const r = byName.get(table);
    if (!r) problems.push(`core.${table} missing`);
    else if (r.enabled !== true || r.forced !== true) problems.push(`core.${table} enable=${r.enabled} force=${r.forced}`);
  }
  for (const table of disabledTenantTables) problems.push(`core.${table} has organisation_id but RLS disabled`);
  if (problems.length) {
    throw new DatabaseBootGateError('force-rls', `row-level security posture drifted: ${problems.join('; ')}. Do not serve; investigate the schema.`);
  }
}

/** Gate 6. */
export function assertTlsGate(facts: BootGateFacts, production: boolean): void {
  if (production && facts.ssl !== true) {
    throw new DatabaseBootGateError('tls', 'the production database connection is not using TLS (pg_stat_ssl). Configure verified TLS for the database URL.');
  }
}

export interface EvaluateBootGatesInput {
  processName: BootProcess;
  env: Record<string, string | undefined>;
  query: Query;
  /**
   * Gate 7: throws when migrations are pending or the schema is incompatible with this process (assertNoPendingMigrations →
   * schema-compatibility.ts in the real path). May return warnings (an image rollback the process policy allows).
   */
  checkPendingMigrations: (context: { production: boolean }) => Promise<void | { warnings?: readonly string[] }>;
  cliCommand?: string;
  /**
   * The host the gate's connection names (the factory's canonical parse of the process's PG_DATABASE_URL). A bound marker
   * is accepted only at the host it was bound at (owner decision A: a restore / clone / fork elsewhere is refused).
   */
  connectionHost: string;
}

export interface BootGateReport {
  processName: BootProcess;
  role: string;
  serverVersionNum: number;
  database: string;
  identity: string;
  tls: boolean | null;
  forceRlsTables: number;
  warnings: string[];
  /** The migration names the schema-compatibility gate compared (set by runDatabaseBootGates; the provisioner re-checks per cycle). */
  expectedMigrations?: readonly string[];
  /** Phase D: the Worker's WORKER_CLAIM_MODE as the gate read it (Worker only). */
  claimMode?: WorkerClaimMode;
  /** Phase D gate 8: what the gate's role can EXECUTE (due-work: the D5 cutover state; dispatch claims: Worker-only). */
  grants: RoutineGrantsReport;
  /** Phase D wave 3 gate 1c: what the gate session carries ('on' only for an event-mode API/Worker). */
  dispatchNotify: 'on' | 'absent';
  /** Set by runDatabaseBootGates: the semantic posture snapshot taken at boot (the posture monitor's baseline). */
  semanticBaseline?: import('../posture-drift/semantic-posture').SemanticPosture;
}

/** All gates over one connection. Pure apart from the injected query / pending-migration functions. */
export async function evaluateBootGates(input: EvaluateBootGatesInput): Promise<BootGateReport> {
  const { processName, env, query } = input;
  const production = isProductionProcess(processName, env);
  const label = processName === 'cli' ? `CLI command "${input.cliCommand ?? '(none)'}"` : `${processName} process`;

  // Phase D: WORKER_CLAIM_MODE selects the Worker's expected-role constants (read only for the Worker; fail closed).
  const claimMode = processName === 'worker' ? workerClaimModeFrom(env) : 'per_scope';
  // Phase D wave 3: whether this process's sessions must carry crewflow.dispatch_notify=on (the factory's rule; fail closed).
  const expectDispatchNotify = expectedDispatchNotify(processName, env);

  const [factsRow] = await query(BOOT_FACTS_SQL);
  const facts = parseBootFacts(factsRow);
  assertRoleGate(facts, expectedRolesFor(processName, input.cliCommand, claimMode), label);
  assertVersionGate(facts);
  // After the version gate: the walk and the inventory read PG16-only pg_auth_members columns (D10: < 16 is refused).
  await assertOwnerLoginRoleGate(query, label);
  // Gate 1c (Phase D wave 3): no stored crewflow.dispatch_notify; the session value matches the process's mode.
  const dispatchNotify = assertDispatchNotifyGate(await query(DISPATCH_NOTIFY_STORED_SQL), (await query(DISPATCH_NOTIFY_SESSION_SQL))[0], {
    expectOn: expectDispatchNotify,
    label,
  });
  assertExtensionsGate(facts);

  let identity;
  try {
    identity = await assertDeploymentIdentity(query, {
      processLabel: label,
      production,
      env,
      allowBootstrap: false,
      connectionHost: input.connectionHost,
      // Only a CLI command selects its target with DB_TARGET; a runtime never reads it (security review N-2 / L-4).
      command: processName === 'cli',
    });
  } catch (error) {
    if (error instanceof DeploymentIdentityError) throw new DatabaseBootGateError('identity', error.message);
    throw error;
  }

  const forceRows = await query(FORCE_RLS_SQL, [FORCE_RLS_SPOT_CHECK_TABLES]);
  const disabled = (await query(RLS_DISABLED_TENANT_TABLES_SQL)).map((r) => String(r.relname));
  assertForceRlsGate(forceRows, disabled);

  assertTlsGate(facts, production);

  let compatibilityWarnings: readonly string[] = [];
  try {
    compatibilityWarnings = (await input.checkPendingMigrations({ production }))?.warnings ?? [];
  } catch (error) {
    if (error instanceof DatabaseBootGateError) throw error;
    if (error instanceof SchemaCompatibilityError) throw new DatabaseBootGateError(error.gate, error.message);
    throw new DatabaseBootGateError('pending-migrations', (error as Error).message);
  }

  // FORCE and ownership after the schema gate, so a pending M-T1 is reported as a pending migration, not as drift.
  await assertOwnerLoginObjectGate(query);

  // Gate 8 (Phase D), after the schema gate so a pending migration is reported as such, not as a missing function.
  const grantRows = await query(ROUTINE_GRANTS_SQL, [[...DUE_WORK_FUNCTIONS, ...DISPATCH_CLAIM_FUNCTIONS]]);
  const grants = assertRoutineGrantsGate(grantRows, { processName, who: facts.who, claimMode, label });
  const grantWarnings = ownerLoginGrantWarnings(grantRows, { processName, who: facts.who, label });

  return {
    processName,
    ...(processName === 'worker' ? { claimMode } : {}),
    grants,
    dispatchNotify,
    role: facts.who,
    serverVersionNum: facts.serverVersionNum,
    database: facts.database,
    identity: identity.summary,
    tls: facts.ssl,
    forceRlsTables: FORCE_RLS_SPOT_CHECK_TABLES.length,
    warnings: [...identity.warnings, ...compatibilityWarnings, ...grantWarnings],
  };
}

// ------------------------------------------------------------------------------------------------ retry

const RETRYABLE_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']);
/** cannot_connect_now (starting up / recovery), too_many_connections, connection_exception class, admin/crash shutdown. */
const RETRYABLE_SQLSTATES = new Set(['57P03', '53300', '08000', '08001', '08003', '08004', '08006', '57P01', '57P02']);
const RETRYABLE_MESSAGES = [/Connection terminated/i, /timeout expired/i, /timeout exceeded when trying to connect/i];

/** True only for "the database is not reachable (yet)". Authentication, missing database and gate decisions are final. */
export function isDatabaseUnreachable(error: unknown): boolean {
  if (error instanceof DatabaseBootGateError || error instanceof DeploymentIdentityError) return false;
  const e = error as { code?: unknown; message?: unknown; driverError?: unknown } | null;
  if (!e) return false;
  if (typeof e.code === 'string' && (RETRYABLE_NODE_CODES.has(e.code) || RETRYABLE_SQLSTATES.has(e.code))) return true;
  if (e.driverError && isDatabaseUnreachable(e.driverError)) return true;
  return typeof e.message === 'string' && RETRYABLE_MESSAGES.some((re) => re.test(e.message as string));
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Bounded exponential backoff for unreachable-database errors only. Throws the last error as a 'connect' refusal. */
export async function withDatabaseRetry<T>(label: string, fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 10);
  const base = options.baseDelayMs ?? 1000;
  const max = options.maxDelayMs ?? 15_000;
  const sleep = options.sleep ?? sleepFor;
  const log = options.log ?? ((line: string) => console.warn(line)); // eslint-disable-line no-console
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isDatabaseUnreachable(error)) throw error;
      const code = (error as { code?: string })?.code ?? 'no-code';
      if (attempt >= attempts) {
        throw new DatabaseBootGateError(
          'connect',
          `the database stayed unreachable for the ${label} after ${attempts} attempt(s) (last driver code ${code}). Check that it is running and reachable from this container, then restart.`,
        );
      }
      const delay = Math.min(max, base * 2 ** (attempt - 1));
      log(`[db-boot-gates] ${label}: database unreachable (driver code ${code}); attempt ${attempt}/${attempts}, retrying in ${delay} ms`);
      await sleep(delay);
    }
  }
}

/** CLI helper: the command name nest-commander will run (first non-option argument). */
export function cliCommandFromArgv(argv: readonly string[]): string | undefined {
  return argv.slice(2).find((a) => !a.startsWith('-'));
}
