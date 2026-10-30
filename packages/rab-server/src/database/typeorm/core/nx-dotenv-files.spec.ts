import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import { assertOpsValuesNotFromDotenv } from '../../../command/ops/ops-run';
import { readDotenvValues, resolveDbTarget } from './database-target';
import * as nxDotenv from './nx-dotenv-files';
import { NX_PROJECT_TARGETS, nxDotenvFiles, nxDotenvFilesForTarget, nxDotenvPaths, readDotenvFilesValues, readNxDotenvValues, WORKSPACE_ROOT } from './nx-dotenv-files';
import { readRuntimeDotenvValues, resolveRuntimeDatabase } from './runtime-database-guard';

/**
 * Final review F6: Nx injects more dotenv files than packages/rab-server/.env (its .env.local, .env.<target>, the
 * repository root's .env, ...). The production-authority checks must read every one of them.
 */

// Nx's own path computation (node_modules/nx/dist/src/tasks-runner/task-env-paths.js), so an Nx upgrade that changes the
// list fails here rather than silently widening what Nx injects.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nxTaskEnvPaths = require('nx/src/tasks-runner/task-env-paths') as {
  getEnvPathsForTask: (projectRoot: string, target: string, configuration?: string, nonAtomizedTarget?: string) => string[];
};

const PROD_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const NEON_DIRECT = 'postgresql://crewflow_migrator:S3cret-PW@ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech/neondb?sslmode=verify-full';

describe('final review F6: the dotenv files Nx loads for the rab-server / rab-worker targets', () => {
  it('match Nx itself, file for file and in order, for every target of both projects', () => {
    for (const [projectRoot, targets] of Object.entries(NX_PROJECT_TARGETS)) {
      for (const target of targets) {
        expect(nxDotenvFilesForTarget(projectRoot, target)).toEqual(nxTaskEnvPaths.getEnvPathsForTask(projectRoot, target, undefined, undefined));
      }
    }
    // The ones F6 named, among others.
    const all = nxDotenvFiles();
    for (const file of [
      'packages/rab-server/.env',
      'packages/rab-server/.env.local',
      'packages/rab-server/.local.env',
      'packages/rab-server/.env.migration:run',
      'packages/rab-server/.env.deploy:prepare.local',
      'packages/rab-server/.command.env',
      'packages/rab-worker/.env.start',
      'packages/rab-worker/.env.provision.local',
      '.env',
      '.env.local',
      '.local.env',
      '.env.start',
    ]) {
      expect(all).toContain(file);
    }
  });

  it('cover every target of packages/rab-server and packages/rab-worker project.json, none of which has a configuration', () => {
    for (const [projectRoot, targets] of Object.entries(NX_PROJECT_TARGETS)) {
      const project = JSON.parse(readFileSync(join(WORKSPACE_ROOT, projectRoot, 'project.json'), 'utf8')) as {
        targets: Record<string, { configurations?: unknown; defaultConfiguration?: unknown }>;
      };
      expect([...targets].sort()).toEqual(Object.keys(project.targets).sort());
      // A configuration adds .env.<target>.<configuration> / .env.<configuration> files that this module does not list.
      for (const [name, target] of Object.entries(project.targets)) {
        expect({ name, configurations: target.configurations, defaultConfiguration: target.defaultConfiguration }).toEqual({
          name,
          configurations: undefined,
          defaultConfiguration: undefined,
        });
      }
    }
    expect(existsAt(WORKSPACE_ROOT, 'nx.json')).toBe(true);
  });

  it('the default readers of the production-authority checks read every Nx file (commands: database-target.ts; runtimes: runtime-database-guard.ts)', () => {
    const seen: string[][] = [];
    const spy = jest.spyOn(nxDotenv, 'readDotenvFilesValues').mockImplementation((files) => {
      seen.push([...files]);
      return {};
    });
    try {
      readDotenvValues();
      readRuntimeDotenvValues();
    } finally {
      spy.mockRestore();
    }
    const [commandFiles, runtimeFiles] = seen;
    for (const files of [commandFiles, runtimeFiles]) {
      for (const rel of ['packages/rab-server/.env', 'packages/rab-server/.env.local', 'packages/rab-server/.env.deploy:prepare', 'packages/rab-worker/.env.provision', '.env']) {
        expect(files).toContain(join(WORKSPACE_ROOT, rel));
      }
    }
    // The runtime still reads the working directory's .env (dotenv/config's default) first.
    expect(runtimeFiles[0]).toBe(join(process.cwd(), '.env'));
    // The repository root this module derives is the one Nx uses (it holds nx.json).
    expect(existsAt(WORKSPACE_ROOT, 'nx.json')).toBe(true);
  });

  describe('production authority in any of them is detected', () => {
    let root: string;
    const write = (rel: string, content: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    };
    // Only files under the temporary workspace exist for these reads (never the developer's real .env files).
    const onlyTmp = (file: string) => (resolve(file).startsWith(resolve(root)) && existsAt(file) ? readFileSync(file, 'utf8') : null);

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'crewflow-nx-dotenv-'));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it.each([
      ['packages/rab-server/.env.local', 'ALLOW_PRODUCTION_DB_COMMANDS=true\n'],
      ['packages/rab-server/.local.env', 'DB_TARGET=production\n'],
      ['packages/rab-server/.env.command', 'CREWFLOW_MIGRATION_APPROVED=pending-1-' + '0'.repeat(64) + '\n'],
      ['packages/rab-server/.command.local.env', 'CREWFLOW_DEPLOYMENT_ID=' + PROD_ID + '\n'],
      ['.env', 'CREWFLOW_DEPLOYMENT_ENVIRONMENT=production\n'],
      ['.env.local', 'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP=true\n'],
      ['.env.test', 'PG_EXPECTED_DATABASE_NAME=neondb\n'],
    ])('a production COMMAND refuses authority found in %s', (file, content) => {
      write(file, content);
      const dotenvValues = readNxDotenvValues([root], onlyTmp);
      expect(Object.keys(dotenvValues).length).toBeGreaterThan(0);
      expect(() =>
        resolveDbTarget({
          purpose: 'migrations',
          env: {
            NODE_ENV: 'production',
            DB_TARGET: 'production',
            ALLOW_PRODUCTION_DB_COMMANDS: 'true',
            PG_DATABASE_URL: NEON_DIRECT,
            CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production',
            CREWFLOW_DEPLOYMENT_ID: PROD_ID,
          },
          dotenvValues,
        }),
      ).toThrow(/production target values are present in packages\/rab-server\/\.env or another \.env file Nx loads/);
    });

    it('a production COMMAND whose PG_DATABASE_URL equals the value in packages/rab-server/.env.local is refused (value comparison)', () => {
      write('packages/rab-server/.env.local', `PG_DATABASE_URL=${NEON_DIRECT}\n`);
      const env = {
        NODE_ENV: 'production',
        DB_TARGET: 'production',
        ALLOW_PRODUCTION_DB_COMMANDS: 'true',
        PG_DATABASE_URL: NEON_DIRECT,
        CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production',
        CREWFLOW_DEPLOYMENT_ID: PROD_ID,
      };
      expect(() => resolveDbTarget({ purpose: 'migrations', env, dotenvValues: readNxDotenvValues([root], onlyTmp) })).toThrow(/\.env/);
    });

    it.each([
      ['packages/rab-worker/.env.provision', 'RAB_RUNTIME_ENV=production\n'],
      ['packages/rab-worker/.env.local', 'CREWFLOW_DEPLOYMENT_ENVIRONMENT=production\n'],
      ['packages/rab-server/.env.start.local', 'CREWFLOW_DEPLOYMENT_ID=' + PROD_ID + '\n'],
      ['.env.local', 'PG_EXPECTED_DATABASE_NAME=neondb\n'],
    ])('a production RUNTIME refuses authority found in %s', (file, content) => {
      write(file, content);
      const dotenvValues = readDotenvFilesValues(nxDotenvPaths([root]), onlyTmp);
      expect(() =>
        resolveRuntimeDatabase({
          processName: 'worker',
          env: {
            NODE_ENV: 'production',
            RAB_RUNTIME_ENV: 'production',
            PG_DATABASE_URL: NEON_DIRECT.replace('crewflow_migrator', 'crewflow_app'),
            CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production',
            CREWFLOW_DEPLOYMENT_ID: PROD_ID,
          },
          dotenvValues,
        }),
      ).toThrow(/production runtime values are present in a \.env file/);
    });

    it('the ops container refuses an ops value or PG_DATABASE_URL in any Nx dotenv file, not only <cwd>/.env', () => {
      write('packages/rab-server/.env.command.local', 'PG_OPS_APP_DATABASE_URL=postgres://a@b/c\n');
      expect(() => assertOpsValuesNotFromDotenv(root, onlyTmp)).toThrow(/PG_OPS_APP_DATABASE_URL.*present in a \.env file/);
      rmSync(join(root, 'packages'), { recursive: true, force: true });
      write('.local.env', 'PG_DATABASE_URL=postgres://a@b/c\n');
      expect(() => assertOpsValuesNotFromDotenv(root, onlyTmp)).toThrow(/PG_DATABASE_URL/);
      rmSync(join(root, '.local.env'));
      expect(() => assertOpsValuesNotFromDotenv(root, onlyTmp)).not.toThrow();
    });

    it('nothing in any file: nothing is reported; values merge first-file-wins in Nx order, and a key in ANY file is present', () => {
      expect(readNxDotenvValues([root], onlyTmp)).toEqual({});
      write('packages/rab-server/.env.local', 'A=project-local\n');
      write('packages/rab-server/.env', 'A=project\nB=project\n');
      write('.env', 'C=root\n');
      expect(readNxDotenvValues([root], onlyTmp)).toEqual({ A: 'project-local', B: 'project', C: 'root' });
    });
  });
});

function existsAt(...parts: string[]): boolean {
  try {
    readFileSync(join(...parts));
    return true;
  } catch {
    return false;
  }
}
