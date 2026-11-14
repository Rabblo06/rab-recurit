#!/usr/bin/env node
/**
 * M2 CI helper: prints `export TEST_DATABASE_URL=...` / `export TEST_DATABASE_ADMIN_URL=...` (X3.5-S7 release 1: also the
 * deprecated `TEST_DATABASE_URL_UNPOOLED`, same value) for one harness database, for
 * `eval` in the same shell step, preceded by GitHub `::add-mask::` lines so neither URL can reach the job log.
 *
 *   eval "$(node migration-security-test-env.cjs <database>)"
 *   eval "$(node migration-security-test-env.cjs <database> --with-worker-login)"   # E5: the gated Phase D job only
 *
 * Reads MIGRATION_SECURITY_ADMIN_URL and CREWFLOW_APP_BOOTSTRAP_PASSWORD from the environment only. Refuses a non-loopback
 * host and any database name the harness would not have created.
 *
 * --with-worker-login (E5) also emits TEST_DATABASE_WORKER_URL: the crewflow_worker login on the SAME database, built from
 * CREWFLOW_WORKER_BOOTSTRAP_PASSWORD (the password the harness gave the role it created). It is opt-in on purpose: without
 * the flag the output is exactly what it was before E5, so every existing job keeps running the same suites. With the flag
 * and no worker password it refuses (exit 2) instead of silently emitting nothing — a missing worker URL is precisely what
 * made the gated suites report "skipped" in CI.
 */
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));
const unknown = flags.filter((f) => f !== '--with-worker-login');
if (unknown.length > 0 || positional.length > 1) {
  process.stderr.write('refusing: usage: migration-security-test-env.cjs <database> [--with-worker-login]\n');
  process.exit(2);
}
const withWorker = flags.includes('--with-worker-login');
const db = positional[0] ?? '';
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
const workerPassword = (process.env.CREWFLOW_WORKER_BOOTSTRAP_PASSWORD ?? '').trim();
if (withWorker && !workerPassword) {
  process.stderr.write('refusing: --with-worker-login needs CREWFLOW_WORKER_BOOTSTRAP_PASSWORD (disposable-postgres exports it)\n');
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
// The crewflow_worker login (Phase D gated suites), only on request.
let worker = null;
if (withWorker) {
  worker = new URL(admin.toString());
  worker.username = 'crewflow_worker';
  worker.password = encodeURIComponent(workerPassword);
}
// Workflow commands go to stderr: GitHub reads them from either stream, and stdout is only the eval'd exports.
process.stderr.write(
  `::add-mask::${admin}\n::add-mask::${app}\n${crewflow ? `::add-mask::${crewflow}\n` : ''}${worker ? `::add-mask::${worker}\n` : ''}`,
);
process.stdout.write(
  `export TEST_DATABASE_ADMIN_URL=${q(admin)}\nexport TEST_DATABASE_URL_UNPOOLED=${q(admin)}\nexport TEST_DATABASE_URL=${q(app)}\n` +
    (crewflow ? `export TEST_DATABASE_CREWFLOW_URL=${q(crewflow)}\n` : '') +
    (worker ? `export TEST_DATABASE_WORKER_URL=${q(worker)}\n` : ''),
);
