#!/usr/bin/env node
/**
 * T7 (Agent 5): prints the `export …` lines the Twenty Mode suites need for ONE harness database, preceded by GitHub
 * `::add-mask::` lines on stderr, for `eval` in the same shell step:
 *
 *   eval "$(node twenty-test-env.cjs <database> [--source fixture|bootstrap])"
 *
 * Emits:
 *   TEST_DATABASE_URL                  crewflow_owner — under Option A the API's runtime login IS the owner login
 *   TEST_DATABASE_TWENTY_OWNER_URL     the same URL, named, so a suite can refuse when it is anything else
 *   TEST_DATABASE_URL_UNPOOLED         the disposable cluster's superuser (fixtures only; never given to a child process)
 *   TEST_DATABASE_SEPARATED_APP_URL    crewflow_app, ONLY for --source fixture (a separated-built chain) — the negative controls
 *   TWENTY_MODE_TESTS=true, TWENTY_DB_SOURCE=<source>
 *
 * Reads MIGRATION_SECURITY_ADMIN_URL, CREWFLOW_OWNER_BOOTSTRAP_PASSWORD and (fixture only) CREWFLOW_APP_BOOTSTRAP_PASSWORD from
 * the environment only. Refuses a non-loopback host, a database name no harness creates, and a missing owner password.
 */
const args = process.argv.slice(2);
let source = 'fixture';
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--source') source = args[++i] ?? '';
  else if (args[i].startsWith('--')) {
    process.stderr.write('refusing: usage: twenty-test-env.cjs <database> [--source fixture|bootstrap]\n');
    process.exit(2);
  } else positional.push(args[i]);
}
if (!['fixture', 'bootstrap'].includes(source) || positional.length !== 1) {
  process.stderr.write('refusing: usage: twenty-test-env.cjs <database> [--source fixture|bootstrap]\n');
  process.exit(2);
}
const db = positional[0];
if (!/^(twa_tw_[a-z0-9_]+|[a-z0-9_]+_(fresh|upgrade)_[a-z0-9]+)$/.test(db)) {
  process.stderr.write('refusing: not a harness database name\n');
  process.exit(2);
}
let admin;
try {
  admin = new URL(process.env.MIGRATION_SECURITY_ADMIN_URL ?? '');
} catch {
  process.stderr.write('refusing: MIGRATION_SECURITY_ADMIN_URL is not a valid URL\n'); // never echo it: it holds a password
  process.exit(2);
}
if (!['127.0.0.1', 'localhost', '[::1]'].includes(admin.hostname)) {
  process.stderr.write('refusing: MIGRATION_SECURITY_ADMIN_URL is not a loopback disposable cluster\n');
  process.exit(2);
}
const ownerPassword = (process.env.CREWFLOW_OWNER_BOOTSTRAP_PASSWORD ?? '').trim();
if (!ownerPassword) {
  process.stderr.write('refusing: CREWFLOW_OWNER_BOOTSTRAP_PASSWORD is required\n');
  process.exit(2);
}
admin.pathname = `/${db}`;
admin.search = '';
const owner = new URL(admin.toString());
owner.username = 'crewflow_owner';
owner.password = encodeURIComponent(ownerPassword);
let app = null;
if (source === 'fixture' && process.env.CREWFLOW_APP_BOOTSTRAP_PASSWORD) {
  app = new URL(admin.toString());
  app.username = 'crewflow_app';
  app.password = encodeURIComponent(process.env.CREWFLOW_APP_BOOTSTRAP_PASSWORD);
}
const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
process.stderr.write(`::add-mask::${admin}\n::add-mask::${owner}\n${app ? `::add-mask::${app}\n` : ''}`);
process.stdout.write(
  `export TEST_DATABASE_URL_UNPOOLED=${q(admin)}\nexport TEST_DATABASE_URL=${q(owner)}\nexport TEST_DATABASE_TWENTY_OWNER_URL=${q(owner)}\n` +
    (app ? `export TEST_DATABASE_SEPARATED_APP_URL=${q(app)}\n` : '') +
    `export TWENTY_MODE_TESTS=true\nexport TWENTY_DB_SOURCE=${source}\n`,
);
