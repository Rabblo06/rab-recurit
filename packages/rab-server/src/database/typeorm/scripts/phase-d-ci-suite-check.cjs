#!/usr/bin/env node
/**
 * E5: proves that the gated Phase D suites really RAN in the CI job, not that they were "skipped" (which is what a green
 * Phase D result meant in CI before E5: PHASE_D_SQL_APPROVED and TEST_DATABASE_WORKER_URL were never set).
 *
 *   node phase-d-ci-suite-check.cjs <server|worker> <jest --json output file>
 *
 * Fails (exit 1) when:
 *   - PHASE_D_D5 is anything but `before` (the gated 1786721330000 must never be applied or simulated in CI);
 *   - a REQUIRED suite is absent from the result (renamed, deleted, or filtered out by the --testFile pattern);
 *   - any suite in the result has a failed test or failed to run (a beforeAll throw counts);
 *   - a REQUIRED suite has zero passed tests (the whole file skipped);
 *   - a suite has a pending/skipped test that is not on the reviewed allow-list below.
 * Prints one line per suite (file name and counts only — never an environment value).
 */
const { readFileSync } = require('node:fs');
const { basename } = require('node:path');

const SUITES = {
  server: {
    required: [
      'phase-d-account-invite-cleanup-definer.integration.spec.ts',
      'phase-d-dispatch-notify-setting-posture.integration.spec.ts',
      'phase-d-dispatch-pointer.integration.spec.ts',
      'phase-d-due-work-cutover.integration.spec.ts',
      'phase-d-f2-pointer-identity.integration.spec.ts',
      'phase-d-invite-redemption-without-cleanup.integration.spec.ts',
      'phase-d-r4-secure-owner-regression.integration.spec.ts',
      'worker-identity-boot-gates.integration.spec.ts',
    ],
    // Whole-file skips that are reviewed and expected in CI, with the reason.
    skippedFiles: {
      // Opt-in benchmark (PHASE_D_EXPLAIN=true): EXPLAIN ANALYZE over 500k synthetic pointers. Not a correctness gate.
      'phase-d-dispatch-pointer-explain.integration.spec.ts': 'PHASE_D_EXPLAIN benchmark (500k rows), opt-in only',
    },
    // Individual pending tests allowed inside an otherwise running suite: file -> max count.
    pendingAllowed: {},
  },
  worker: {
    required: [
      'dq4b-timer-triggers.integration.spec.ts',
      'phase-d-account-invite-cleanup-worker.integration.spec.ts',
      'phase-d-backlog-reconciliation.integration.spec.ts',
      'phase-d-dispatch-recovery.integration.spec.ts',
      'phase-d-first-cutover-reconciliation.integration.spec.ts',
      'phase-d-global-dispatch.integration.spec.ts',
      'phase-d-storage-cleanup-worker-login.integration.spec.ts',
      'phase-d-two-worker-concurrency.integration.spec.ts',
      'push-dispatch-global-publish-failure.integration.spec.ts',
    ],
    skippedFiles: {
      // Restarts a dedicated local PostgreSQL container (crewflow-d-pgrestart on :15499); restarting the shared CI database
      // under the other suites is out of scope for this job (M0-H F2b: local).
      'phase-d-pg-restart.integration.spec.ts': 'restarts a dedicated local container (crewflow-d-pgrestart:15499); local only',
    },
    pendingAllowed: {
      // The Redis-outage case stops/starts only the container `crewflow-c1-redis-c1e` (PHASE_D_REDIS_CONTAINER); CI's
      // Redis is a job service container, never stopped by a test.
      'phase-d-two-worker-concurrency.integration.spec.ts': 1,
    },
  },
};

function fail(msg) {
  process.stderr.write(`phase-d-ci-suite-check: FAIL: ${msg}\n`);
  process.exitCode = 1;
}

const [kind, file] = process.argv.slice(2);
const spec = SUITES[kind];
if (!spec || !file) {
  process.stderr.write('usage: phase-d-ci-suite-check.cjs <server|worker> <jest-json-file>\n');
  process.exit(2);
}
if (process.env.PHASE_D_D5 !== 'before') {
  fail(`PHASE_D_D5 must be exactly "before" in CI (1786721330000 stays gated and excluded); got ${JSON.stringify(process.env.PHASE_D_D5 ?? null)}`);
}
if (process.env.PHASE_D_SQL_APPROVED !== 'true') fail('PHASE_D_SQL_APPROVED is not "true": the gated suites would all skip');

let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  fail(`cannot read the jest JSON result ${file}: ${e.message}`);
  process.exit(1);
}

const seen = new Map();
for (const r of report.testResults ?? []) {
  const name = basename(r.name ?? r.testFilePath ?? '');
  const tests = r.assertionResults ?? r.testResults ?? [];
  const count = (s) => tests.filter((t) => t.status === s).length;
  const passed = count('passed');
  const failed = count('failed');
  const pending = tests.filter((t) => t.status === 'pending' || t.status === 'skipped' || t.status === 'todo').length;
  const runFailed = r.status === 'failed' || Boolean(r.testExecError) || (failed === 0 && r.failureMessage);
  seen.set(name, { passed, failed, pending, runFailed });
  process.stdout.write(`${kind}: ${name}: passed=${passed} failed=${failed} pending=${pending}${runFailed ? ' RUN-FAILED' : ''}\n`);
}

for (const [name, s] of seen) {
  if (s.failed > 0 || s.runFailed) fail(`${name}: ${s.failed} failed test(s)${s.runFailed ? ' / the file failed to run' : ''}`);
  const skippedReason = spec.skippedFiles[name];
  if (skippedReason !== undefined) {
    if (s.passed > 0) fail(`${name} is on the skipped-file allow-list but ran ${s.passed} test(s): review and move it to required`);
    continue;
  }
  const allowedPending = spec.pendingAllowed[name] ?? 0;
  if (s.pending > allowedPending) fail(`${name}: ${s.pending} pending/skipped test(s), ${allowedPending} allowed`);
}
for (const name of spec.required) {
  const s = seen.get(name);
  if (!s) fail(`${name} is required but did not run (renamed, removed, or not matched by --testFile)`);
  else if (s.passed === 0) fail(`${name} is required but passed 0 tests (skipped: the Phase D opt-in did not reach it)`);
}
if (process.exitCode !== 1) {
  process.stdout.write(`phase-d-ci-suite-check: OK (${kind}): ${spec.required.length} required suites ran and passed; PHASE_D_D5=before\n`);
}
