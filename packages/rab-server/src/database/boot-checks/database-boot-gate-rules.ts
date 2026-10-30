/**
 * Phase B database boot gates: the RULES (pure decisions over an injected query function, and the bounded retry).
 * No DataSource, no connection options: unit-testable without a database. The entrypoint that opens the connection
 * is database-boot-gates.ts (runDatabaseBootGates), which re-exports everything here. See that file for the gate list.
 */
import { assertDeploymentIdentity, DeploymentIdentityError, Query } from '../deployment-identity/deployment-identity';
import { SchemaCompatibilityError } from './schema-compatibility';

export type BootProcess = 'api' | 'worker' | 'cli' | 'provisioner';
export type BootRole = 'crewflow_app' | 'crewflow';

export const RUNTIME_ROLE: BootRole = 'crewflow_app';
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
}

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

export function expectedRolesFor(processName: BootProcess, cliCommand?: string): readonly BootRole[] {
  if (processName === 'provisioner') return [PROVISIONER_ROLE];
  if (processName !== 'cli') return [RUNTIME_ROLE];
  return (cliCommand && CLI_COMMAND_ROLES[cliCommand]) || [RUNTIME_ROLE];
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
  };
}

/** Gate 1. */
export function assertRoleGate(facts: BootGateFacts, expected: readonly BootRole[], label: string): void {
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
}

/** All gates over one connection. Pure apart from the injected query / pending-migration functions. */
export async function evaluateBootGates(input: EvaluateBootGatesInput): Promise<BootGateReport> {
  const { processName, env, query } = input;
  const production = isProductionProcess(processName, env);
  const label = processName === 'cli' ? `CLI command "${input.cliCommand ?? '(none)'}"` : `${processName} process`;

  const [factsRow] = await query(BOOT_FACTS_SQL);
  const facts = parseBootFacts(factsRow);
  assertRoleGate(facts, expectedRolesFor(processName, input.cliCommand), label);
  assertVersionGate(facts);
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

  return {
    processName,
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
