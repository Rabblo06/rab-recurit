/**
 * Phase B database boot gates: the RULES (pure decisions over an injected query function, and the bounded retry).
 * No DataSource, no connection options: unit-testable without a database. The entrypoint that opens the connection
 * is database-boot-gates.ts (runDatabaseBootGates), which re-exports everything here. See that file for the gate list.
 */
import { assertDeploymentIdentity, DeploymentIdentityError, Query } from '../deployment-identity/deployment-identity';
import { dispatchNotifyFor } from '../postgres/pg-config';
import { PgConfigError } from '../postgres/pg-url-policy';
import { SchemaCompatibilityError } from './schema-compatibility';

export type BootProcess = 'api' | 'worker' | 'cli' | 'provisioner';
export type BootRole = 'crewflow_app' | 'crewflow' | 'crewflow_worker';

export const RUNTIME_ROLE: BootRole = 'crewflow_app';
/**
 * Phase D (D1/D2, interface contract): the Worker-only login. Operator-created (never by a migration): LOGIN, INHERIT,
 * member of crewflow_app WITH INHERIT TRUE, SET FALSE; no SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION; owns
 * nothing; no other membership. It alone holds EXECUTE on the dispatch-claim functions (and, after the D5 cutover
 * migration WorkerDueWorkClaimsToWorkerRole1786721330000, on the due-work functions). The API and every CLI command refuse it.
 */
export const WORKER_ROLE: BootRole = 'crewflow_worker';
/** WORKER_CLAIM_MODE (environment-variables.ts). The expected Worker roles per mode are the constants below, never env. */
export type WorkerClaimMode = 'per_scope' | 'global';
export const WORKER_ROLES_BY_CLAIM_MODE: Readonly<Record<WorkerClaimMode, readonly BootRole[]>> = {
  // Old runtime mode keeps working until every Worker has the crewflow_worker credential (owner decision D2).
  per_scope: [RUNTIME_ROLE, WORKER_ROLE],
  // Only crewflow_worker can EXECUTE the claim functions: a crewflow_app Worker in global mode would claim nothing.
  global: [WORKER_ROLE],
};
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
/**
 * The Worker bundle's provisioner child holds the privileged provisioning identity (`crewflow`, until G2 narrows it): its
 * gate expects that login, never crewflow_app, and still refuses SUPERUSER / BYPASSRLS / owner-role membership.
 */
export const PROVISIONER_ROLE: BootRole = 'crewflow';
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
/** Roles a gated login must never be able to act as (any membership). */
export const OWNER_ROLES: readonly string[] = ['crewflow', 'rab_owner', 'rab_secure_owner'];

/**
 * CLI identity per command. Every command's DATABASE_URL login must be crewflow_app unless listed here. The operator
 * commands below are documented to run with DATABASE_URL = the `crewflow` operator identity (bootstrap-admin, seed-ai-demo,
 * grant-platform-admin, the seeds, secret rotation, ping); they may use either login. A migration identity (a member of
 * rab_secure_owner), a superuser or a BYPASSRLS login is refused for every command: migrations and `db:bind-identity` are
 * separate entrypoints that never go through the CLI.
 */
export const CLI_COMMAND_ROLES: Readonly<Record<string, readonly BootRole[]>> = {
  'bootstrap-admin': ['crewflow', 'crewflow_app'],
  'grant-platform-admin': ['crewflow', 'crewflow_app'],
  'seed-ai-demo': ['crewflow', 'crewflow_app'],
  seed: ['crewflow', 'crewflow_app'],
  'seed-qa': ['crewflow', 'crewflow_app'],
  'secret:rotate': ['crewflow', 'crewflow_app'],
  ping: ['crewflow', 'crewflow_app'],
};

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
 * Gate 1's expected logins per process — code constants only (an env var naming the role would let a misconfigured
 * deployment redefine "the restricted role"). The Worker's set depends on WORKER_CLAIM_MODE, which only CHOOSES between
 * the two constant sets above (workerClaimModeFrom validates it, fail closed).
 */
export function expectedRolesFor(processName: BootProcess, cliCommand?: string, workerClaimMode: WorkerClaimMode = 'per_scope'): readonly BootRole[] {
  if (processName === 'provisioner') return [PROVISIONER_ROLE];
  if (processName === 'worker') return WORKER_ROLES_BY_CLAIM_MODE[workerClaimMode];
  if (processName !== 'cli') return [RUNTIME_ROLE];
  return (cliCommand && CLI_COMMAND_ROLES[cliCommand]) || [RUNTIME_ROLE];
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
    ownerRoles: row.owner_roles ? String(row.owner_roles) : null,
    serverVersionNum: Number(row.server_version_num),
    database: String(row.database),
    extensions: row.extensions ? String(row.extensions).split(',') : [],
    ssl: row.ssl === null || row.ssl === undefined ? null : row.ssl === true,
    workerMember: row.worker_member === true,
  };
}

/** Gate 1. */
export function assertRoleGate(facts: BootGateFacts, expected: readonly BootRole[], label: string): void {
  const workerAllowed = (expected as readonly string[]).includes(WORKER_ROLE);
  if (facts.who === WORKER_ROLE && !workerAllowed) {
    // Phase D (D2): the API (and every CLI command, the replica and the provisioner) must never run with the Worker-only
    // login — it holds the cross-tenant dispatch-claim grants.
    throw new DatabaseBootGateError(
      'role',
      `the ${label} connects as "${WORKER_ROLE}", the Worker-only login that holds the dispatch-claim grants; expected ${expected.join(' or ')}. ` +
        'Give this process its own credential (the API: crewflow_app), never the Worker\'s.',
    );
  }
  if (facts.who === RUNTIME_ROLE && expected.length === 1 && expected[0] === WORKER_ROLE) {
    throw new DatabaseBootGateError(
      'role',
      `the ${label} connects as "${RUNTIME_ROLE}" but WORKER_CLAIM_MODE=global requires "${WORKER_ROLE}" (the only login that can EXECUTE the claim functions). ` +
        "Point this Worker's PG_DATABASE_URL at the crewflow_worker login, or set WORKER_CLAIM_MODE=per_scope.",
    );
  }
  if (!(expected as readonly string[]).includes(facts.who)) {
    throw new DatabaseBootGateError(
      'role',
      `the ${label} connects as "${facts.who}"; expected ${expected.join(' or ')}. Point its database URL at that login (never a migration or owner login).`,
    );
  }
  if (facts.login !== facts.who) {
    throw new DatabaseBootGateError('role', `the ${label} login is "${facts.login}" acting as "${facts.who}" (SET ROLE is not accepted). Connect as ${facts.who} itself.`);
  }
  if (facts.super || facts.bypassrls || facts.loginPrivileged) {
    throw new DatabaseBootGateError('role', `the ${label} login "${facts.who}" has SUPERUSER or BYPASSRLS; row-level security would not apply. Remove the attribute.`);
  }
  if (facts.ownerRoles) {
    throw new DatabaseBootGateError(
      'role',
      `the ${label} login "${facts.who}" is a member of ${facts.ownerRoles}, which own tables and bypass row-level security. Revoke the membership.`,
    );
  }
  if (!workerAllowed && facts.workerMember) {
    throw new DatabaseBootGateError(
      'role',
      `the ${label} login "${facts.who}" is a member of ${WORKER_ROLE} and would inherit the Worker-only dispatch-claim grants. Revoke the membership.`,
    );
  }
}

/**
 * Phase D: the reviewed shape of the crewflow_worker login (interface contract), read only when the gate's login IS
 * crewflow_worker and after the version gate (PG16 `pg_auth_members.inherit_option / set_option`). PG16 may hold several
 * grant rows for one (role, member) pair (one per grantor): the effective option is true when ANY row grants it.
 * Objects owned are counted in this database (relations, functions, schemas, types).
 */
export const WORKER_LOGIN_SHAPE_SQL = `
SELECT r.rolcreaterole AS createrole,
       r.rolcreatedb AS createdb,
       r.rolreplication AS replication,
       r.rolinherit AS inherit,
       (SELECT pg_catalog.bool_or(m.inherit_option) FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles a ON a.oid = m.roleid WHERE m.member = r.oid AND a.rolname = 'crewflow_app') AS app_inherit,
       (SELECT pg_catalog.bool_or(m.set_option) FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles a ON a.oid = m.roleid WHERE m.member = r.oid AND a.rolname = 'crewflow_app') AS app_set,
       (SELECT pg_catalog.string_agg(DISTINCT g.rolname::text, ',') FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid AND g.rolname <> 'crewflow_app') AS other_memberships,
       ((SELECT pg_catalog.count(*) FROM pg_catalog.pg_class c WHERE c.relowner = r.oid)
        + (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p WHERE p.proowner = r.oid)
        + (SELECT pg_catalog.count(*) FROM pg_catalog.pg_namespace n WHERE n.nspowner = r.oid)
        + (SELECT pg_catalog.count(*) FROM pg_catalog.pg_type t WHERE t.typowner = r.oid))::int AS owned_objects
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

/** Gate 1b (crewflow_worker only). Pure. */
export function assertWorkerLoginShape(row: Record<string, unknown> | undefined, label: string): void {
  if (!row) throw new DatabaseBootGateError('role', `the ${label} login "${WORKER_ROLE}" could not be read.`);
  const problems: string[] = [];
  if (row.createrole === true) problems.push('has CREATEROLE');
  if (row.createdb === true) problems.push('has CREATEDB');
  if (row.replication === true) problems.push('has REPLICATION');
  if (row.inherit !== true) problems.push('is NOINHERIT (it must inherit crewflow_app)');
  if (row.app_inherit === null || row.app_inherit === undefined) problems.push('is not a member of crewflow_app');
  else {
    if (row.app_inherit !== true) problems.push('is a member of crewflow_app WITH INHERIT FALSE (needs INHERIT TRUE)');
    if (row.app_set !== false) problems.push('is a member of crewflow_app WITH SET TRUE (needs SET FALSE)');
  }
  if (row.other_memberships) problems.push(`is also a member of ${String(row.other_memberships)}`);
  if (Number(row.owned_objects ?? 0) !== 0) problems.push(`owns ${Number(row.owned_objects)} database object(s)`);
  if (problems.length) {
    throw new DatabaseBootGateError(
      'role',
      `the ${label} login "${WORKER_ROLE}" does not have the reviewed shape: it ${problems.join('; ')}. ` +
        'Expected: LOGIN, INHERIT, member of crewflow_app WITH INHERIT TRUE, SET FALSE only; no CREATEROLE/CREATEDB/REPLICATION; owns nothing.',
    );
  }
}

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
 * Gate 8 (Phase D; D5 cutover visibility). Pure.
 *  - Worker (any mode): must be able to EXECUTE every due-work function (it always runs manager-confirmation timeouts).
 *    After WorkerDueWorkClaimsToWorkerRole1786721330000 only crewflow_worker can — an old Worker still on the
 *    crewflow_app credential then refuses to start with this message instead of failing that loop every cycle.
 *  - Worker in global mode: must be able to EXECUTE every dispatch-claim function (they exist and are granted to it).
 *  - Any other process: must NOT be able to EXECUTE any dispatch-claim function (the API never gains claim grants).
 *    The due-work grant is only reported for them (crewflow_app keeps it until the D5 cutover — open finding E7).
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
  } else if (dispatch.executable.length > 0) {
    throw new DatabaseBootGateError(
      'grants',
      `the ${input.label} login "${input.who}" can EXECUTE core.${dispatch.executable.join(', core.')}: the dispatch-claim functions are for ${WORKER_ROLE} only. ` +
        'Revoke the grant (or the membership that confers it) before serving.',
    );
  }
  return { dueWork: dueWork.state, dispatchClaims: dispatch.state };
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
  if (facts.who === WORKER_ROLE) {
    // After the version gate: the shape query reads PG16-only pg_auth_members columns.
    const [shapeRow] = await query(WORKER_LOGIN_SHAPE_SQL);
    assertWorkerLoginShape(shapeRow, label);
  }
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

  // Gate 8 (Phase D), after the schema gate so a pending migration is reported as such, not as a missing function.
  const grants = assertRoutineGrantsGate(await query(ROUTINE_GRANTS_SQL, [[...DUE_WORK_FUNCTIONS, ...DISPATCH_CLAIM_FUNCTIONS]]), {
    processName,
    who: facts.who,
    claimMode,
    label,
  });

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
    warnings: [...identity.warnings, ...compatibilityWarnings],
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
