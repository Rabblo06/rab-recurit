/**
 * Security review L-4: the ONE list of environment variables that must never be present (non-empty) in a long-running
 * runtime process — the API, the ordinary Worker jobs process and the workspace provisioner child. Each is migration,
 * bootstrap or command authority that belongs to a short-lived step (rab-migrate / deploy-prepare, a CLI command), or a
 * retired separated-mode name (the removed rab-ops container) that is never valid. A credential sitting unused in a
 * long-lived process's environment is still readable (/proc/<pid>/environ, crash dumps, error reporters), which Phase B P7
 * says must never happen.
 *
 * Who enforces it:
 *   - runtime-database-guard.ts resolveRuntimeDatabase: every name in `forbiddenRuntimeEnvNames(process)`, in-process, so
 *     the refusal holds even when a platform starts `node .../main.js` directly and skips api-prestart.sh;
 *   - packages/rab-docker/rab/api-prestart.sh: its two refusal loops must name exactly `forbiddenRuntimeEnvNames('api')`.
 * The shell script is not TypeScript, so it keeps a literal copy; never-in-runtime-env.spec.ts fails the build when that
 * copy drifts from this list. (O1, one image: the Worker bundle launcher and its FORBIDDEN_SERVICE_KEYS copy are retired;
 * the Worker runs main.js directly and is covered by the in-process guard above.)
 *
 * Values are never read, with ONE value-aware exception (L-4 follow-up, coordinator decision 2026-10-30): DB_TARGET.
 * Local `yarn start` runs the API under Nx, which injects packages/rab-server/.env (where .env.example ships
 * `DB_TARGET=local`, which the CLI and migrations need), and the local provisioner loads packages/rab-worker/.env.provisioner,
 * which carries it too. So the IN-PROCESS guard (runtimeEnvRefusal) tolerates DB_TARGET=local or DB_TARGET=test in a
 * NON-production runtime only — ignored, never read for target selection (deployment-identity.ts honours DB_TARGET for
 * commands only). Any other DB_TARGET value (production, staging, a typo), and ANY DB_TARGET in a production runtime
 * (NODE_ENV=production or RAB_RUNTIME_ENV=production), is still refused. ALLOW_PRODUCTION_DB_COMMANDS stays refused by
 * name everywhere.
 *
 * The IMAGE enforcer (api-prestart.sh) stays strict by name for every entry, DB_TARGET
 * included: it only ever runs inside the container image, whose compose files never inject a developer .env into it
 * (docker-compose.yml blanks DB_TARGET on the api and worker services; production and QA set no DB_TARGET on them), so
 * nothing legitimate is refused there and the stricter rule costs nothing. The drift test compares NAMES, which is
 * unchanged.
 */
export type RuntimeProcessName = 'api' | 'worker' | 'provisioner';

export interface NeverInRuntimeEnvEntry {
  name: string;
  /** Why it must not be there; ends the refusal message. */
  why: string;
  /** Runtime processes that MAY hold it (default: none). */
  allowedIn?: readonly RuntimeProcessName[];
  /**
   * Values (trimmed, exact) the IN-PROCESS runtime guard tolerates in a NON-production runtime only; ignored, never read.
   * Any other value, and any value at all in a production runtime, is refused. The image enforcers ignore this (strict by
   * name). Only DB_TARGET has one.
   */
  toleratedOutsideProduction?: readonly string[];
}

const MIGRATION_ONLY = 'Migration authority is consumed only by the short-lived migration step and never reaches a long-running process.';
const BOOTSTRAP_ONLY = 'Role bootstrap passwords belong to the migration / setup step only and never reach a long-running process.';
const COMMAND_ONLY = 'It is command authority (migrations and CLI commands only); a running server is not a command.';
const RETIRED_OPS =
  'It is a retired separated-mode operations variable (the removed rab-ops container) and is never valid. The ops commands run as one-off CLI commands under the owner login. Remove it.';
const ONE_URL =
  'The API, the Worker and the migrate child use ONE database URL, PG_DATABASE_URL (the crewflow_owner login). Remove this second database URL.';
const ROLE_PASSWORD = 'Role passwords never belong in application configuration: the runtime connects only as the PG_DATABASE_URL owner login. Remove it.';
/** Names added by the owner-login architecture: enforced by api-prestart.sh and the in-process guards. */
const OWNER_LOGIN = { allowedIn: ['provisioner'] as const };

export const NEVER_IN_RUNTIME_ENV: readonly NeverInRuntimeEnvEntry[] = Object.freeze([
  // The historical privileged name: the provisioner's deprecated non-production DDL connection only (the factory refuses it
  // everywhere in production).
  { name: 'DATABASE_URL_UNPOOLED', why: 'Remove it: only the provisioner process may hold it (deprecated, non-production only).', allowedIn: ['provisioner'] },
  // The retired separated-mode provisioner credential (O1: no launcher holds it any more; provisioning runs in-process).
  {
    name: 'CREWFLOW_PROVISIONER_DATABASE_URL',
    why: 'Workspace provisioning runs inside the Worker on the one owner login; there is no provisioner credential. Remove it.',
  },
  { name: 'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL', why: MIGRATION_ONLY },
  { name: 'CREWFLOW_MIGRATION_DATABASE_URL', why: MIGRATION_ONLY },
  { name: 'CREWFLOW_MIGRATION_APPROVED', why: MIGRATION_ONLY },
  { name: 'CREWFLOW_MIGRATION_PHASE', why: MIGRATION_ONLY },
  { name: 'CREWFLOW_MIGRATOR_PASSWORD', why: MIGRATION_ONLY },
  { name: 'CREWFLOW_BOOTSTRAP_PASSWORD', why: BOOTSTRAP_ONLY },
  { name: 'CREWFLOW_APP_BOOTSTRAP_PASSWORD', why: BOOTSTRAP_ONLY },
  { name: 'ALLOW_PRODUCTION_DB_COMMANDS', why: COMMAND_ONLY },
  // Value-aware (see the header): local / test tolerated, ignored, in a non-production runtime (a developer .env injected
  // by Nx); production, staging, anything else, or any value in a production runtime is refused.
  { name: 'DB_TARGET', why: COMMAND_ONLY, toleratedOutsideProduction: ['local', 'test'] },
  {
    name: 'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP',
    why: 'It is honoured only by production database commands. Remove it.',
  },
  { name: 'CREWFLOW_OPS_RUN', why: RETIRED_OPS },
  { name: 'PG_OPS_APP_DATABASE_URL', why: RETIRED_OPS },
  { name: 'CREWFLOW_OPS_ACTOR_SOURCE', why: RETIRED_OPS },
  { name: 'CREWFLOW_OPS_ACTOR_ID', why: RETIRED_OPS },
  { name: 'CREWFLOW_OPS_CHANGE_REF', why: RETIRED_OPS },
  // Owner-login architecture (PERMANENT-OWNER-LOGIN-ADDENDUM): one PG_DATABASE_URL. Legacy and second database URLs and role
  // passwords are refused in the API and Worker. (The removed CREWFLOW_DB_MODE is refused by runtime-db-config.ts, which the
  // runtime guard also runs, with its own actionable message.) `allowedIn: ['provisioner']` leaves the
  // superseded separate provisioner process exactly as it was until the final clean-up PR removes it (it is unused).
  { name: 'DATABASE_URL', why: `It is the retired name of PG_DATABASE_URL. Rename it to PG_DATABASE_URL (the one owner-login URL).`, ...OWNER_LOGIN },
  { name: 'DATABASE_DIRECT_URL', why: ONE_URL, ...OWNER_LOGIN },
  { name: 'PG_DATABASE_REPLICA_URL', why: ONE_URL, ...OWNER_LOGIN },
  { name: 'PG_WORKER_DATABASE_URL', why: ONE_URL, ...OWNER_LOGIN },
  { name: 'CREWFLOW_WORKER_BOOTSTRAP_PASSWORD', why: ROLE_PASSWORD, ...OWNER_LOGIN },
  { name: 'CREWFLOW_OWNER_PASSWORD', why: ROLE_PASSWORD, ...OWNER_LOGIN },
  // The provider step's / test harness's name for the owner password (twenty-test-env.cjs): never in a runtime process.
  { name: 'CREWFLOW_OWNER_BOOTSTRAP_PASSWORD', why: ROLE_PASSWORD, ...OWNER_LOGIN },
  // DB-SETUP (plan §2.2, "database setup like Twenty"): the bundled database's admin password. Only docker compose reads it,
  // to build the bundled admin URL (and the `db` service's POSTGRES_PASSWORD); api-prestart.sh and worker-start.sh unset it
  // before any runtime process starts. Refused in the API and the Worker (the provisioner is left as it was).
  {
    name: 'PG_DATABASE_PASSWORD',
    why: 'It is the bundled database admin password: only docker compose reads it, to build the admin URL; api-prestart.sh / worker-start.sh unset it, and a runtime process connects only as crewflow_owner. Remove it.',
    ...OWNER_LOGIN,
  },
]);

/**
 * Owner-login architecture: whole NAME PREFIXES the API refuses (any variable whose name starts with one). The separate
 * workspace provisioner's settings (CREWFLOW_PROVISIONER_*) never belong on the API or the Worker (which provisions
 * in-process, always — T4). The superseded provisioner child legitimately receives CREWFLOW_PROVISIONER_ENABLED. The jobs-only
 * health check sets CREWFLOW_PROVISIONER_ENABLED=false on its own check command, never in the Worker's environment.
 */
export interface NeverInRuntimeEnvPrefix {
  prefix: string;
  why: string;
  processes: readonly RuntimeProcessName[];
}

export const NEVER_IN_RUNTIME_ENV_PREFIXES: readonly NeverInRuntimeEnvPrefix[] = Object.freeze([
  {
    prefix: 'CREWFLOW_PROVISIONER_',
    why: 'Workspace provisioning runs inside the Worker on the one owner login; there is no separate provisioner credential or switch. Remove it.',
    processes: ['api', 'worker'] as const,
  },
]);

/** Prefixes the given runtime process refuses (api-prestart.sh keeps a literal copy for the API; parity-tested). */
export function forbiddenRuntimeEnvPrefixes(processName: RuntimeProcessName): string[] {
  return NEVER_IN_RUNTIME_ENV_PREFIXES.filter((p) => p.processes.includes(processName)).map((p) => p.prefix);
}

/**
 * Names the given runtime process refuses by name in the IMAGE enforcers (api-prestart.sh). The in-process guard refuses
 * the same names, except a tolerated value of an entry with `toleratedOutsideProduction` (runtimeEnvRefusal).
 */
export function forbiddenRuntimeEnvNames(processName: RuntimeProcessName): string[] {
  return NEVER_IN_RUNTIME_ENV.filter((e) => !(e.allowedIn ?? []).includes(processName)).map((e) => e.name);
}

/**
 * A production runtime for this list's purpose: NODE_ENV or RAB_RUNTIME_ENV says production. Deliberately broader than the
 * runtime guard's own classification (trimmed, case-insensitive, EITHER variable): a half-declared or mis-cased production
 * is treated as production here, so it never gains the non-production tolerance (fail closed).
 */
function looksLikeProductionRuntime(env: Record<string, string | undefined>): boolean {
  return ['NODE_ENV', 'RAB_RUNTIME_ENV'].some((name) => env[name]?.trim().toLowerCase() === 'production');
}

/**
 * The in-process rule (runtime-database-guard.ts resolveRuntimeDatabase): the first entry this process's environment
 * violates, or null. A blank value counts as absent. A tolerated value is compared, never used, logged or returned.
 */
export function runtimeEnvRefusal(env: Record<string, string | undefined>, processName: RuntimeProcessName): NeverInRuntimeEnvEntry | null {
  const production = looksLikeProductionRuntime(env);
  for (const entry of NEVER_IN_RUNTIME_ENV) {
    if ((entry.allowedIn ?? []).includes(processName)) continue;
    const value = env[entry.name]?.trim() ?? '';
    if (value === '') continue;
    if (!production && (entry.toleratedOutsideProduction ?? []).includes(value)) continue;
    return entry;
  }
  // Prefix rules (owner-login architecture), names sorted so the refusal is deterministic. Blank counts as absent.
  for (const rule of NEVER_IN_RUNTIME_ENV_PREFIXES) {
    if (!rule.processes.includes(processName)) continue;
    const name = Object.keys(env)
      .filter((key) => key.startsWith(rule.prefix) && (env[key]?.trim() ?? '') !== '')
      .sort()[0];
    if (name !== undefined) return { name, why: rule.why };
  }
  return null;
}

