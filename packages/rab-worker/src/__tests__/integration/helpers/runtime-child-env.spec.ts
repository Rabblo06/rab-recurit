import { spawnSync } from 'child_process';

import { RUNTIME_CHILD_STRIPPED_NAMES, runtimeChildBaseEnv } from './runtime-child-env';

/**
 * X3.5-S7 review A-2: a runtime child spawned by a spec (provisioner, Worker, API) never inherits the test cluster's
 * superuser URL (under either admin name, DATABASE_URL_UNPOOLED or an unlisted alias), the harness admin URL or a role
 * bootstrap password. Synthetic values only; the child reports its environment as JSON and nothing is printed.
 */
const ADMIN_PW = 'x35-sentinel-admin-pw';
const ADMIN = `postgres://x35_superuser:${ADMIN_PW}@127.0.0.1:1/x35_db`;
const ENCODED_PW = 'x35%40sentinel%2Fmig';
const MIGRATION_ADMIN = `postgres://x35_mig:${ENCODED_PW}@127.0.0.1:1/postgres`;
const APP = 'postgres://x35_owner:x35-app-pw-other@127.0.0.1:1/x35_db';

const PARENT: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEST_DATABASE_URL: APP,
  TEST_DATABASE_ADMIN_URL: ADMIN,
  TEST_DATABASE_URL_UNPOOLED: ADMIN,
  TEST_DATABASE_CREWFLOW_URL: 'postgres://crewflow:x35-crewflow-pw@127.0.0.1:1/x35_db',
  TEST_DATABASE_WORKER_URL: APP,
  DATABASE_URL: APP,
  DATABASE_URL_UNPOOLED: ADMIN,
  MIGRATION_SECURITY_ADMIN_URL: MIGRATION_ADMIN,
  CREWFLOW_BOOTSTRAP_PASSWORD: 'x35-bootstrap-pw',
  CREWFLOW_APP_BOOTSTRAP_PASSWORD: 'x35-app-bootstrap-pw',
  CREWFLOW_WORKER_BOOTSTRAP_PASSWORD: 'x35-worker-bootstrap-pw',
  CREWFLOW_OWNER_BOOTSTRAP_PASSWORD: 'x35-owner-bootstrap-pw',
  CREWFLOW_MIGRATOR_PASSWORD: 'x35-migrator-pw',
  X35_ALIAS_OF_ADMIN: ADMIN.replace('postgres://', 'postgresql://'),
  X35_RAW_ADMIN_PW: ADMIN_PW,
  X35_DECODED_MIGRATION_PW: decodeURIComponent(ENCODED_PW),
  X35_UNRELATED: 'kept',
};

function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Record<string, string>;
}

describe('runtimeChildBaseEnv (X3.5-S7 review A-2)', () => {
  it('control: without the helper the child inherits the planted names', () => {
    const child = childEnv(PARENT);
    expect(child.TEST_DATABASE_ADMIN_URL).toBe(ADMIN);
    expect(child.TEST_DATABASE_URL_UNPOOLED).toBe(ADMIN);
  });

  it('a spawned child gets neither admin name, nor DATABASE_URL_UNPOOLED, the harness admin URL, a bootstrap password or any value holding an admin password', () => {
    const child = childEnv(runtimeChildBaseEnv(PARENT));
    for (const name of [...RUNTIME_CHILD_STRIPPED_NAMES, 'TEST_DATABASE_URL', 'TEST_DATABASE_CREWFLOW_URL', 'TEST_DATABASE_WORKER_URL']) {
      expect([name, name in child]).toEqual([name, false]);
    }
    const holding = Object.keys(child).filter((name) => [ADMIN_PW, ENCODED_PW, decodeURIComponent(ENCODED_PW)].some((p) => child[name].includes(p)));
    expect(holding).toEqual([]);
    expect(child.X35_UNRELATED).toBe('kept');
    expect(child.DATABASE_URL).toBe(APP);
  });

  it('a spec still re-adds a name deliberately AFTER the base (the provisioner child gets its own DATABASE_URL_UNPOOLED)', () => {
    const crewflow = 'postgres://crewflow:x35-crewflow-pw@127.0.0.1:1/x35_db';
    const child = childEnv({ ...runtimeChildBaseEnv(PARENT), DATABASE_URL_UNPOOLED: crewflow });
    expect(child.DATABASE_URL_UNPOOLED).toBe(crewflow);
    expect(child.TEST_DATABASE_ADMIN_URL).toBeUndefined();
  });
});
