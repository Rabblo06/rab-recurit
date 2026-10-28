#!/usr/bin/env node
/**
 * M2 CI helper: prints `export TEST_DATABASE_URL=...` / `export TEST_DATABASE_URL_UNPOOLED=...` for one harness database, for
 * `eval` in the same shell step, preceded by GitHub `::add-mask::` lines so neither URL can reach the job log.
 *
 *   eval "$(node migration-security-test-env.cjs <database>)"
 *
 * Reads MIGRATION_SECURITY_ADMIN_URL and CREWFLOW_APP_BOOTSTRAP_PASSWORD from the environment only. Refuses a non-loopback
 * host and any database name the harness would not have created.
 */
const db = process.argv[2] ?? '';
if (!/^[a-z0-9_]+_(fresh|upgrade)_[a-z0-9]+$/.test(db)) {
  process.stderr.write('refusing: not a migration-security harness database name\n');
  process.exit(2);
}
let admin;
try {
  admin = new URL(process.env.MIGRATION_SECURITY_ADMIN_URL ?? '');
} catch {
  // Never let the parse error print its input: it would contain the password.
  process.stderr.write('refusing: MIGRATION_SECURITY_ADMIN_URL is not a valid URL\n');
  process.exit(2);
}
if (!['127.0.0.1', 'localhost', '[::1]'].includes(admin.hostname)) {
  process.stderr.write('refusing: MIGRATION_SECURITY_ADMIN_URL is not a loopback disposable cluster\n');
  process.exit(2);
}
admin.pathname = `/${db}`;
admin.search = '';
const app = new URL(admin.toString());
app.username = 'crewflow_app';
app.password = encodeURIComponent(process.env.CREWFLOW_APP_BOOTSTRAP_PASSWORD ?? '');
const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
// The crewflow login (worker provisioner tests), only when its bootstrap password is available.
let crewflow = null;
if (process.env.CREWFLOW_BOOTSTRAP_PASSWORD) {
  crewflow = new URL(admin.toString());
  crewflow.username = 'crewflow';
  crewflow.password = encodeURIComponent(process.env.CREWFLOW_BOOTSTRAP_PASSWORD);
}
// Workflow commands go to stderr: GitHub reads them from either stream, and stdout is only the eval'd exports.
process.stderr.write(`::add-mask::${admin}\n::add-mask::${app}\n${crewflow ? `::add-mask::${crewflow}\n` : ''}`);
process.stdout.write(
  `export TEST_DATABASE_URL_UNPOOLED=${q(admin)}\nexport TEST_DATABASE_URL=${q(app)}\n` +
    (crewflow ? `export TEST_DATABASE_CREWFLOW_URL=${q(crewflow)}\n` : ''),
);
