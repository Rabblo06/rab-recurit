/**
 * Security review L-4: the ONE list of environment variables that must never be present (non-empty) in a long-running
 * runtime process — the API, the ordinary Worker jobs process and the workspace provisioner child. Each is migration,
 * bootstrap, command or operations authority that belongs to a short-lived step (rab-migrate / deploy-prepare, the
 * one-off ops container, a CLI command) or to the Worker bundle launcher alone. A credential sitting unused in a
 * long-lived process's environment is still readable (/proc/<pid>/environ, crash dumps, error reporters), which Phase B P7
 * says must never happen.
 *
 * Who enforces it:
 *   - runtime-database-guard.ts resolveRuntimeDatabase: every name in `forbiddenRuntimeEnvNames(process)`, in-process, so
 *     the refusal holds even when a platform starts `node .../main.js` directly and skips api-prestart.sh;
 *   - packages/rab-docker/rab/api-prestart.sh: its two refusal loops must name exactly `forbiddenRuntimeEnvNames('api')`;
 *   - packages/rab-docker/rab/worker-bundle/start-worker-bundle.cjs FORBIDDEN_SERVICE_KEYS (the Worker service, i.e. the
 *     root launcher) must name exactly `forbiddenWorkerServiceEnvNames()`.
 * The shell script and the launcher are not TypeScript (the launcher ships standalone in the Worker image), so they keep
 * literal copies; never-in-runtime-env.spec.ts fails the build when either copy drifts from this list.
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
 * The two IMAGE enforcers (api-prestart.sh and the Worker bundle launcher) stay strict by name for every entry, DB_TARGET
 * included: they only ever run inside the container images, whose compose files never inject a developer .env into them
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
  /** True when the Worker bundle launcher (the Worker SERVICE environment) legitimately holds it. */
  launcherHolds?: boolean;
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
const OPS_ONLY = 'It belongs to the one-off operations container only (`docker compose --profile ops run --rm rab-ops ...`).';

export const NEVER_IN_RUNTIME_ENV: readonly NeverInRuntimeEnvEntry[] = Object.freeze([
  // The historical privileged name: the provisioner's deprecated non-production DDL connection only (the factory refuses it
  // everywhere in production).
  { name: 'DATABASE_URL_UNPOOLED', why: 'Remove it: only the provisioner process may hold it (deprecated, non-production only).', allowedIn: ['provisioner'] },
  // Only the Worker bundle launcher holds it; it hands the provisioner child the credential as PG_DATABASE_URL.
  {
    name: 'CREWFLOW_PROVISIONER_DATABASE_URL',
    why: 'Only the Worker bundle launcher may hold it. Remove it from this process\'s environment.',
    launcherHolds: true,
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
  { name: 'CREWFLOW_OPS_RUN', why: OPS_ONLY },
  { name: 'PG_OPS_APP_DATABASE_URL', why: OPS_ONLY },
  { name: 'CREWFLOW_OPS_ACTOR_SOURCE', why: OPS_ONLY },
  { name: 'CREWFLOW_OPS_ACTOR_ID', why: OPS_ONLY },
  { name: 'CREWFLOW_OPS_CHANGE_REF', why: OPS_ONLY },
]);

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
  return null;
}

/** Names the Worker SERVICE (the bundle launcher's own environment) must not carry. */
export function forbiddenWorkerServiceEnvNames(): string[] {
  return NEVER_IN_RUNTIME_ENV.filter((e) => !e.launcherHolds).map((e) => e.name);
}
