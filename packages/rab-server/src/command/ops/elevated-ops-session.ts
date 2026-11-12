/**
 * The NARROWED session of the three owner ops commands (Phase X2.2, the owner-login path, command/ops/ops-run.ts). There is
 * no second credential: the app session is the CLI's own primary DataSource and must be exactly crewflow_owner
 * (session_user = current_user, not narrowed, not SUPERUSER/BYPASSRLS, the URL's user and database; verifyOpsAppSession).
 * The narrowed session is a separate one-connection pool on the SAME PG_DATABASE_URL (application_name
 * crewflow-cli-<purpose>).
 *
 * crewflow_owner holds `rab_secure_owner, crewflow WITH INHERIT TRUE, SET TRUE` (the owner-login bootstrap; PostgreSQL 16
 * membership options): nothing is granted here. Because INHERIT is true, the bare login already holds BOTH owners'
 * privileges; `SET LOCAL ROLE <narrow role>` therefore NARROWS the session to one owner (rab_secure_owner has no
 * memberships, so acting as it drops crewflow's privileges). It never widens. A `SET ROLE` is only possible to a role the
 * SESSION user reaches through grants that all carry SET (pg_has_role(..., 'SET')).
 *
 * IMPORTANT: SET ROLE guards against ACCIDENTS, not against code running in the same session — `RESET ROLE` (or a new
 * transaction without `SET LOCAL ROLE`) undoes it. What actually limits this session is: (1) a READ ONLY transaction for
 * every read-only step (PostgreSQL refuses writes and DDL in it, and it cannot be switched back once a query ran);
 * (2) the FROZEN statement list — callers pass a statement NAME, never SQL text, and a plan allows only the names it lists
 * for that access mode (ops-statements.ts). These lists limit the COMMAND CODE, not the operator (G-02).
 *
 * Before ANY statement of each transaction (pool max 1):
 *   BEGIN; [SET TRANSACTION READ ONLY]
 *   facts BEFORE narrowing  (OPS_SESSION_FACTS_SQL, assertOwnerLoginFacts): the login is crewflow_owner, a LOGIN role, not
 *                           SUPERUSER/BYPASSRLS, a member of both owner roles, may SET the intended role, nothing narrowed
 *                           yet, PostgreSQL 16+, the app session's database, the intended access mode;
 *   SET LOCAL ROLE <role>   (from a frozen literal, never interpolated input);
 *   facts AFTER narrowing   (assertOpsActingFacts) current_user = the intended role, not SUPERUSER/BYPASSRLS,
 *                           rab_secure_owner holds no crewflow privileges (and crewflow none of rab_secure_owner's),
 *                           transaction_read_only as intended, same database;
 *   deployment identity     assertDeploymentIdentity (deployment-identity.ts) on THIS session, read-only, and its summary
 *                           must equal the app session's (same database, same marker).
 * Any mismatch throws ElevatedOpsSessionError before the first data statement. `SET LOCAL` ends with the transaction, and
 * the pool's RESET ROLE on checkout (session-role-reset.ts) still runs before every transaction.
 *
 * The separated-mode half of this file (the removed rab-ops container: a crewflow_app app session plus a second,
 * migration-identity login as the "elevated" session) is gone; the class and error names are kept so the audit trail and
 * the logs read the same.
 */
import { DataSource, EntityManager } from 'typeorm';

import { isProductionProcess } from '../../database/boot-checks/database-boot-gate-rules';
import { OWNER_LOGIN_ROLE } from '../../database/boot-checks/owner-login-posture';
import { assertDeploymentIdentity, Query } from '../../database/deployment-identity/deployment-identity';
import { createPgDataSource, ResolvedPgEnvironment } from '../../database/postgres';
import type { OpsRunPath } from './ops-run';
import { OPS_STATEMENTS, OpsElevatedPlan, OpsStatementName } from './ops-statements';

export const MIN_OPS_SERVER_VERSION_NUM = 160000;

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
  /** The user named by PG_DATABASE_URL (the owner login crewflow_owner). */
  expectedLogin: string;
  /** current_database() of the app session (and the URL's database). */
  expectedDatabase: string;
  role: OpsElevatedPlan['role'];
  readOnly: boolean;
}

/**
 * The pure decision BEFORE `SET LOCAL ROLE`. The login is the owner login itself: crewflow_owner deliberately holds an
 * ADMIN-only membership row on crewflow_app (owner-login bootstrap), so no "no ADMIN option" check applies, and its whole
 * role posture (attributes, reachability, inventory) is verified by the CLI boot gate before any command body runs. What this step proves on THIS session: it is
 * crewflow_owner, a LOGIN role, not SUPERUSER/BYPASSRLS, a member of both owner roles, allowed to SET the narrow role, not
 * already acting as another role, PostgreSQL 16+, the app session's database, and the intended access mode.
 */
export function assertOwnerLoginFacts(facts: OpsSessionFacts, expect: OpsSessionExpectation): void {
  const refuse = (why: string): never => {
    throw new ElevatedOpsSessionError(`owner-login session refused before narrowing: ${why}`);
  };
  if (facts.login !== OWNER_LOGIN_ROLE || expect.expectedLogin !== OWNER_LOGIN_ROLE) refuse(`session_user is "${facts.login}", not the owner login ${OWNER_LOGIN_ROLE}.`);
  if (!facts.loginCanLogin) refuse('the session user is not a LOGIN role.');
  if (facts.loginExempt) refuse(`${OWNER_LOGIN_ROLE} is SUPERUSER or BYPASSRLS; refusing.`);
  if (!facts.loginMemberSecureOwner || !facts.loginMemberCrewflow) refuse(`${OWNER_LOGIN_ROLE} is not a member of both rab_secure_owner and crewflow (not the owner-login layout).`);
  if (!facts.canSetRole) refuse(`${OWNER_LOGIN_ROLE} may not SET ROLE ${expect.role}; refusing.`);
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

/** What the app session proved (the reference the narrowed session must match). */
export interface OpsAppSessionProof {
  /** Which path verified this session (always the owner login since rab-ops was removed; recorded for audit continuity). */
  path: OpsRunPath;
  login: string;
  database: string;
  /** Sanitised marker summary (absent | unbound | <environment>/<deployment id>). */
  identity: string;
}

function queryOf(manager: EntityManager): Query {
  return (sql, params) => manager.query(sql, params) as Promise<Array<Record<string, unknown>>>;
}

/**
 * The app session (the injected primary DataSource), read only, plus the deployment identity read on it: PG_DATABASE_URL,
 * exactly crewflow_owner (session_user = current_user, so not narrowed), not SUPERUSER/BYPASSRLS, the URL's database
 * (ops-run.ts has already refused anything but the CLI process). Any other login is refused here, on the database, before
 * the command's first data statement.
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
    if (login !== OWNER_LOGIN_ROLE || String(row.acting) !== OWNER_LOGIN_ROLE) {
      refuse(`the ops commands run only under the owner login ${OWNER_LOGIN_ROLE} (session_user "${login}", current_user "${String(row.acting)}").`);
    }
    if (resolved.primary.source !== 'PG_DATABASE_URL' || login !== resolved.primary.target.user) refuse('session_user is not the login named by PG_DATABASE_URL.');
    if (row.exempt === true) refuse(`${OWNER_LOGIN_ROLE} is SUPERUSER or BYPASSRLS.`);
    if (Number(row.server_version_num) < MIN_OPS_SERVER_VERSION_NUM) refuse('PostgreSQL 16 or later is required.');
    const database = String(row.database);
    if (database !== resolved.primary.target.database) refuse('current_database() differs from the database named by PG_DATABASE_URL.');
    const identity = await assertDeploymentIdentity(queryOf(manager), {
      processLabel: `ops command ${command} (owner-login session)`,
      production: isProductionProcess('cli', env),
      env,
      connectionHost: resolved.primary.target.host,
      command: true,
    });
    return { path: 'owner-login', login, database, identity: identity.summary };
  });
}

/** A runner that accepts statement NAMES from the plan only. Returns the rows. */
export type OpsStatementRunner = (name: OpsStatementName, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/** One sanitised line per verified narrowed transaction. */
export interface ElevatedTransactionRecord {
  plan: string;
  access: 'read-only' | 'read-write';
  login: string;
  acting: string;
  identity: string;
}

/**
 * The narrowed session of one ops run. Open it once per run, use `transaction()` for every narrowed step, destroy it.
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
    const { plan, resolved, app } = options;
    // The same login on its own one-connection pool (no second credential exists).
    if (app.path !== 'owner-login') throw new ElevatedOpsSessionError('the narrowed session exists only on the owner-login path.');
    if (resolved.processRole !== 'cli') throw new ElevatedOpsSessionError('the owner-login elevated session exists only in a one-off CLI process.');
    if (resolved.elevated !== null) throw new ElevatedOpsSessionError('the owner-login path uses the one login only; a second database endpoint is refused.');
    if (resolved.primary.source !== 'PG_DATABASE_URL' || resolved.primary.target.user !== OWNER_LOGIN_ROLE || app.login !== OWNER_LOGIN_ROLE) {
      throw new ElevatedOpsSessionError(`the owner-login elevated session needs PG_DATABASE_URL naming ${OWNER_LOGIN_ROLE}.`);
    }
    const dataSource = createPgDataSource(
      resolved,
      {
        endpoint: 'primary',
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
   * One verified narrowed transaction. `access` must be allowed by the plan; `fn` gets a runner that executes only the
   * plan's statement names for that access mode. Verification failures roll back before any data statement.
   */
  async transaction<T>(access: 'read-only' | 'read-write', fn: (run: OpsStatementRunner) => Promise<T>): Promise<T> {
    const allowed = access === 'read-only' ? this.plan.readStatements : this.plan.writeStatements;
    if (allowed.length === 0) throw new ElevatedOpsSessionError(`plan ${this.plan.purpose} allows no ${access} elevated transaction.`);
    const readOnly = access === 'read-only';
    const endpoint = this.resolved.primary;
    const expect: OpsSessionExpectation = {
      expectedLogin: endpoint.target.user,
      expectedDatabase: this.app.database,
      role: this.plan.role,
      readOnly,
    };
    return this.dataSource.transaction(async (manager) => {
      if (readOnly) await manager.query('SET TRANSACTION READ ONLY');
      const before = parseOpsSessionFacts(((await manager.query(OPS_SESSION_FACTS_SQL, [this.plan.role])) as Array<Record<string, unknown>>)[0]);
      assertOwnerLoginFacts(before, expect);
      await manager.query(SET_LOCAL_ROLE_SQL[this.plan.role]);
      const after = parseOpsSessionFacts(((await manager.query(OPS_SESSION_FACTS_SQL, [this.plan.role])) as Array<Record<string, unknown>>)[0]);
      assertOpsActingFacts(after, expect);
      const identity = await assertDeploymentIdentity(queryOf(manager), {
        processLabel: `ops command ${this.plan.purpose} (owner-login narrowed session)`,
        production: isProductionProcess('cli', this.env),
        env: this.env,
        connectionHost: endpoint.target.host,
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
