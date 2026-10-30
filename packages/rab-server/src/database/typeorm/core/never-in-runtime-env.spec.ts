import * as fs from 'fs';
import * as path from 'path';

import { forbiddenRuntimeEnvNames, forbiddenWorkerServiceEnvNames, NEVER_IN_RUNTIME_ENV, runtimeEnvRefusal } from './never-in-runtime-env';
import { resolveRuntimeDatabase, RuntimeDbError } from './runtime-database-guard';

/**
 * Security review L-4: one list (never-in-runtime-env.ts), three enforcers. The shell script and the standalone launcher keep
 * literal copies; these tests fail when either drifts, and prove the in-process guard refuses every name.
 */
const DOCKER = path.resolve(__dirname, '../../../../../rab-docker/rab');
const PRESTART = path.join(DOCKER, 'api-prestart.sh');
const LAUNCHER = path.join(DOCKER, 'worker-bundle/start-worker-bundle.cjs');
const LOCAL = 'postgres://crewflow_app:S3cret-PW-do-not-print@127.0.0.1:55462/rab_test';

/** Every name in the `for name in ...; do` refusal loops of api-prestart.sh (continuation lines joined). */
function prestartNames(): string[] {
  const script = fs.readFileSync(PRESTART, 'utf8').replace(/\\\r?\n/g, ' ');
  const names: string[] = [];
  for (const match of script.matchAll(/^\s*for name in ([^;]+); do/gm)) names.push(...match[1]!.trim().split(/\s+/));
  return names;
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('never-in-runtime-env (security review L-4): one list, three enforcers', () => {
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

  it('the Worker bundle launcher refuses exactly the Worker-service list (parity with the shared constant)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const launcher = require(LAUNCHER) as { FORBIDDEN_SERVICE_KEYS: readonly string[] };
    expect(sorted(launcher.FORBIDDEN_SERVICE_KEYS)).toEqual(sorted(forbiddenWorkerServiceEnvNames()));
    // The launcher legitimately holds the provisioner credential (it hands it to the provisioner child alone).
    expect(launcher.FORBIDDEN_SERVICE_KEYS).not.toContain('CREWFLOW_PROVISIONER_DATABASE_URL');
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

  it('L-4 follow-up: the image enforcers stay strict BY NAME (DB_TARGET included); they never see a developer .env', () => {
    expect(prestartNames()).toContain('DB_TARGET');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const launcher = require(LAUNCHER) as { FORBIDDEN_SERVICE_KEYS: readonly string[] };
    expect(launcher.FORBIDDEN_SERVICE_KEYS).toContain('DB_TARGET');
    // The dev compose blanks DB_TARGET on both image services, so the strict rule never refuses a legitimate start there.
    const compose = fs.readFileSync(path.join(DOCKER, '..', 'docker-compose.yml'), 'utf8');
    expect(compose.match(/^\s+DB_TARGET: ''$/gm)?.length).toBeGreaterThanOrEqual(2);
  });
});
