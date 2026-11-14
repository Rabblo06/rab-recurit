import { forbiddenRuntimeEnvNames, RuntimeProcessName } from '@rab/server/database/typeorm/core/never-in-runtime-env';
import { TEST_DATABASE_ADMIN_URL_NAMES } from '@rab/server/database/typeorm/core/test-database-guard';

/**
 * Test-harness credentials a spawned runtime child never inherits, on top of never-in-runtime-env.ts (which deliberately
 * lets the provisioner keep some of them, e.g. DATABASE_URL_UNPOOLED and the owner-login role passwords). X3.5-S7 review
 * A-2: Jest's setupFiles writes the test cluster's SUPERUSER URL under both admin names and under DATABASE_URL_UNPOOLED, and
 * CI exports the harness admin URL and every role bootstrap password job-wide.
 */
export const RUNTIME_CHILD_STRIPPED_NAMES: readonly string[] = [
  ...TEST_DATABASE_ADMIN_URL_NAMES,
  'DATABASE_URL_UNPOOLED',
  'MIGRATION_SECURITY_ADMIN_URL',
  'CREWFLOW_BOOTSTRAP_PASSWORD',
  'CREWFLOW_APP_BOOTSTRAP_PASSWORD',
  'CREWFLOW_WORKER_BOOTSTRAP_PASSWORD',
  'CREWFLOW_OWNER_BOOTSTRAP_PASSWORD',
  'CREWFLOW_OWNER_PASSWORD',
  'CREWFLOW_MIGRATOR_PASSWORD',
];
/** Every other TEST_DATABASE_* login URL (application, crewflow, worker, Twenty owner, ...): a child gets its URL explicitly. */
const TEST_DATABASE_NAME = /^TEST_DATABASE_/;
/** Passwords shorter than this are matched only as whole values (a short substring would strip unrelated values). */
const MIN_PASSWORD_MATCH = 8;

function adminPasswords(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const name of [...TEST_DATABASE_ADMIN_URL_NAMES, 'MIGRATION_SECURITY_ADMIN_URL', 'DATABASE_URL_UNPOOLED']) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    try {
      const password = new URL(raw).password;
      for (const p of [password, decodeURIComponent(password)]) if (p.length >= MIN_PASSWORD_MATCH) out.push(p);
    } catch {
      // Not a URL: matched by name (above) only.
    }
  }
  return out;
}

/**
 * The parent (Jest) environment minus every name a runtime process refuses to start with (security review L-4,
 * never-in-runtime-env.ts), minus RUNTIME_CHILD_STRIPPED_NAMES and every TEST_DATABASE_* name, and minus any other variable
 * whose value holds an admin URL's password (raw or percent-decoded, 8+ characters). CI exports DB_TARGET and the role
 * bootstrap passwords job-wide for the harness and the fixtures; a spawned API / Worker / provisioner must not inherit
 * them, exactly as a deployment never forwards them. A test that sets one of these names on purpose (the provisioner's
 * DATABASE_URL_UNPOOLED, or a name the spec proves is refused) spreads it AFTER this base.
 */
export function runtimeChildBaseEnv(
  env: NodeJS.ProcessEnv = process.env,
  processName: RuntimeProcessName = 'provisioner',
): Record<string, string | undefined> {
  const passwords = adminPasswords(env);
  const base: Record<string, string | undefined> = { ...env };
  for (const name of forbiddenRuntimeEnvNames(processName)) delete base[name];
  for (const name of RUNTIME_CHILD_STRIPPED_NAMES) delete base[name];
  for (const [name, value] of Object.entries(base)) {
    if (TEST_DATABASE_NAME.test(name)) delete base[name];
    else if (value && passwords.some((p) => value.includes(p))) delete base[name];
  }
  return base;
}
