/**
 * Phase B / B3 (P3, owner-approved design: Option B primary, Option A secondary): provider-neutral deployment identity.
 *
 * WHY: the previous production pin (database-target.ts EXPECTED_PRODUCTION_IDENTITY) named one Neon endpoint. It did not
 * survive a provider move, it could be bypassed with a `?host=` URL override (finding F1), and it could not tell a clone of
 * production from production itself. The marker replaces it:
 *   - the database carries a protected singleton `core.deployment_identity(environment, deployment_id)` owned by the
 *     NOLOGIN `rab_secure_owner` (FORCE RLS, no runtime grants), readable only through the SECURITY DEFINER
 *     `core.deployment_identity_check()` and writable only through `core.deployment_identity_bind(...)`, which only the
 *     migration identity can call (migration DeploymentIdentity1786721230000);
 *   - every process declares what it expects through its own deployment environment:
 *       CREWFLOW_DEPLOYMENT_ENVIRONMENT  production | staging | development | test | ci
 *       CREWFLOW_DEPLOYMENT_ID           a uuid chosen when the database was bound
 *   - optional secondary check (Option A): PG_EXPECTED_DATABASE_NAME must equal current_database() when set.
 *   - owner decision A (2026-10-29) + host-binding review (A8b): the marker also records WHERE it was bound —
 *     `bound_database` (current_database() at bind time) and `bound_hosts` (a SET of 1 to 5 connection host names the
 *     operator confirmed, e.g. the direct host the Worker and migrations use plus the session-compatible proxy host the
 *     API uses). A bound marker is accepted only when the process's own current_database() equals bound_database and its
 *     own connection host (the factory's canonical parse of its URL) is one of bound_hosts; otherwise the database is a
 *     restore, clone or fork somewhere else (or the provider issued a new host name) and must be rebound with
 *     `db:bind-identity` first. Host NAMES are compared, never resolved addresses: a DNS / IP change behind the same name
 *     and a managed failover that keeps the name pass. Only `db:bind-identity` itself may read a marker bound elsewhere
 *     (that is what it exists to fix).
 * `system_identifier` is recorded at bind time when callable and compared as a WARNING only, never as proof: forks,
 * physical restores and branches inherit it, logical restores change it.
 *
 * Never NODE_ENV, a hostname alone, or an editable flag decides "this is production". A process is production when its
 * own deployment environment says so (runtime: NODE_ENV=production + RAB_RUNTIME_ENV=production; command: DB_TARGET=production),
 * and then the DATABASE must agree through the protected marker.
 *
 * This module is pure apart from `readDeploymentMarker`, which takes an injected query function. Messages carry
 * environment names, deployment ids (identifiers, not secrets) and database names only: never a URL, user or password.
 */
import { isIPv4 } from 'net';

export const DEPLOYMENT_ENVIRONMENTS = ['production', 'staging', 'development', 'test', 'ci'] as const;
export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

export const DEPLOYMENT_ENVIRONMENT_VAR = 'CREWFLOW_DEPLOYMENT_ENVIRONMENT';

/**
 * test-database-guard.ts DISPOSABLE_TEST_DATABASE_SETTING, repeated rather than imported (that module opens its own pg
 * clients; this one stays pure). deployment-identity.spec.ts asserts the two are equal.
 */
export const DISPOSABLE_TEST_DATABASE_SETTING_NAME = 'crewflow.disposable_test_database';
export const DEPLOYMENT_ID_VAR = 'CREWFLOW_DEPLOYMENT_ID';
export const EXPECTED_DATABASE_NAME_VAR = 'PG_EXPECTED_DATABASE_NAME';

/**
 * One-time bootstrap of an UNBOUND production database (the marker migration is not applied yet, or applied but never
 * bound). Honoured ONLY by production commands (DB_TARGET=production: the migration runner and `db:bind-identity`), never
 * by the API/Worker runtime, and only with this exact value. It also requires PG_EXPECTED_DATABASE_NAME (Option A) so the
 * unbound database is at least pinned by name. Once the database is bound, the flag being present is itself a refusal: a
 * forgotten bootstrap flag must not linger in a deployment environment.
 */
export const IDENTITY_BOOTSTRAP_VAR = 'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP';
export const IDENTITY_BOOTSTRAP_VALUE = 'unbound-production-database';

/** Migration that creates the marker (approved for isolated testing only; not approved for production). */
export const DEPLOYMENT_IDENTITY_MIGRATION = 'DeploymentIdentity1786721230000';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DeploymentIdentityError extends Error {
  /** The SQLSTATE behind the refusal when a database call failed (e.g. 42501: the login may not read the marker). */
  readonly sqlState?: string;

  constructor(message: string, sqlState?: string) {
    super(message);
    this.name = 'DeploymentIdentityError';
    if (sqlState) this.sqlState = sqlState;
  }
}

/** SQLSTATE 42501 insufficient_privilege, from a pg error or a DeploymentIdentityError that carries one. */
export function isInsufficientPrivilege(error: unknown): boolean {
  if (error instanceof DeploymentIdentityError) return error.sqlState === '42501';
  return (error as { code?: string } | null)?.code === '42501';
}

export interface DeclaredDeploymentIdentity {
  environment: DeploymentEnvironment;
  /** Lower-case canonical uuid. */
  deploymentId: string;
}

export type DeploymentMarker =
  /** core.deployment_identity_check() does not exist: the marker migration is not applied to this database. */
  | { state: 'absent' }
  /** The migration is applied but nothing was ever bound. */
  | { state: 'unbound' }
  | {
      state: 'bound';
      environment: string;
      deploymentId: string;
      /** current_database() recorded at bind time (null only for a pre-location marker shape: refused as unrecognised). */
      boundDatabase?: string | null;
      /** The operator-confirmed connection hosts recorded at bind time (lower-case, 1 to 5; null/empty: refused as unrecognised). */
      boundHosts?: readonly string[] | null;
      /** pg_control_system().system_identifier at bind time, when the definer could read it. Informational. */
      boundSystemIdentifier?: string | null;
      /** The cluster's system_identifier now, read by the definer when callable. Informational. */
      currentSystemIdentifier?: string | null;
    };

export function isDeploymentEnvironment(value: string): value is DeploymentEnvironment {
  return (DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(value);
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Reads CREWFLOW_DEPLOYMENT_ENVIRONMENT + CREWFLOW_DEPLOYMENT_ID. Both or neither: one without the other is refused (a
 * half-configured deployment is a misconfiguration, never "no identity"). Empty strings count as unset.
 */
export function readDeclaredDeploymentIdentity(env: Record<string, string | undefined>): DeclaredDeploymentIdentity | null {
  const environment = env[DEPLOYMENT_ENVIRONMENT_VAR]?.trim() || '';
  const deploymentId = env[DEPLOYMENT_ID_VAR]?.trim() || '';
  if (!environment && !deploymentId) return null;
  if (!environment || !deploymentId) {
    throw new DeploymentIdentityError(
      `${DEPLOYMENT_ENVIRONMENT_VAR} and ${DEPLOYMENT_ID_VAR} must be set together (only ${environment ? DEPLOYMENT_ENVIRONMENT_VAR : DEPLOYMENT_ID_VAR} is set).`,
    );
  }
  if (!isDeploymentEnvironment(environment)) {
    throw new DeploymentIdentityError(`${DEPLOYMENT_ENVIRONMENT_VAR} "${environment}" is not recognised. Use one of: ${DEPLOYMENT_ENVIRONMENTS.join(', ')}.`);
  }
  if (!isUuid(deploymentId)) {
    throw new DeploymentIdentityError(`${DEPLOYMENT_ID_VAR} must be a uuid (value not shown).`);
  }
  return { environment, deploymentId: deploymentId.toLowerCase() };
}

/**
 * Pure env rules that need no connection. `production` is the process's own classification (runtime: NODE_ENV=production;
 * command: DB_TARGET=production). Returns the declared identity (null outside production when unset).
 */
export function assertDeclaredIdentityForProcess(
  env: Record<string, string | undefined>,
  production: boolean,
  processLabel: string,
): DeclaredDeploymentIdentity | null {
  const declared = readDeclaredDeploymentIdentity(env);
  if (production) {
    if (!declared) {
      throw new DeploymentIdentityError(
        `the production ${processLabel} requires ${DEPLOYMENT_ENVIRONMENT_VAR}=production and ${DEPLOYMENT_ID_VAR}=<uuid> from the deployment environment.`,
      );
    }
    if (declared.environment !== 'production') {
      throw new DeploymentIdentityError(
        `the production ${processLabel} declares ${DEPLOYMENT_ENVIRONMENT_VAR}=${declared.environment}. A production process must declare production.`,
      );
    }
  } else if (declared?.environment === 'production') {
    throw new DeploymentIdentityError(
      `a non-production ${processLabel} declares ${DEPLOYMENT_ENVIRONMENT_VAR}=production. Production is decided by the process's own production settings, never by this variable alone.`,
    );
  }
  return declared;
}

/** Bootstrap flag: anything other than unset or the exact value is refused (fail closed on typos). */
export function readBootstrapFlag(env: Record<string, string | undefined>): boolean {
  const raw = env[IDENTITY_BOOTSTRAP_VAR]?.trim();
  if (!raw) return false;
  if (raw !== IDENTITY_BOOTSTRAP_VALUE) {
    throw new DeploymentIdentityError(`${IDENTITY_BOOTSTRAP_VAR} must be unset or exactly "${IDENTITY_BOOTSTRAP_VALUE}".`);
  }
  return true;
}

export interface DeploymentIdentityDecisionInput {
  /** e.g. "api process", "migrations command". */
  processLabel: string;
  production: boolean;
  declared: DeclaredDeploymentIdentity | null;
  marker: DeploymentMarker;
  /** Production COMMANDS only (never the runtime): the one-time bootstrap of an unbound production database. */
  bootstrapRequested?: boolean;
  /** PG_EXPECTED_DATABASE_NAME, already compared with current_database() by the caller when set. */
  expectedDatabaseNameSet?: boolean;
  /** current_database() as the server reports it on the checking connection. */
  currentDatabase: string;
  /** The host this process's checking connection names: the factory's canonical parse (lower-case, no brackets). */
  connectionHost: string;
  /**
   * 'refuse' (every runtime and command): a bound marker whose database or host differs is a refusal. 'warn': ONLY the
   * audited rebind command, which must be able to read a marker bound elsewhere in order to rebind it.
   */
  locationMismatch?: 'refuse' | 'warn';
  /**
   * Security review H-1 (option 2): outside production an ABSENT or UNBOUND marker on a remote host (dotted name or
   * non-loopback IP) is refused unless this is true. assertDeploymentIdentity sets it only for NODE_ENV=test on a database
   * that carries the server-side disposable-test setting (security review N-2), or for a COMMAND with DB_TARGET=test
   * together with ALLOW_REMOTE_TEST_DATABASE=true (see remoteUnmarkedDatabaseAllowed). Loopback and single-label
   * docker-service hosts (`postgres`, `devdb`) are unaffected.
   */
  remoteUnmarkedAllowed?: boolean;
}

export interface DeploymentIdentityDecision {
  warnings: string[];
  /** Sanitised, loggable one-word summary: absent | unbound | bootstrap | <environment>/<deployment id>. */
  summary: string;
  bootstrap: boolean;
}

/** Canonical form of a connection host for the location comparison (the factory already lower-cases and strips brackets). */
export function canonicalHost(host: string): string {
  return host.trim().replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * Loopback: `localhost`, `::1`, or a REAL IPv4 literal in 127.0.0.0/8 (net.isIPv4 rejects octets above 255 and leading
 * zeros, so a resolvable dotted name such as `127.999.999.999` or `127.0.0.09` stays remote — final review F3).
 */
export function isLoopbackHost(host: string): boolean {
  const h = canonicalHost(host);
  return h === 'localhost' || h === '::1' || (isIPv4(h) && h.startsWith('127.'));
}

/**
 * Security review H-1: a REMOTE host for the unmarked-database rule — a dotted name (`db.example.com`), a non-loopback IPv4
 * or IPv6 literal. Loopback and a single-label name (a docker-compose service such as `postgres` or `devdb`) are local. An
 * empty / unknown host counts as remote (fail closed).
 */
export function isRemoteDatabaseHost(host: string): boolean {
  const h = canonicalHost(host);
  if (!h) return true;
  if (isLoopbackHost(h)) return false;
  return h.includes('.') || h.includes(':');
}

export interface RemoteUnmarkedFacts {
  /**
   * Security review N-2: the PROBED database carries `crewflow.disposable_test_database = 'true'` as a DATABASE-level
   * setting (pg_db_role_setting; test-database-guard.ts DISPOSABLE_TEST_DATABASE_SETTING) — a server-side fact that a
   * connection string or session cannot set. Read on the checking connection by readDeploymentMarker.
   */
  disposableTestDatabase: boolean;
  /**
   * The caller is a database COMMAND (DB_TARGET is its target selection: migrations, CLI, ops). A runtime process (API,
   * Worker, Provisioner) passes false: it may tolerate DB_TARGET=local|test from a developer .env (never-in-runtime-env.ts)
   * but never READS it, so DB_TARGET=test + ALLOW_REMOTE_TEST_DATABASE=true grants a runtime nothing.
   */
  command: boolean;
}

/**
 * Security review H-1 / N-2: whether this process may use an ABSENT or UNBOUND marker on a remote host. Only:
 *   - NODE_ENV=test on a database the server itself marks as a disposable test database. NODE_ENV=test alone is NOT
 *     enough: `test` is a valid NODE_ENV for any runtime (API / Worker / Provisioner), and on its own it would let such a
 *     process accept an unmarked remote database that could be production; or
 *   - a COMMAND that explicitly targets a remote TEST database (DB_TARGET=test AND ALLOW_REMOTE_TEST_DATABASE=true, both
 *     from the process environment).
 * Fail closed: anything not provably one of these is refused (the caller only asks for remote hosts).
 */
export function remoteUnmarkedDatabaseAllowed(env: Record<string, string | undefined>, facts: RemoteUnmarkedFacts): boolean {
  if (env.NODE_ENV === 'test' && facts.disposableTestDatabase === true) return true;
  return facts.command === true && env.DB_TARGET?.trim() === 'test' && env.ALLOW_REMOTE_TEST_DATABASE === 'true';
}

const REBIND_HINT =
  'If this database is a restore, clone, fork or branch, or the deployment really moved, record the new location with the ' +
  'audited migration-identity command `db:bind-identity` (rebind with --confirm-current-deployment-id and a NEW deployment id), ' +
  `then set ${DEPLOYMENT_ID_VAR} on every process that uses it. Otherwise point this process at the database it is bound to.`;

/** `"a"` or `"a", "b"` — host names only (never a URL, user or password). */
const quoteHosts = (hosts: readonly string[]) => hosts.map((h) => `"${h}"`).join(', ');

/** Location rule (owner decision A + host-binding review). Returns warnings; throws for a refusal. */
export function assertMarkerLocation(
  marker: Extract<DeploymentMarker, { state: 'bound' }>,
  input: Pick<DeploymentIdentityDecisionInput, 'processLabel' | 'currentDatabase' | 'connectionHost' | 'locationMismatch'>,
): string[] {
  const warnings: string[] = [];
  const boundDatabase = marker.boundDatabase ?? '';
  const boundHosts = (marker.boundHosts ?? []).map(canonicalHost).filter((h) => h.length > 0);
  if (!boundDatabase || boundHosts.length === 0) {
    throw new DeploymentIdentityError('the database deployment identity marker carries no bound database or host (unrecognised marker shape). Refusing.');
  }
  const here = canonicalHost(input.connectionHost);
  const problems: string[] = [];
  if (!input.currentDatabase || input.currentDatabase !== boundDatabase) {
    problems.push(`the server reports database "${input.currentDatabase}" but the marker was bound in database "${boundDatabase}"`);
  }
  // Exact host-name membership: no wildcard, no suffix match, no DNS resolution (an address change behind the same name
  // is not a move; a different name is, until the audited rebind records it).
  if (!here || !boundHosts.includes(here)) {
    problems.push(
      `this ${input.processLabel} connects to host "${here}" but the marker was bound at ${boundHosts.length === 1 ? 'host' : 'hosts'} ${quoteHosts(boundHosts)}`,
    );
  }
  if (problems.length) {
    const what = `${problems.join('; ')} (bound to ${marker.environment}/${marker.deploymentId.toLowerCase()})`;
    if (input.locationMismatch === 'warn') {
      warnings.push(`LOCATION MISMATCH: ${what}. Accepted only by the rebind command.`);
    } else {
      throw new DeploymentIdentityError(`the ${input.processLabel} refuses to run: ${what}. ${REBIND_HINT} Refusing.`);
    }
  }
  const sidBound = marker.boundSystemIdentifier ?? null;
  const sidNow = marker.currentSystemIdentifier ?? null;
  if (sidBound && sidNow && sidBound !== sidNow) {
    warnings.push(
      `the cluster system_identifier (${sidNow}) differs from the one recorded at bind time (${sidBound}): the database was ` +
        'restored or copied into another cluster (a logical restore changes it; physical copies keep it). Informational only, ' +
        'never proof; the database and host checks decide.',
    );
  }
  return warnings;
}

const BIND_HINT =
  'Bind it with the audited migration-identity command `db:bind-identity` (docs: deployment identity runbook), then set ' +
  `${DEPLOYMENT_ENVIRONMENT_VAR} and ${DEPLOYMENT_ID_VAR} to the bound values.`;

/** The whole marker decision. Throws DeploymentIdentityError; never returns for a refusal. */
export function decideDeploymentIdentity(input: DeploymentIdentityDecisionInput): DeploymentIdentityDecision {
  const { processLabel, production, declared, marker } = input;
  const bootstrapRequested = input.bootstrapRequested === true;
  const warnings: string[] = [];

  if (marker.state === 'absent' || marker.state === 'unbound') {
    const what =
      marker.state === 'absent'
        ? `the database has no deployment identity marker (migration ${DEPLOYMENT_IDENTITY_MIGRATION} is not applied)`
        : 'the database deployment identity marker exists but was never bound';
    if (production) {
      if (bootstrapRequested) {
        if (!input.expectedDatabaseNameSet) {
          throw new DeploymentIdentityError(
            `${IDENTITY_BOOTSTRAP_VAR} needs ${EXPECTED_DATABASE_NAME_VAR} as well: an unbound production database is at least pinned by name during bootstrap.`,
          );
        }
        warnings.push(`BOOTSTRAP: ${what}; proceeding only because ${IDENTITY_BOOTSTRAP_VAR}=${IDENTITY_BOOTSTRAP_VALUE}. Bind it now and remove the flag.`);
        return { warnings, summary: 'bootstrap', bootstrap: true };
      }
      throw new DeploymentIdentityError(`the production ${processLabel} refuses to run: ${what}. ${BIND_HINT}`);
    }
    if (declared) {
      throw new DeploymentIdentityError(
        `the ${processLabel} declares ${declared.environment}/${declared.deploymentId}, but ${what}. ${BIND_HINT} Or unset both variables outside production.`,
      );
    }
    // Security review H-1 (option 2): an unmarked database on a remote host cannot be told apart from an unmarked
    // production database, so a non-production process refuses it unless it is explicitly a remote TEST database.
    if (isRemoteDatabaseHost(input.connectionHost) && input.remoteUnmarkedAllowed !== true) {
      throw new DeploymentIdentityError(
        `the ${processLabel} refuses to run: ${what}, and it connects to the remote host "${canonicalHost(input.connectionHost)}". ` +
          'An unmarked remote database cannot be told apart from an unmarked production database. Use a loopback or ' +
          'docker-service database; or bind this database as test, ci, staging or development with the audited ' +
          `\`db:bind-identity\` command and set ${DEPLOYMENT_ENVIRONMENT_VAR} and ${DEPLOYMENT_ID_VAR}; or, for a disposable ` +
          'remote test database only, run a command with DB_TARGET=test and ALLOW_REMOTE_TEST_DATABASE=true, or a NODE_ENV=test ' +
          `process against a database marked with ALTER DATABASE <name> SET ${DISPOSABLE_TEST_DATABASE_SETTING_NAME} = 'true'. Refusing.`,
      );
    }
    warnings.push(`${what}; allowed outside production with no declared identity.`);
    return { warnings, summary: marker.state, bootstrap: false };
  }

  if (bootstrapRequested) {
    throw new DeploymentIdentityError(
      `${IDENTITY_BOOTSTRAP_VAR} is set but the database is already bound (${marker.environment}). Remove the flag from the deployment environment.`,
    );
  }
  if (!isDeploymentEnvironment(marker.environment) || !isUuid(marker.deploymentId)) {
    throw new DeploymentIdentityError('the database deployment identity marker holds an unrecognised value. Refusing.');
  }
  const boundId = marker.deploymentId.toLowerCase();
  const bound = `${marker.environment}/${boundId}`;
  // Owner decision A: a marker bound in another database or at another host is a restore / clone / fork. Refused before
  // anything else is compared, so a copy that still carries the original's environment and id is never accepted as it.
  warnings.push(...assertMarkerLocation(marker, input));

  if (declared) {
    if (declared.environment !== marker.environment || declared.deploymentId !== boundId) {
      throw new DeploymentIdentityError(
        `the ${processLabel} declares ${declared.environment}/${declared.deploymentId}, but the database is bound to ${bound}. ` +
          'It is pointed at the wrong database, or the database is a copy that must be rebound with db:bind-identity before use. Refusing.',
      );
    }
    return { warnings, summary: bound, bootstrap: false };
  }
  // No declaration (non-production only: production without a declaration was refused by assertDeclaredIdentityForProcess).
  if (production) {
    throw new DeploymentIdentityError(`the production ${processLabel} has no declared deployment identity. Refusing.`);
  }
  if (marker.environment === 'production') {
    throw new DeploymentIdentityError(
      `the database is bound to production (${bound}) and this non-production ${processLabel} must not use it. ` +
        'If it is a clone or restore of production, rebind it with db:bind-identity (production command authority, new deployment id) before pointing anything at it. Refusing.',
    );
  }
  warnings.push(`the database is bound to ${bound} but this ${processLabel} declares no identity; set ${DEPLOYMENT_ENVIRONMENT_VAR} and ${DEPLOYMENT_ID_VAR}.`);
  return { warnings, summary: bound, bootstrap: false };
}

/** Option A secondary: PG_EXPECTED_DATABASE_NAME, when set, must equal the server-reported database name. */
export function assertExpectedDatabaseName(env: Record<string, string | undefined>, currentDatabase: string, processLabel: string): boolean {
  const expected = env[EXPECTED_DATABASE_NAME_VAR]?.trim();
  if (!expected) return false;
  if (expected !== currentDatabase) {
    throw new DeploymentIdentityError(
      `the ${processLabel} expects database "${expected}" (${EXPECTED_DATABASE_NAME_VAR}) but the server reports "${currentDatabase}". Refusing.`,
    );
  }
  return true;
}

export type Query = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/**
 * Marker presence is decided by the CHECK function, not the table: the runtime roles hold no privilege on the table (by
 * design) but do hold EXECUTE on the function. `to_regprocedure` resolves without EXECUTE, so a missing function reads as
 * "absent" while a present function the caller cannot run raises (42501) — a refusal, never "absent".
 */
export const MARKER_PRESENT_SQL =
  `SELECT pg_catalog.to_regprocedure('core.deployment_identity_check()') IS NOT NULL AS present, pg_catalog.current_database() AS database, ` +
  // Security review N-2: the DATABASE-level disposable-test setting from the catalog (the same predicate as
  // test-database-guard.ts and ai-access.service.ts), never current_setting(): a connection string can set any session value.
  'EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase, ' +
  'pg_catalog.unnest(s.setconfig) cfg WHERE d.datname = pg_catalog.current_database() AND s.setrole = 0 ' +
  `AND cfg = '${DISPOSABLE_TEST_DATABASE_SETTING_NAME}=true') AS disposable_test`;
export const MARKER_READ_SQL =
  'SELECT environment, deployment_id::text AS deployment_id, bound_database, bound_hosts, ' +
  'bound_system_identifier::text AS bound_system_identifier, current_system_identifier::text AS current_system_identifier ' +
  'FROM core.deployment_identity_check()';

export async function readDeploymentMarker(query: Query): Promise<{ marker: DeploymentMarker; database: string; disposableTestDatabase: boolean }> {
  const [presence] = await query(MARKER_PRESENT_SQL);
  const database = String(presence?.database ?? '');
  // Only an explicit boolean true counts (a missing column, NULL or a string is "not disposable": fail closed).
  const disposableTestDatabase = presence?.disposable_test === true;
  if (!presence?.present) return { marker: { state: 'absent' }, database, disposableTestDatabase };
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await query(MARKER_READ_SQL);
  } catch (error) {
    const code = (error as { code?: string })?.code ?? 'unknown';
    throw new DeploymentIdentityError(`the deployment identity marker exists but could not be read (SQLSTATE ${code}). Refusing.`, code);
  }
  if (rows.length === 0) return { marker: { state: 'unbound' }, database, disposableTestDatabase };
  if (rows.length !== 1) throw new DeploymentIdentityError('the deployment identity marker returned more than one row. Refusing.');
  const row = rows[0];
  const text = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
  // node-postgres parses text[] into a string array; a driver that hands back the literal `{a,b}` is accepted too (host
  // names never contain a comma, quote, brace or space).
  const hosts = (v: unknown): string[] | null => {
    if (Array.isArray(v)) return v.map((h) => String(h));
    if (typeof v === 'string' && /^\{[^"\\{}\s]*\}$/.test(v)) return v.slice(1, -1).split(',').filter((h) => h.length > 0);
    return null;
  };
  return {
    marker: {
      state: 'bound',
      environment: String(row.environment),
      deploymentId: String(row.deployment_id),
      boundDatabase: text(row.bound_database),
      boundHosts: hosts(row.bound_hosts),
      boundSystemIdentifier: text(row.bound_system_identifier),
      currentSystemIdentifier: text(row.current_system_identifier),
    },
    database,
    disposableTestDatabase,
  };
}

export interface AssertDeploymentIdentityOptions {
  processLabel: string;
  production: boolean;
  env: Record<string, string | undefined>;
  /** Production commands only. The runtime never passes true. */
  allowBootstrap?: boolean;
  /**
   * The host the checking connection names (the factory's canonical parse of the process's own URL for that endpoint).
   * Required: a bound marker is accepted only when this host is one of the hosts it was bound at (owner decision A).
   */
  connectionHost: string;
  /** Only `db:bind-identity` passes 'warn'. Everything else refuses a marker bound in another database or at another host. */
  locationMismatch?: 'refuse' | 'warn';
  /**
   * True only for database COMMANDS (DB_TARGET is their target selection). Default false: a runtime process never reads
   * DB_TARGET, so the remote-test allowance DB_TARGET=test + ALLOW_REMOTE_TEST_DATABASE=true applies to commands only.
   */
  command?: boolean;
}

/** Live check: declared env + PG_EXPECTED_DATABASE_NAME + the marker. Read-only. */
export async function assertDeploymentIdentity(query: Query, options: AssertDeploymentIdentityOptions): Promise<DeploymentIdentityDecision & { database: string }> {
  const { processLabel, production, env } = options;
  const declared = assertDeclaredIdentityForProcess(env, production, processLabel);
  const bootstrapRequested = readBootstrapFlag(env);
  if (bootstrapRequested && !(options.allowBootstrap && production)) {
    throw new DeploymentIdentityError(`${IDENTITY_BOOTSTRAP_VAR} is honoured only by production database commands, never by the ${processLabel}. Remove it.`);
  }
  const { marker, database, disposableTestDatabase } = await readDeploymentMarker(query);
  const expectedDatabaseNameSet = assertExpectedDatabaseName(env, database, processLabel);
  const decision = decideDeploymentIdentity({
    processLabel,
    production,
    declared,
    marker,
    bootstrapRequested,
    expectedDatabaseNameSet,
    currentDatabase: database,
    connectionHost: options.connectionHost,
    locationMismatch: options.locationMismatch ?? 'refuse',
    remoteUnmarkedAllowed: remoteUnmarkedDatabaseAllowed(env, { disposableTestDatabase, command: options.command === true }),
  });
  return { ...decision, database };
}
