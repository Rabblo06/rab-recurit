/**
 * Phase B (owner-approved "operations commands"): the VERIFIED elevated session of the one-off ops container.
 *
 * Who connects: the migration identity (crewflow_migrator; PG_DATABASE_URL in the ops container only — never on the API,
 * the Worker, the provisioner or an ordinary CLI run, pg-config.ts resolveOpsMode). Its grants are
 * `rab_secure_owner, crewflow WITH INHERIT TRUE, SET TRUE` (PostgreSQL 16 membership options). Because INHERIT is true, the
 * bare login already holds BOTH owners' privileges; `SET LOCAL ROLE <narrow role>` therefore NARROWS the session to one
 * owner (rab_secure_owner has no memberships, so acting as it drops crewflow's privileges). It never widens. A `SET ROLE`
 * is only possible to a role the SESSION user reaches through grants that all carry SET (pg_has_role(..., 'SET')).
 *
 * IMPORTANT: SET ROLE guards against ACCIDENTS, not against code running in the same session — `RESET ROLE` (or a new
 * transaction without `SET LOCAL ROLE`) undoes it. What actually limits this session is: (1) a READ ONLY transaction for
 * every read-only step (PostgreSQL refuses writes and DDL in it, and it cannot be switched back once a query ran);
 * (2) the FROZEN statement list — callers pass a statement NAME, never SQL text, and a plan allows only the names it lists
 * for that access mode (ops-statements.ts); (3) the one-off container: the credential exists only for that run.
 *
 * Before ANY statement of each transaction (pool max 1, application_name crewflow-ops-<purpose>):
 *   BEGIN; [SET TRANSACTION READ ONLY]
 *   facts BEFORE narrowing  (OPS_SESSION_FACTS_SQL): the login is the URL's user, has the migration-identity shape
 *                           (member of rab_secure_owner AND crewflow, no ADMIN option, not SUPERUSER/BYPASSRLS, not one of
 *                           the owner/runtime roles itself), may SET the intended role, nothing narrowed yet, PostgreSQL 16+,
 *                           the expected database;
 *   SET LOCAL ROLE <role>   (from a frozen literal, never interpolated input);
 *   facts AFTER narrowing   current_user = the intended role, not SUPERUSER/BYPASSRLS, rab_secure_owner holds no crewflow
 *                           privileges (and crewflow none of rab_secure_owner's), transaction_read_only as intended, same
 *                           database;
 *   deployment identity     assertDeploymentIdentity (deployment-identity.ts) on THIS session, read-only, and its summary
 *                           must equal the restricted app session's (same database, same marker).
 * Any mismatch throws ElevatedOpsSessionError before the first data statement.
 */
import { DataSource, EntityManager } from 'typeorm';

import { isProductionProcess } from '../../database/boot-checks/database-boot-gate-rules';
import { assertDeploymentIdentity, Query } from '../../database/deployment-identity/deployment-identity';
import { createPgDataSource, ResolvedPgEnvironment } from '../../database/postgres';
import { OPS_STATEMENTS, OpsElevatedPlan, OpsStatementName } from './ops-statements';

export const MIN_OPS_SERVER_VERSION_NUM = 160000;

/** Roles a login or an acting role must never BE (the narrow role is checked separately). */
const NEVER_LOGIN_ROLES: readonly string[] = ['crewflow', 'rab_secure_owner', 'rab_owner', 'crewflow_app'];

/** `SET LOCAL ROLE` statements, one frozen literal per allowed narrow role (no identifier is ever built from input). */
const SET_LOCAL_ROLE_SQL: Readonly<Record<OpsElevatedPlan['role'], string>> = Object.freeze({
  rab_secure_owner: 'SET LOCAL ROLE rab_secure_owner',
  crewflow: 'SET LOCAL ROLE crewflow',
});

/**
 * The verification query (run before and after `SET LOCAL ROLE`; $1 = the intended narrow role). Read-only, catalog only.
 */
export const OPS_SESSION_FACTS_SQL = `
SELECT session_user::text AS login,
       current_user::text AS acting,
       l.rolcanlogin AS login_can_login,
       (l.rolsuper OR l.rolbypassrls) AS login_exempt,
       pg_catalog.pg_has_role(session_user, 'rab_secure_owner', 'MEMBER') AS login_member_secure_owner,
       pg_catalog.pg_has_role(session_user, 'crewflow', 'MEMBER') AS login_member_crewflow,
       EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = l.oid AND m.admin_option) AS login_admin_option,
       pg_catalog.pg_has_role(session_user, $1::name, 'SET') AS can_set_role,
       (SELECT a.rolsuper OR a.rolbypassrls FROM pg_catalog.pg_roles a WHERE a.rolname = current_user) AS acting_exempt,
       pg_catalog.pg_has_role(current_user, 'crewflow', 'USAGE') AS acting_has_crewflow,
       pg_catalog.pg_has_role(current_user, 'rab_secure_owner', 'USAGE') AS acting_has_secure_owner,
       pg_catalog.pg_has_role(current_user, 'crewflow_app', 'USAGE') AS acting_has_app,
       pg_catalog.current_setting('transaction_read_only') AS read_only,
       pg_catalog.current_setting('server_version_num')::int AS server_version_num,
       pg_catalog.current_database()::text AS database
  FROM pg_catalog.pg_roles l
 WHERE l.rolname = session_user`;

/** The restricted app session check ($1 unused; catalog only). */
export const OPS_APP_SESSION_FACTS_SQL = `
SELECT session_user::text AS login,
       current_user::text AS acting,
       (r.rolsuper OR r.rolbypassrls) AS exempt,
       (SELECT pg_catalog.string_agg(o.rolname::text, ',' ORDER BY o.rolname) FROM pg_catalog.pg_roles o
         WHERE o.rolname IN ('crewflow', 'rab_owner', 'rab_secure_owner')
           AND pg_catalog.pg_has_role(session_user, o.oid, 'MEMBER')) AS owner_memberships,
       pg_catalog.current_setting('transaction_read_only') AS read_only,
       pg_catalog.current_setting('server_version_num')::int AS server_version_num,
       pg_catalog.current_database()::text AS database
  FROM pg_catalog.pg_roles r
 WHERE r.rolname = session_user`;

export class ElevatedOpsSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElevatedOpsSessionError';
  }
}

export interface OpsSessionFacts {
  login: string;
  acting: string;
  loginCanLogin: boolean;
  loginExempt: boolean;
  loginMemberSecureOwner: boolean;
  loginMemberCrewflow: boolean;
  loginAdminOption: boolean;
  canSetRole: boolean;
  actingExempt: boolean;
  actingHasCrewflow: boolean;
  actingHasSecureOwner: boolean;
  actingHasApp: boolean;
  readOnly: boolean;
  serverVersionNum: number;
  database: string;
}

export function parseOpsSessionFacts(row: Record<string, unknown> | undefined): OpsSessionFacts {
  if (!row) throw new ElevatedOpsSessionError('the elevated session could not read its own role facts.');
  return {
    login: String(row.login),
    acting: String(row.acting),
    loginCanLogin: row.login_can_login === true,
    loginExempt: row.login_exempt === true,
    loginMemberSecureOwner: row.login_member_secure_owner === true,
    loginMemberCrewflow: row.login_member_crewflow === true,
    loginAdminOption: row.login_admin_option === true,
    canSetRole: row.can_set_role === true,
    actingExempt: row.acting_exempt === true,
    actingHasCrewflow: row.acting_has_crewflow === true,
    actingHasSecureOwner: row.acting_has_secure_owner === true,
    actingHasApp: row.acting_has_app === true,
    readOnly: row.read_only === 'on',
    serverVersionNum: Number(row.server_version_num),
    database: String(row.database),
  };
}

export interface OpsSessionExpectation {
  /** The user named by PG_DATABASE_URL (the migration identity). */
  expectedLogin: string;
  /** current_database() of the restricted app session (and the URL's database). */
  expectedDatabase: string;
  role: OpsElevatedPlan['role'];
  readOnly: boolean;
}

/** Pure decision BEFORE `SET LOCAL ROLE`. Throws ElevatedOpsSessionError. */
export function assertOpsLoginFacts(facts: OpsSessionFacts, expect: OpsSessionExpectation): void {
  const refuse = (why: string): never => {
    throw new ElevatedOpsSessionError(`elevated session refused before narrowing: ${why}`);
  };
  if (facts.login !== expect.expectedLogin) refuse('session_user is not the login named by PG_DATABASE_URL.');
  if (NEVER_LOGIN_ROLES.includes(facts.login)) refuse(`the elevated login must be the migration identity, not "${facts.login}".`);
  if (!facts.loginCanLogin) refuse('the session user is not a LOGIN role.');
  if (facts.loginExempt) refuse('the migration identity is SUPERUSER or BYPASSRLS; refusing (it must be NOSUPERUSER NOBYPASSRLS).');
  if (!facts.loginMemberSecureOwner || !facts.loginMemberCrewflow) {
    refuse('the login does not have the migration-identity shape (a member of both rab_secure_owner and crewflow).');
  }
  if (facts.loginAdminOption) refuse('the migration identity holds an ADMIN option on a role; refusing.');
  if (!facts.canSetRole) refuse(`the migration identity may not SET ROLE ${expect.role} (PG16 membership without SET); refusing.`);
  if (facts.acting !== facts.login) refuse('the session is already acting as another role before narrowing (a role from URL options or a prior SET ROLE).');
  if (!Number.isFinite(facts.serverVersionNum) || facts.serverVersionNum < MIN_OPS_SERVER_VERSION_NUM) {
    refuse(`server_version_num ${facts.serverVersionNum} is below ${MIN_OPS_SERVER_VERSION_NUM} (PostgreSQL 16 SET-option semantics are relied on).`);
  }
  if (facts.database !== expect.expectedDatabase) refuse(`current_database() "${facts.database}" differs from the app session's "${expect.expectedDatabase}".`);
  if (facts.readOnly !== expect.readOnly) refuse(`the transaction is ${facts.readOnly ? 'READ ONLY' : 'READ WRITE'}; this step requires ${expect.readOnly ? 'READ ONLY' : 'READ WRITE'}.`);
}

/** Pure decision AFTER `SET LOCAL ROLE`. Throws ElevatedOpsSessionError. */
export function assertOpsActingFacts(facts: OpsSessionFacts, expect: OpsSessionExpectation): void {
  const refuse = (why: string): never => {
    throw new ElevatedOpsSessionError(`elevated session refused after narrowing: ${why}`);
  };
  if (facts.login !== expect.expectedLogin) refuse('session_user changed.');
  if (facts.acting !== expect.role) refuse(`current_user is "${facts.acting}", not the intended narrow role "${expect.role}" (unnarrowed or wrong role).`);
  if (facts.actingExempt) refuse(`the narrow role ${expect.role} is SUPERUSER or BYPASSRLS.`);
  if (expect.role === 'rab_secure_owner' && facts.actingHasCrewflow) refuse('acting as rab_secure_owner still holds crewflow privileges (not narrowed).');
  if (expect.role === 'crewflow' && facts.actingHasSecureOwner) refuse('acting as crewflow still holds rab_secure_owner privileges (not narrowed).');
  if (facts.actingHasApp) refuse(`the narrow role ${expect.role} is a member of crewflow_app.`);
  if (facts.readOnly !== expect.readOnly) refuse(`the transaction is ${facts.readOnly ? 'READ ONLY' : 'READ WRITE'}; this step requires ${expect.readOnly ? 'READ ONLY' : 'READ WRITE'}.`);
  if (facts.serverVersionNum < MIN_OPS_SERVER_VERSION_NUM) refuse(`server_version_num ${facts.serverVersionNum} is below ${MIN_OPS_SERVER_VERSION_NUM}.`);
  if (facts.database !== expect.expectedDatabase) refuse(`current_database() "${facts.database}" differs from the app session's "${expect.expectedDatabase}".`);
}

/** What the restricted app session proved (the reference the elevated session must match). */
export interface OpsAppSessionProof {
  login: string;
  database: string;
  /** Sanitised marker summary (absent | unbound | <environment>/<deployment id>). */
  identity: string;
}

function queryOf(manager: EntityManager): Query {
  return (sql, params) => manager.query(sql, params) as Promise<Array<Record<string, unknown>>>;
}

/**
 * The restricted app session (the injected primary DataSource, PG_OPS_APP_DATABASE_URL): exactly crewflow_app, not
 * narrowed, not SUPERUSER/BYPASSRLS, no owner-role membership, plus the deployment identity read on it. Read only.
 */
export async function verifyOpsAppSession(
  dataSource: DataSource,
  resolved: ResolvedPgEnvironment,
  env: Record<string, string | undefined>,
  command: string,
): Promise<OpsAppSessionProof> {
  return dataSource.transaction(async (manager) => {
    await manager.query('SET TRANSACTION READ ONLY');
    const [row] = (await manager.query(OPS_APP_SESSION_FACTS_SQL)) as Array<Record<string, unknown>>;
    if (!row) throw new ElevatedOpsSessionError('the app session could not read its own role facts.');
    const login = String(row.login);
    const refuse = (why: string): never => {
      throw new ElevatedOpsSessionError(`app session refused: ${why}`);
    };
    if (login !== 'crewflow_app' || String(row.acting) !== 'crewflow_app') refuse(`PG_OPS_APP_DATABASE_URL must be the restricted runtime login crewflow_app (session is "${login}").`);
    if (login !== resolved.primary.target.user) refuse('session_user is not the login named by PG_OPS_APP_DATABASE_URL.');
    if (row.exempt === true) refuse('crewflow_app is SUPERUSER or BYPASSRLS.');
    if (row.owner_memberships) refuse(`crewflow_app is a member of an owner role (${String(row.owner_memberships)}).`);
    if (Number(row.server_version_num) < MIN_OPS_SERVER_VERSION_NUM) refuse('PostgreSQL 16 or later is required.');
    const database = String(row.database);
    if (database !== resolved.primary.target.database) refuse('current_database() differs from the database named by PG_OPS_APP_DATABASE_URL.');
    const identity = await assertDeploymentIdentity(queryOf(manager), {
      processLabel: `ops command ${command} (app session)`,
      production: isProductionProcess('cli', env),
      env,
      connectionHost: resolved.primary.target.host,
      command: true,
    });
    return { login, database, identity: identity.summary };
  });
}

/** A runner that accepts statement NAMES from the plan only. Returns the rows. */
export type OpsStatementRunner = (name: OpsStatementName, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/** One sanitised line per verified elevated transaction. */
export interface ElevatedTransactionRecord {
  plan: string;
  access: 'read-only' | 'read-write';
  login: string;
  acting: string;
  identity: string;
}

/**
 * The elevated session of one ops run. Open it once per run, use `transaction()` for every elevated step, destroy it.
 */
export class ElevatedOpsSession {
  private constructor(
    private readonly dataSource: DataSource,
    private readonly plan: OpsElevatedPlan,
    private readonly resolved: ResolvedPgEnvironment,
    private readonly env: Record<string, string | undefined>,
    private readonly app: OpsAppSessionProof,
    private readonly onVerified: (record: ElevatedTransactionRecord) => void,
  ) {}

  static async open(options: {
    plan: OpsElevatedPlan;
    resolved: ResolvedPgEnvironment;
    env: Record<string, string | undefined>;
    app: OpsAppSessionProof;
    onVerified?: (record: ElevatedTransactionRecord) => void;
  }): Promise<ElevatedOpsSession> {
    const { plan, resolved } = options;
    if (!resolved.ops || resolved.processRole !== 'ops') throw new ElevatedOpsSessionError('the elevated session exists only in the one-off ops container.');
    if (!resolved.elevated || resolved.elevated.source !== 'PG_DATABASE_URL') {
      throw new ElevatedOpsSessionError('the elevated session needs PG_DATABASE_URL (the migration identity) in the ops container.');
    }
    const dataSource = createPgDataSource(
      resolved,
      {
        endpoint: 'elevated',
        purpose: plan.purpose,
        max: 1,
        ...(plan.statementTimeoutMs !== undefined ? { statementTimeoutMs: plan.statementTimeoutMs, queryTimeoutMs: plan.statementTimeoutMs } : {}),
      },
      { name: `ops-elevated-${plan.purpose}-${Date.now()}`, entities: [], subscribers: [], migrations: [], synchronize: false, logging: false },
    );
    await dataSource.initialize();
    return new ElevatedOpsSession(dataSource, plan, resolved, options.env, options.app, options.onVerified ?? (() => undefined));
  }

  /**
   * One verified elevated transaction. `access` must be allowed by the plan; `fn` gets a runner that executes only the
   * plan's statement names for that access mode. Verification failures roll back before any data statement.
   */
  async transaction<T>(access: 'read-only' | 'read-write', fn: (run: OpsStatementRunner) => Promise<T>): Promise<T> {
    const allowed = access === 'read-only' ? this.plan.readStatements : this.plan.writeStatements;
    if (allowed.length === 0) throw new ElevatedOpsSessionError(`plan ${this.plan.purpose} allows no ${access} elevated transaction.`);
    const readOnly = access === 'read-only';
    const expect: OpsSessionExpectation = {
      expectedLogin: this.resolved.elevated!.target.user,
      expectedDatabase: this.app.database,
      role: this.plan.role,
      readOnly,
    };
    return this.dataSource.transaction(async (manager) => {
      if (readOnly) await manager.query('SET TRANSACTION READ ONLY');
      const before = parseOpsSessionFacts(((await manager.query(OPS_SESSION_FACTS_SQL, [this.plan.role])) as Array<Record<string, unknown>>)[0]);
      assertOpsLoginFacts(before, expect);
      await manager.query(SET_LOCAL_ROLE_SQL[this.plan.role]);
      const after = parseOpsSessionFacts(((await manager.query(OPS_SESSION_FACTS_SQL, [this.plan.role])) as Array<Record<string, unknown>>)[0]);
      assertOpsActingFacts(after, expect);
      const identity = await assertDeploymentIdentity(queryOf(manager), {
        processLabel: `ops command ${this.plan.purpose} (elevated session)`,
        production: isProductionProcess('cli', this.env),
        env: this.env,
        connectionHost: this.resolved.elevated!.target.host,
        command: true,
      });
      if (identity.summary !== this.app.identity || identity.database !== this.app.database) {
        throw new ElevatedOpsSessionError(
          `the elevated session reads deployment identity ${identity.summary} in "${identity.database}" but the app session read ${this.app.identity} in "${this.app.database}". Refusing.`,
        );
      }
      this.onVerified({ plan: this.plan.purpose, access, login: after.login, acting: after.acting, identity: identity.summary });
      const run: OpsStatementRunner = async (name, params = []) => {
        if (!(allowed as readonly string[]).includes(name)) {
          throw new ElevatedOpsSessionError(`statement "${name}" is not on the frozen ${access} list of plan ${this.plan.purpose}.`);
        }
        return (await manager.query(OPS_STATEMENTS[name], params)) as Array<Record<string, unknown>>;
      };
      return fn(run);
    });
  }

  async destroy(): Promise<void> {
    await this.dataSource.destroy().catch(() => undefined);
  }
}
