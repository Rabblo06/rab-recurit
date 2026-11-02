import { isRemoteDatabaseHost, Query, readDeploymentMarker } from '../database/deployment-identity/deployment-identity';
import { readPrimaryDatabaseUrl } from '../database/postgres/pg-config';
import { describeDatabaseUrl, TestDatabaseConfigError } from '../database/typeorm/core/test-database-guard';

/**
 * X1.5 (cleanup audit NC-04): the fixture seeds `seed` (acme / admin@acme.test) and `seed-qa` ("ADOLPHUS QA") ship in the
 * production image's CLI. Before this, the only thing between them and a production database was the generic command gate
 * (DB_TARGET=production + ALLOW_PRODUCTION_DB_COMMANDS + the deployment identity): an operator holding production command
 * authority for bootstrap-admin could also create a demo organisation and accounts in production. Modelled on
 * seed-ai-demo.command.ts's in-command refusal, but wider: the fixtures are used locally, by CI-style harnesses on a
 * disposable `test` database and by the Worker-bundle image test (`run-integration.cjs` runs `seed-qa` in the BUILT image
 * against its own throwaway compose `pg`, DB_TARGET=local, NODE_ENV/RAB_RUNTIME_ENV=development), so:
 *
 *   - DB_TARGET must be `local` or `test` (staging and production refused, as is anything else);
 *   - no production authority: ALLOW_PRODUCTION_DB_COMMANDS and CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP must be absent;
 *   - no production or staging declaration: NODE_ENV, RAB_RUNTIME_ENV and CREWFLOW_DEPLOYMENT_ENVIRONMENT must not say
 *     production or staging;
 *   - the primary database URL must be a loopback host or a listed compose database service (the one shared host rule,
 *     deployment-identity.ts isRemoteDatabaseHost) — the same rule the command target guard applies to local / test;
 *   - live, read-only, before any write: the database must not be bound (core.deployment_identity_check) to production or
 *     staging.
 * Refusals never contain a URL, credential or unrecognised value. Pure except `assertSeedDatabaseNotDeployed`.
 */
export type SeedCommandName = 'seed' | 'seed-qa';

export const SEED_ALLOWED_DB_TARGETS: readonly string[] = ['local', 'test'];
const DEPLOYED_ENVIRONMENTS = ['production', 'staging'];
const KNOWN_VALUES = ['local', 'test', 'staging', 'production', 'development', 'ci'];

export class SeedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedTargetError';
  }
}

const shown = (value: string | undefined): string => {
  const v = value?.trim();
  if (v === undefined || v === '') return 'unset';
  return KNOWN_VALUES.includes(v.toLowerCase()) ? v : 'an unrecognised value';
};

export function seedCommandTargetProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const target = env.DB_TARGET?.trim() ?? '';
  if (!SEED_ALLOWED_DB_TARGETS.includes(target)) {
    problems.push(`DB_TARGET must be local or test (got ${shown(env.DB_TARGET)}); staging and production databases are refused.`);
  }
  for (const name of ['ALLOW_PRODUCTION_DB_COMMANDS', 'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP']) {
    if ((env[name]?.trim() ?? '') !== '') problems.push(`${name} is production command authority; a fixture seed never runs with it. Remove it.`);
  }
  for (const name of ['NODE_ENV', 'RAB_RUNTIME_ENV', 'CREWFLOW_DEPLOYMENT_ENVIRONMENT']) {
    const value = env[name]?.trim().toLowerCase() ?? '';
    if (DEPLOYED_ENVIRONMENTS.includes(value)) problems.push(`${name}=${value} declares a deployed environment; fixture seeds run only locally or on a disposable test database.`);
  }
  const primary = readPrimaryDatabaseUrl(env);
  if (!primary) {
    problems.push('PG_DATABASE_URL is required (or, outside production, the deprecated DATABASE_URL).');
  } else {
    try {
      const id = describeDatabaseUrl(primary.value, primary.name);
      if (isRemoteDatabaseHost(id.host)) problems.push(`${primary.name} must be a loopback or docker-service database (got host "${id.host}").`);
    } catch (error) {
      // describeDatabaseUrl's refusals are value-free by construction (variable name and the offending query-parameter
      // NAME only), so the precise reason is kept, e.g. a `?host=` / `?hostaddr=` target override (X1.9 review).
      problems.push(error instanceof TestDatabaseConfigError ? error.message : `${primary.name} is not a parseable postgres URL (value not shown).`);
    }
  }
  return problems;
}

/** The environment part of the refusal. Throws SeedTargetError naming every problem. */
export function assertSeedCommandTarget(command: SeedCommandName, env: Record<string, string | undefined>): void {
  const problems = seedCommandTargetProblems(env);
  if (problems.length > 0) {
    throw new SeedTargetError(`${command} refused (fixture seed, local and disposable test databases only):\n  - ${problems.join('\n  - ')}`);
  }
}

/** The live part: read-only, before any write. A database bound to production or staging is refused. */
export async function assertSeedDatabaseNotDeployed(command: SeedCommandName, query: Query): Promise<void> {
  const { marker } = await readDeploymentMarker(query);
  if (marker.state === 'bound' && DEPLOYED_ENVIRONMENTS.includes(marker.environment)) {
    throw new SeedTargetError(`${command} refused: the database is bound to ${marker.environment}. Fixture seeds never write to a deployed database.`);
  }
}
