import * as fs from 'fs';
import * as path from 'path';

import { forbiddenRuntimeEnvNames, forbiddenRuntimeEnvPrefixes, NEVER_IN_RUNTIME_ENV, runtimeEnvRefusal } from './never-in-runtime-env';
import { resolveRuntimeDatabase, RuntimeDbError } from './runtime-database-guard';

/**
 * Security review L-4: one list (never-in-runtime-env.ts), two enforcers (O1: the Worker bundle launcher is retired). The
 * shell script keeps a literal copy; these tests fail when it drifts, and prove the in-process guard refuses every name.
 */
const DOCKER = path.resolve(__dirname, '../../../../../rab-docker/rab');
const PRESTART = path.join(DOCKER, 'api-prestart.sh');
const LOCAL = 'postgres://crewflow_app:S3cret-PW-do-not-print@127.0.0.1:55462/rab_test';

/** Every name in the `for name in ...; do` refusal loops of api-prestart.sh (continuation lines joined). */
function prestartNames(): string[] {
  const script = fs.readFileSync(PRESTART, 'utf8').replace(/\\\r?\n/g, ' ');
  const names: string[] = [];
  for (const match of script.matchAll(/^\s*for name in ([^;]+); do/gm)) names.push(...match[1]!.trim().split(/\s+/));
  return names;
}

/** Every prefix in the `for prefix in ...; do` loop of api-prestart.sh. */
function prestartPrefixes(): string[] {
  const script = fs.readFileSync(PRESTART, 'utf8');
  return [...script.matchAll(/^\s*for prefix in ([^;]+); do/gm)].flatMap((m) => m[1]!.trim().split(/\s+/));
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('never-in-runtime-env (security review L-4): one list, two enforcers', () => {
  it('the list holds every name the review requires, each once', () => {
    const names = NEVER_IN_RUNTIME_ENV.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of [
      'DATABASE_URL_UNPOOLED',
      'CREWFLOW_PROVISIONER_DATABASE_URL',
      'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL',
      'CREWFLOW_MIGRATION_DATABASE_URL',
      'CREWFLOW_MIGRATION_APPROVED',
      'CREWFLOW_MIGRATION_PHASE',
      'CREWFLOW_MIGRATOR_PASSWORD',
      'CREWFLOW_BOOTSTRAP_PASSWORD',
      'CREWFLOW_APP_BOOTSTRAP_PASSWORD',
      'ALLOW_PRODUCTION_DB_COMMANDS',
      'DB_TARGET',
      'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP',
      'CREWFLOW_OPS_RUN',
      'PG_OPS_APP_DATABASE_URL',
      'CREWFLOW_OPS_ACTOR_SOURCE',
      'CREWFLOW_OPS_ACTOR_ID',
      'CREWFLOW_OPS_CHANGE_REF',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('api-prestart.sh refuses exactly the API list (parity with the shared constant)', () => {
    const names = prestartNames();
    expect(new Set(names).size).toBe(names.length);
    expect(sorted(names)).toEqual(sorted(forbiddenRuntimeEnvNames('api')));
  });

  it('O1: the Worker bundle launcher is gone, so nothing may hold the provisioner credential any more (API and Worker refuse it by name)', () => {
    expect(fs.existsSync(path.join(DOCKER, 'worker-bundle/start-worker-bundle.cjs'))).toBe(false);
    for (const processName of ['api', 'worker'] as const) {
      expect(forbiddenRuntimeEnvNames(processName)).toContain('CREWFLOW_PROVISIONER_DATABASE_URL');
    }
    expect(prestartNames()).toContain('CREWFLOW_PROVISIONER_DATABASE_URL');
  });

  it.each(['api', 'worker', 'provisioner'] as const)('the in-process runtime guard refuses every listed name in the %s process (DB_TARGET: any value but a tolerated non-production local|test)', (processName) => {
    const forbidden = forbiddenRuntimeEnvNames(processName);
    for (const name of forbidden) {
      let message = '';
      try {
        resolveRuntimeDatabase({ processName, env: { NODE_ENV: 'development', PG_DATABASE_URL: LOCAL, [name]: 'S3cret-PW-do-not-print' }, dotenvValues: {} });
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeDbError);
        message = (error as Error).message;
      }
      expect(message).toMatch(new RegExp(`^${name} is present in the ${processName} process's environment\\. .*Refusing to start\\.$`));
      expect(message).not.toContain('S3cret-PW-do-not-print');
      // A blank value counts as absent.
      expect(resolveRuntimeDatabase({ processName, env: { NODE_ENV: 'development', PG_DATABASE_URL: LOCAL, [name]: ' ' }, dotenvValues: {} }).classification).toBe('LOCAL');
    }
    // Only the provisioner may hold the deprecated elevated name (non-production).
    expect(forbidden.includes('DATABASE_URL_UNPOOLED')).toBe(processName !== 'provisioner');
  });

  it('L-4 follow-up: the ONLY value-aware entry is DB_TARGET (local|test, outside production); ALLOW_PRODUCTION_DB_COMMANDS stays by name', () => {
    const valueAware = NEVER_IN_RUNTIME_ENV.filter((e) => e.toleratedOutsideProduction !== undefined);
    expect(valueAware.map((e) => [e.name, e.toleratedOutsideProduction])).toEqual([['DB_TARGET', ['local', 'test']]]);
    for (const processName of ['api', 'worker', 'provisioner'] as const) {
      expect(runtimeEnvRefusal({ NODE_ENV: 'development', DB_TARGET: 'local' }, processName)).toBeNull();
      expect(runtimeEnvRefusal({ DB_TARGET: 'test' }, processName)).toBeNull();
      expect(runtimeEnvRefusal({ NODE_ENV: 'development', DB_TARGET: 'production' }, processName)?.name).toBe('DB_TARGET');
      expect(runtimeEnvRefusal({ NODE_ENV: 'development', DB_TARGET: 'staging' }, processName)?.name).toBe('DB_TARGET');
      expect(runtimeEnvRefusal({ NODE_ENV: 'production', DB_TARGET: 'local' }, processName)?.name).toBe('DB_TARGET');
      expect(runtimeEnvRefusal({ RAB_RUNTIME_ENV: ' PRODUCTION ', DB_TARGET: 'test' }, processName)?.name).toBe('DB_TARGET');
      expect(runtimeEnvRefusal({ NODE_ENV: 'development', ALLOW_PRODUCTION_DB_COMMANDS: 'false' }, processName)?.name).toBe('ALLOW_PRODUCTION_DB_COMMANDS');
      expect(runtimeEnvRefusal({ NODE_ENV: 'development', DB_TARGET: ' ' }, processName)).toBeNull();
    }
  });

  it('owner-login architecture: one PG_DATABASE_URL — legacy / second URLs, role passwords and the removed mode switch are refused in the API and Worker', () => {
    const OWNER_LOGIN_NAMES = [
      'DATABASE_URL',
      'DATABASE_DIRECT_URL',
      'PG_DATABASE_REPLICA_URL',
      'PG_WORKER_DATABASE_URL',
      'CREWFLOW_WORKER_BOOTSTRAP_PASSWORD',
      'CREWFLOW_OWNER_PASSWORD',
      'CREWFLOW_OWNER_BOOTSTRAP_PASSWORD',
    ];
    for (const processName of ['api', 'worker'] as const) {
      for (const name of [...OWNER_LOGIN_NAMES, 'DATABASE_URL_UNPOOLED', 'CREWFLOW_PROVISIONER_DATABASE_URL', 'CREWFLOW_MIGRATION_DATABASE_URL', 'PG_OPS_APP_DATABASE_URL', 'CREWFLOW_BOOTSTRAP_PASSWORD', 'CREWFLOW_APP_BOOTSTRAP_PASSWORD', 'CREWFLOW_MIGRATOR_PASSWORD', 'ALLOW_PRODUCTION_DB_COMMANDS']) {
        expect(forbiddenRuntimeEnvNames(processName)).toContain(name);
        expect(runtimeEnvRefusal({ NODE_ENV: 'development', [name]: 'x' }, processName)?.name).toBe(name);
      }
    }
    // The superseded separate provisioner process (unused; removed in the final clean-up PR) is left exactly as it was.
    for (const name of OWNER_LOGIN_NAMES) expect(forbiddenRuntimeEnvNames('provisioner')).not.toContain(name);
    // Actionable messages: the legacy name says what to rename it to.
    expect(runtimeEnvRefusal({ DATABASE_URL: 'x' }, 'api')?.why).toMatch(/Rename it to PG_DATABASE_URL/);
  });

  it('DB-SETUP (plan §2.2): PG_DATABASE_PASSWORD (the bundled db admin password) is refused in the API and the Worker, by both enforcers, value never echoed', () => {
    for (const processName of ['api', 'worker'] as const) {
      expect(forbiddenRuntimeEnvNames(processName)).toContain('PG_DATABASE_PASSWORD');
      const refusal = runtimeEnvRefusal({ NODE_ENV: 'development', PG_DATABASE_PASSWORD: 'S3cret-PW-do-not-print' }, processName);
      expect(refusal?.name).toBe('PG_DATABASE_PASSWORD');
      expect(refusal?.why).toMatch(/only docker compose reads it/);
      expect(refusal?.why).not.toContain('S3cret-PW-do-not-print');
      // Production too, and a blank value (a compose `KEY=` line) counts as absent.
      expect(runtimeEnvRefusal({ NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production', PG_DATABASE_PASSWORD: 'x' }, processName)?.name).toBe('PG_DATABASE_PASSWORD');
      expect(runtimeEnvRefusal({ PG_DATABASE_PASSWORD: ' ' }, processName)).toBeNull();
    }
    // The image enforcer (api-prestart.sh) names it too (the parity test above checks the whole list).
    expect(prestartNames()).toContain('PG_DATABASE_PASSWORD');
    // The superseded provisioner process is left exactly as it was.
    expect(forbiddenRuntimeEnvNames('provisioner')).not.toContain('PG_DATABASE_PASSWORD');
  });

  it('owner-login architecture: CREWFLOW_PROVISIONER_* is refused on the API and the Worker by prefix (deterministic, blank = absent), and api-prestart.sh has the same prefixes', () => {
    expect(forbiddenRuntimeEnvPrefixes('api')).toEqual(['CREWFLOW_PROVISIONER_']);
    expect(sorted(prestartPrefixes())).toEqual(sorted(forbiddenRuntimeEnvPrefixes('api')));
    expect(runtimeEnvRefusal({ CREWFLOW_PROVISIONER_ENABLED: 'false', CREWFLOW_PROVISIONER_A: 'x' }, 'api')?.name).toBe('CREWFLOW_PROVISIONER_A');
    expect(runtimeEnvRefusal({ CREWFLOW_PROVISIONER_ENABLED: 'true' }, 'api')?.name).toBe('CREWFLOW_PROVISIONER_ENABLED');
    expect(runtimeEnvRefusal({ CREWFLOW_PROVISIONER_ENABLED: ' ' }, 'api')).toBeNull();
    // T4: the Worker provisions in-process, always, so it refuses every CREWFLOW_PROVISIONER_* name too; the superseded
    // provisioner child legitimately receives its switch.
    expect(forbiddenRuntimeEnvPrefixes('worker')).toEqual(['CREWFLOW_PROVISIONER_']);
    expect(runtimeEnvRefusal({ CREWFLOW_PROVISIONER_ENABLED: 'false' }, 'worker')?.name).toBe('CREWFLOW_PROVISIONER_ENABLED');
    expect(runtimeEnvRefusal({ CREWFLOW_PROVISIONER_ENABLED: 'true' }, 'provisioner')).toBeNull();
  });

  it('L-4 follow-up: the image enforcer stays strict BY NAME (DB_TARGET included); it never sees a developer .env', () => {
    expect(prestartNames()).toContain('DB_TARGET');
    // The dev compose blanks DB_TARGET on both image services, so the strict rule never refuses a legitimate start there.
    const compose = fs.readFileSync(path.join(DOCKER, '..', 'docker-compose.yml'), 'utf8');
    expect(compose.match(/^\s+DB_TARGET: ''$/gm)?.length).toBeGreaterThanOrEqual(2);
  });
});
