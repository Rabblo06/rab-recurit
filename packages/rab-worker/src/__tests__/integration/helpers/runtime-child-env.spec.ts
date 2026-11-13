import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';

import { RUNTIME_CHILD_STRIPPED_NAMES, runtimeChildBaseEnv } from './runtime-child-env';

/**
 * X3.5-S7 review A-2: a runtime child spawned by a spec (provisioner, Worker, API) never inherits the test cluster's
 * superuser URL (under either admin name, DATABASE_URL_UNPOOLED or an unlisted alias), the harness admin URL or a role
 * bootstrap password. The child reports its environment as JSON and nothing is printed.
 *
 * Every secret-like value is generated at run time (a tag plus a random UUID), so no credential-shaped literal is committed
 * (secret scanners), and each value stays unique and detectable if it leaks into the child.
 */
const sentinel = (tag: string): string => `x35-${tag}-${randomUUID()}`;
const ADMIN_PW = sentinel('admin');
const ADMIN = `postgres://x35_superuser:${ADMIN_PW}@127.0.0.1:1/x35_db`;
const DECODED_MIGRATION_PW = `${sentinel('mig')}@/!`;
const ENCODED_PW = encodeURIComponent(DECODED_MIGRATION_PW);
const MIGRATION_ADMIN = `postgres://x35_mig:${ENCODED_PW}@127.0.0.1:1/postgres`;
const APP = `postgres://x35_owner:${sentinel('app')}@127.0.0.1:1/x35_db`;
const CREWFLOW = `postgres://crewflow:${sentinel('crewflow')}@127.0.0.1:1/x35_db`;
const ROLE_PASSWORDS: Record<string, string> = {
  CREWFLOW_BOOTSTRAP_PASSWORD: sentinel('bootstrap'),
  CREWFLOW_APP_BOOTSTRAP_PASSWORD: sentinel('app-bootstrap'),
  CREWFLOW_WORKER_BOOTSTRAP_PASSWORD: sentinel('worker-bootstrap'),
  CREWFLOW_OWNER_BOOTSTRAP_PASSWORD: sentinel('owner-bootstrap'),
  CREWFLOW_MIGRATOR_PASSWORD: sentinel('migrator'),
};

const PARENT: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEST_DATABASE_URL: APP,
  TEST_DATABASE_ADMIN_URL: ADMIN,
  TEST_DATABASE_URL_UNPOOLED: ADMIN,
  TEST_DATABASE_CREWFLOW_URL: CREWFLOW,
  TEST_DATABASE_WORKER_URL: APP,
  DATABASE_URL: APP,
  DATABASE_URL_UNPOOLED: ADMIN,
  MIGRATION_SECURITY_ADMIN_URL: MIGRATION_ADMIN,
  ...ROLE_PASSWORDS,
  X35_ALIAS_OF_ADMIN: ADMIN.replace('postgres://', 'postgresql://'),
  X35_RAW_ADMIN_PW: ADMIN_PW,
  X35_DECODED_MIGRATION_PW: DECODED_MIGRATION_PW,
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

/** Names whose value holds any of `needles`. Names only, never values. */
const holding = (child: Record<string, string>, needles: string[]): string[] =>
  Object.keys(child).filter((name) => needles.some((needle) => child[name].includes(needle)));

describe('runtimeChildBaseEnv (X3.5-S7 review A-2)', () => {
  it('control: without the helper the child inherits the planted names and values (the probe can see a leak)', () => {
    const child = childEnv(PARENT);
    expect(child.TEST_DATABASE_ADMIN_URL).toBe(ADMIN);
    expect(child.TEST_DATABASE_URL_UNPOOLED).toBe(ADMIN);
    expect(holding(child, [ADMIN_PW]).length).toBeGreaterThan(0);
    expect(holding(child, Object.values(ROLE_PASSWORDS)).sort()).toEqual(Object.keys(ROLE_PASSWORDS).sort());
  });

  it('a spawned child gets neither admin name, nor DATABASE_URL_UNPOOLED, the harness admin URL, a bootstrap password or any value holding an admin password', () => {
    const child = childEnv(runtimeChildBaseEnv(PARENT));
    for (const name of [...RUNTIME_CHILD_STRIPPED_NAMES, 'TEST_DATABASE_URL', 'TEST_DATABASE_CREWFLOW_URL', 'TEST_DATABASE_WORKER_URL']) {
      expect([name, name in child]).toEqual([name, false]);
    }
    expect(holding(child, [ADMIN_PW, ENCODED_PW, DECODED_MIGRATION_PW, ...Object.values(ROLE_PASSWORDS)])).toEqual([]);
    expect(child.X35_UNRELATED).toBe('kept');
    expect(child.DATABASE_URL).toBe(APP);
  });

  it('a spec still re-adds a name deliberately AFTER the base (the provisioner child gets its own DATABASE_URL_UNPOOLED)', () => {
    const child = childEnv({ ...runtimeChildBaseEnv(PARENT), DATABASE_URL_UNPOOLED: CREWFLOW });
    expect(child.DATABASE_URL_UNPOOLED).toBe(CREWFLOW);
    expect(child.TEST_DATABASE_ADMIN_URL).toBeUndefined();
  });
});
