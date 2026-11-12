'use strict';
/**
 * Tests for compose-owner-login.cjs: env-file lint, raw-text lint, and the bundled-database (STATIC mode) rules.
 *
 *   node --test packages/rab-docker/scripts/compose-owner-login.test.cjs
 *
 * The rendered-model cases render docker-compose.image.yml + docker-compose.local-db.yml once with `docker compose` (they
 * report as skipped without it; CI requires it), then mutate a COPY, so each proves one specific refusal. The FULL-mode
 * cases (the in-place docker-compose.image.yml contract) live in compose-owner-login.full.test.cjs, which lands with the
 * in-place compose edits after #61/#62.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const gate = require('./compose-owner-login.cjs');
const { STATIC_COMBO, checkStaticModel, lintEnvText, lintComposeText, durationSeconds, forbiddenReason, renderModels, staticProblems } = gate;

const assertRefused = (problems, pattern) => {
  assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}; got: ${problems.join(' | ') || '(none)'}`);
};
const URL_OK = 'postgresql://crewflow_owner:Zq81-not-a-real-password-77@db.internal.example:5432/crewflow?sslmode=verify-full'; // gitleaks:allow
const DATABASE_OK = [
  `PG_DATABASE_URL=${URL_OK}`,
  'PG_SSL_CA_CERT_PATH=/run/crewflow/pg-ca.crt',
  'PG_EXPECTED_DATABASE_NAME=crewflow',
  'CREWFLOW_DEPLOYMENT_ENVIRONMENT=production',
  'CREWFLOW_DEPLOYMENT_ID=6f1e3c1a-4b8e-4d7a-9a0b-2c3d4e5f6a7b',
].join('\n');

// ------------------------------------------------------------------------------------------------ pure helpers

test('durations: compose renderings parse to seconds', () => {
  assert.equal(durationSeconds('45s'), 45);
  assert.equal(durationSeconds('15m0s'), 900);
  assert.equal(durationSeconds('1h2m3s'), 3723);
  assert.equal(durationSeconds('1m30.5s'), 90.5);
  assert.ok(Number.isNaN(durationSeconds(undefined)));
  assert.ok(Number.isNaN(durationSeconds('soon')));
});

test('forbidden names: every second database identity, role password, authority and the mode switch are refused', () => {
  assert.equal(forbiddenReason('PG_DATABASE_URL'), null);
  assert.equal(forbiddenReason('APP_SECRET'), null);
  for (const name of [
    'DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_DIRECT_URL', 'PG_WORKER_DATABASE_URL', 'CREWFLOW_PROVISIONER_DATABASE_URL',
    'CREWFLOW_MIGRATION_DATABASE_URL', 'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL', 'PG_DATABASE_REPLICA_URL', 'PG_DATABASE_REPLICA_MAX_LAG_MS',
    'PG_OPS_APP_DATABASE_URL', 'POSTURE_DATABASE_URL', 'DRIFT_DATABASE_URL', 'SOME_OTHER_DATABASE_URL', 'TEST_DATABASE_URL',
    'CREWFLOW_MIGRATION_APPROVED', 'CREWFLOW_BOOTSTRAP_PASSWORD', 'CREWFLOW_APP_BOOTSTRAP_PASSWORD', 'CREWFLOW_WORKER_BOOTSTRAP_PASSWORD',
    'CREWFLOW_MIGRATOR_PASSWORD', 'CREWFLOW_OPS_RUN', 'ALLOW_PRODUCTION_DB_COMMANDS', 'DB_TARGET', 'CREWFLOW_DB_MODE', 'PGPASSWORD',
    'PGHOST', 'PGCONNECT_TIMEOUT', 'NODE_OPTIONS', 'BOOTSTRAP_ADMIN_EMAIL', 'WORKER_CLAIM_MODE', 'CREWFLOW_PROVISIONER_ENABLED',
  ]) {
    assert.ok(forbiddenReason(name), `${name} must be forbidden`);
  }
  assert.match(forbiddenReason('CREWFLOW_MIGRATION_APPROVED'), /approval mode none; there is no token/);
  assert.match(forbiddenReason('CREWFLOW_DB_MODE'), /no mode switch/);
});

// ------------------------------------------------------------------------------------------------ env-file lint

test('the committed templates and compose text pass the static checks', () => {
  assert.deepEqual(staticProblems(), []);
});

test('no committed template assigns CREWFLOW_MIGRATION_APPROVED or CREWFLOW_DB_MODE (they are only named in MUST-NOT lists)', () => {
  for (const file of Object.values(gate.TEMPLATES)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/^\s*(export\s+)?CREWFLOW_MIGRATION_APPROVED\s*=/m.test(text), `${file} assigns the approval token`);
    assert.ok(!/^\s*(export\s+)?CREWFLOW_DB_MODE\s*=/m.test(text), `${file} assigns the retired mode switch`);
  }
});

test('database env: a clean real file passes', () => {
  assert.deepEqual(lintEnvText('database', DATABASE_OK), []);
});

test('database env: the approval token is refused (O3: approval mode none, there is no token)', () => {
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nCREWFLOW_MIGRATION_APPROVED=pending-1-${'a'.repeat(64)}`), /CREWFLOW_MIGRATION_APPROVED: .*no token/);
  assertRefused(lintEnvText('runtime', `export CREWFLOW_MIGRATION_APPROVED=pending-1-${'a'.repeat(64)}`), /CREWFLOW_MIGRATION_APPROVED/);
});

test('database env: a second database URL under any name is refused', () => {
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nDATABASE_URL_UNPOOLED=${URL_OK}`), /DATABASE_URL_UNPOOLED/);
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nPG_DATABASE_REPLICA_URL=${URL_OK}`), /PG_DATABASE_REPLICA_URL: .*replica/);
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nPG_WORKER_DATABASE_URL=${URL_OK}`), /PG_WORKER_DATABASE_URL/);
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nCREWFLOW_PROVISIONER_DATABASE_URL=${URL_OK}`), /CREWFLOW_PROVISIONER_DATABASE_URL/);
  assertRefused(lintEnvText('runtime', `SENTRY_DSN=${URL_OK}`), /SENTRY_DSN: holds a PostgreSQL URL/);
});

test('database env: libpq variables, the mode switch, committed keys, duplicates and foreign keys are refused', () => {
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nPGPASSWORD=x`), /PGPASSWORD: a libpq variable/);
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nCREWFLOW_DB_MODE=twenty`), /CREWFLOW_DB_MODE: there is no mode switch/);
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nCREWFLOW_MIGRATE_ON_START=true`), /CREWFLOW_MIGRATE_ON_START: committed/);
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nPG_EXPECTED_DATABASE_NAME=other`), /set more than once/);
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nAPP_SECRET=x`), /APP_SECRET: does not belong in the shared database file/);
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nCREWFLOW_WORKER_BOOTSTRAP_PASSWORD=x`), /role password/);
});

test('database env: the URL must be crewflow_owner, verify-full, the direct host, with a password', () => {
  const withUrl = (url) => DATABASE_OK.replace(URL_OK, url);
  assertRefused(lintEnvText('database', withUrl(URL_OK.replace('crewflow_owner', 'neondb_owner'))), /provider admin or a former separated login/);
  assertRefused(lintEnvText('database', withUrl(URL_OK.replace('crewflow_owner', 'crewflow_app'))), /provider admin or a former separated login/);
  assertRefused(lintEnvText('database', withUrl(URL_OK.replace('crewflow_owner', 'crewflow_migrator'))), /former separated login/);
  assertRefused(lintEnvText('database', withUrl(URL_OK.replace('crewflow_owner', 'someone'))), /login is not crewflow_owner/);
  assertRefused(lintEnvText('database', withUrl(URL_OK.replace('verify-full', 'require'))), /sslmode is not verify-full/);
  assertRefused(lintEnvText('database', withUrl(URL_OK.replace('db.internal.example', 'ep-x-pooler.eu.aws.neon.tech'))), /transaction pooler/);
  assertRefused(lintEnvText('database', withUrl(URL_OK.replace(':5432', ':6543'))), /transaction pooler/);
  assertRefused(lintEnvText('database', withUrl('postgresql://crewflow_owner@db.internal.example:5432/crewflow?sslmode=verify-full')), /no password/);
  assertRefused(lintEnvText('database', 'PG_SSL_CA_CERT_PATH=/x'), /PG_DATABASE_URL: missing/);
});

test('runtime env: PG_DATABASE_URL is refused there (it lives in database.env only)', () => {
  assertRefused(lintEnvText('runtime', `PG_DATABASE_URL=${URL_OK}`), /belongs in database.env only/);
  assertRefused(lintEnvText('runtime', 'NODE_OPTIONS=--require /tmp/x.js'), /NODE_OPTIONS/);
  assertRefused(lintEnvText('runtime', 'WORKER_INVITE_AUTO_DELETE_ENABLED=true'), /WORKER_INVITE_AUTO_DELETE_ENABLED/);
});

test('BC-11 opt-in: the deployment identity lives in database.env only; O3: the approval mode is committed, never an env file value', () => {
  const noIdentity = DATABASE_OK.split('\n').filter((l) => !l.startsWith('CREWFLOW_DEPLOYMENT_')).join('\n');
  assert.deepEqual(lintEnvText('database', noIdentity), [], 'the deployment identity is optional');
  for (const key of ['CREWFLOW_DEPLOYMENT_ID', 'CREWFLOW_DEPLOYMENT_ENVIRONMENT']) {
    assertRefused(lintEnvText('runtime', `${key}=x`), new RegExp(`${key}: belongs in database.env only`));
    assertRefused(lintComposeText('x.yml', `services:\n  a:\n    environment:\n      ${key}: x\n`), /commits a BC-11 opt-in/);
  }
  // O3 + BC-11/C4: the approval mode is a compose.env interpolation value (none by default, token an opt-in). In
  // database.env / runtime.env rab-api's committed expression would silently override it, so it is refused there and the
  // refusal names compose.env.
  for (const kind of ['database', 'runtime']) {
    for (const mode of ['none', 'token']) assertRefused(lintEnvText(kind, `${kind === 'database' ? `${DATABASE_OK}\n` : ''}CREWFLOW_MIGRATION_APPROVAL_MODE=${mode}`), /CREWFLOW_MIGRATION_APPROVAL_MODE: set it in compose\.env/);
  }
  for (const mode of ['none', 'token']) assert.deepEqual(lintEnvText('compose', `CREWFLOW_MIGRATION_APPROVAL_MODE=${mode}`), []);
  assertRefused(lintEnvText('compose', 'CREWFLOW_MIGRATION_APPROVAL_MODE=off'), /must be exactly none or token/);
  // The compose files may carry only the interpolation, never a literal that pins the mode.
  assert.deepEqual(lintComposeText('x.yml', 'services:\n  a:\n    environment:\n      CREWFLOW_MIGRATION_APPROVAL_MODE: ${CREWFLOW_MIGRATION_APPROVAL_MODE:-none}\n'), []);
  for (const literal of ['none', 'token', '${CREWFLOW_MIGRATION_APPROVAL_MODE:-token}']) {
    assertRefused(lintComposeText('x.yml', `services:\n  a:\n    environment:\n      CREWFLOW_MIGRATION_APPROVAL_MODE: ${literal}\n`), /must be exactly \$\{CREWFLOW_MIGRATION_APPROVAL_MODE:-none\}/);
  }
});

test('BC-07: CREWFLOW_AUDIT_SINK is required in runtime.env, with a production-accepted value only', () => {
  const ok = 'CREWFLOW_AUDIT_SINK=stdout';
  assert.deepEqual(lintEnvText('runtime', ok), []);
  // missing
  assertRefused(lintEnvText('runtime', 'APP_URL=https://crewflow.example'), /CREWFLOW_AUDIT_SINK: missing \(BC-07/);
  // invalid value, and values the code accepts but production refuses
  assertRefused(lintEnvText('runtime', 'CREWFLOW_AUDIT_SINK=syslog'), /must be exactly none, stdout or file/);
  assertRefused(lintEnvText('runtime', 'CREWFLOW_AUDIT_SINK=STDOUT'), /must be exactly none, stdout or file/);
  for (const v of ['none', 'file']) assertRefused(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=${v}`), new RegExp(`production refuses ${v}`));
  assertRefused(lintEnvText('runtime', `${ok}\nCREWFLOW_AUDIT_SINK_FAILURE=log`), /production requires refuse/);
  assertRefused(lintEnvText('runtime', `${ok}\nCREWFLOW_AUDIT_SINK_FAILURE=maybe`), /must be exactly refuse or log/);
  assert.deepEqual(lintEnvText('runtime', `${ok}\nCREWFLOW_AUDIT_SINK_FAILURE=refuse`), []);
  assertRefused(lintEnvText('runtime', `${ok}\nCREWFLOW_AUDIT_SINK_FILE=/var/log/audit.jsonl`), /development-only/);
  // only in runtime.env, never in another file and never committed in compose
  assertRefused(lintEnvText('database', `${DATABASE_OK}\n${ok}`), /belongs in runtime\.env/);
  assertRefused(lintEnvText('compose', ok), /belongs in runtime\.env/);
  assertRefused(lintComposeText('x.yml', 'services:\n  a:\n    environment:\n      CREWFLOW_AUDIT_SINK: stdout\n'), /commits the audit sink/);
});

test('BC-07: the gate\'s audit-sink values are exactly the code\'s (security-audit-sink.ts), never invented', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../rab-server/src/engine/core-modules/audit-sink/security-audit-sink.ts'), 'utf8');
  const modes = /if \(mode !== '(\w+)' && mode !== '(\w+)' && mode !== '(\w+)'\)/.exec(src);
  assert.ok(modes, 'the mode check moved: update the gate and this test together');
  assert.deepEqual([...modes.slice(1)].sort(), [...gate.AUDIT_SINK_MODES].sort());
  const failures = /if \(failure !== '(\w+)' && failure !== '(\w+)'\)/.exec(src);
  assert.ok(failures, 'the failure-policy check moved');
  assert.deepEqual([...failures.slice(1)].sort(), [...gate.AUDIT_SINK_FAILURES].sort());
  // Production refuses none and file, and log; it accepts stdout and refuse (the gate's production lists).
  assert.match(src, /if \(production && mode === 'none'\)/);
  assert.match(src, /if \(production && mode === 'file'\)/);
  assert.match(src, /if \(production && failure === 'log'\)/);
  assert.deepEqual([...gate.AUDIT_SINK_PRODUCTION_MODES], gate.AUDIT_SINK_MODES.filter((m) => m !== 'none' && m !== 'file'));
  assert.deepEqual([...gate.AUDIT_SINK_PRODUCTION_FAILURES], gate.AUDIT_SINK_FAILURES.filter((f) => f !== 'log'));
});

test('O3: the upgrade-failure policy, the scheduler keys and the start-up flag', () => {
  for (const v of ['continue', 'refuse']) assert.deepEqual(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout
CREWFLOW_UPGRADE_FAILURE=${v}`), []);
  assertRefused(lintEnvText('runtime', 'CREWFLOW_UPGRADE_FAILURE=maybe'), /must be exactly continue or refuse/);
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nCREWFLOW_UPGRADE_FAILURE=refuse`), /belongs in runtime.env/);
  assertRefused(lintEnvText('runtime', 'CREWFLOW_UPGRADE_FAILURE_POLICY=refuse'), /deprecated \(O3 C3\)/);
  assertRefused(lintEnvText('runtime', 'CREWFLOW_UPGRADE_INCOMPLETE=Beta1'), /set only by api-prestart\.sh/);
  for (const key of ['DISABLE_DB_MIGRATIONS', 'DISABLE_CRON_JOBS_REGISTRATION', 'CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS', 'WORKER_SCHEDULER']) {
    assertRefused(lintEnvText('runtime', `${key}=x`), new RegExp(`${key}: committed in the compose files`));
  }
});

test('notification delivery (owner decision 2026-11-06): committed in compose, never re-entered in an env file', () => {
  for (const key of ['WORKER_FAST_PUBLISH_NOTIFY', 'WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS']) {
    for (const value of ['true', 'false', '2', '30']) {
      assertRefused(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout
${key}=${value}`), new RegExp(`${key}: committed in the compose files`));
      assertRefused(lintEnvText('database', `${DATABASE_OK}
${key}=${value}`), new RegExp(`${key}: committed in the compose files`));
    }
  }
  assert.deepEqual({ ...gate.NOTIFICATION_DELIVERY }, { WORKER_FAST_PUBLISH_NOTIFY: 'true', WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS: '30' });
});

test('notification delivery: the committed values are valid for the code (bounds and switch read from the TypeScript source)', () => {
  const intervals = fs.readFileSync(path.join(__dirname, '../../rab-server/src/engine/core-modules/environment/worker-scan-intervals.ts'), 'utf8');
  const m = /WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS:\s*s\('email-dispatch',\s*(\d+),\s*(\d+),\s*(\d+)\)/.exec(intervals);
  assert.ok(m, 'email-dispatch interval setting not found in worker-scan-intervals.ts');
  const [, def, min, max] = m.map(Number);
  const committed = Number(gate.NOTIFICATION_DELIVERY.WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS);
  assert.ok(committed >= min && committed <= max, `30 s must lie within the code bounds ${min}-${max}`);
  // The code defaults stay as they are (development and tests keep 2 s and false); production commits its own values.
  assert.equal(def, 2);
  const vars = fs.readFileSync(path.join(__dirname, '../../rab-server/src/engine/core-modules/environment/environment-variables.ts'), 'utf8');
  assert.match(vars, /@Transform\(\(\{ value \}\) => value === 'true'\)\s*@IsBoolean\(\)\s*WORKER_FAST_PUBLISH_NOTIFY: boolean = false;/);
});

const PHASE_D_KEYS = ['WORKER_TIMER_TRIGGERS', 'WORKER_TIMER_TRIGGER_KINDS', 'WORKER_OFFER_EXPIRY_INTERVAL_SECONDS', 'WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS', 'WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS'];

test('Phase D switches (owner decision 2026-11-06): committed in compose, never re-entered in an env file', () => {
  assert.deepEqual({ ...gate.PHASE_D_SWITCHES }, {
    WORKER_TIMER_TRIGGERS: 'on',
    WORKER_TIMER_TRIGGER_KINDS: 'offer-expiry,manager-confirmation,no-show,late-clock-in',
    WORKER_OFFER_EXPIRY_INTERVAL_SECONDS: '300',
    WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS: '120',
    WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS: '300',
  });
  for (const key of PHASE_D_KEYS) {
    // Every value, including the committed one and "off": an env-file copy would either duplicate or silently undo it.
    for (const value of ['on', 'off', 'shadow', 'offer-expiry', '60', '120', '300']) {
      assertRefused(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout
${key}=${value}`), new RegExp(`${key}: committed in the compose files`));
      assertRefused(lintEnvText('database', `${DATABASE_OK}
${key}=${value}`), new RegExp(`${key}: committed in the compose files`));
    }
  }
});

test('Phase D (owner decision 2026-11-06): the shift monitor keeps 300 s and the combined shift scan stays off', () => {
  assert.deepEqual({ ...gate.PHASE_D_UNCHANGED }, { WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: '300', WORKER_SHIFT_SCAN_MODE: 'separate' });
  for (const value of ['combined', 'Combined', 'COMBINED']) {
    assertRefused(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout
WORKER_SHIFT_SCAN_MODE=${value}`), /WORKER_SHIFT_SCAN_MODE: the owner decision 2026-11-06 keeps it at separate/);
  }
  for (const value of ['30', '120', '299', '600']) {
    assertRefused(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout
WORKER_SHIFT_MONITOR_INTERVAL_SECONDS=${value}`), /WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: the owner decision 2026-11-06 keeps it at 300/);
  }
  // The code defaults themselves are accepted (they change nothing).
  assert.deepEqual(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout
WORKER_SHIFT_SCAN_MODE=separate
WORKER_SHIFT_MONITOR_INTERVAL_SECONDS=300`), []);
});

test('Phase D switches: the committed values are valid for the code (bounds, modes and kinds read from the TypeScript source)', () => {
  const src = (rel) => fs.readFileSync(path.join(__dirname, '../../rab-server/src/engine', rel), 'utf8');
  const intervals = src('core-modules/environment/worker-scan-intervals.ts');
  const setting = (key, job) => {
    const m = new RegExp(`${key}:\\s*s\\('${job}',\\s*([\\d_]+),\\s*([\\d_]+),\\s*([\\d_]+)\\)`).exec(intervals);
    assert.ok(m, `${key} not found in worker-scan-intervals.ts`);
    return m.slice(1).map((x) => Number(x.replace(/_/g, '')));
  };
  // [key, BullMQ job name, code default that stays unchanged for development and tests]
  for (const [key, job, codeDefault] of [
    ['WORKER_OFFER_EXPIRY_INTERVAL_SECONDS', 'offer-expiry', 60],
    ['WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS', 'manager-confirmation-timeout', 60],
    ['WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS', 'late-clock-in', 120],
  ]) {
    const [def, min, max] = setting(key, job);
    const committed = Number(gate.PHASE_D_SWITCHES[key]);
    assert.ok(Number.isInteger(committed) && committed >= min && committed <= max, `${key}=${committed} must lie within the code bounds ${min}-${max}`);
    assert.equal(def, codeDefault, `${key}: the code default stays ${codeDefault}`);
  }
  // The shift monitor is NOT changed: the kept value is the code default.
  assert.equal(setting('WORKER_SHIFT_MONITOR_INTERVAL_SECONDS', 'shift-monitor')[0], Number(gate.PHASE_D_UNCHANGED.WORKER_SHIFT_MONITOR_INTERVAL_SECONDS));
  const vars = src('core-modules/environment/environment-variables.ts');
  assert.match(vars, /@IsIn\(\['off', 'shadow', 'on'\][^)]*\)\s*WORKER_TIMER_TRIGGERS: 'off' \| 'shadow' \| 'on' = 'off';/);
  assert.match(vars, /WORKER_SHIFT_SCAN_MODE: 'separate' \| 'combined' = 'separate';/);
  // The committed kinds are EXACTLY the code's kinds: a kind added later fails here, so switching it on is a new decision.
  const contract = src('worker-shared/timer-trigger.contract.ts');
  const kinds = /export const TIMER_TRIGGER_KINDS = \[([^\]]*)\] as const;/.exec(contract);
  assert.ok(kinds, 'TIMER_TRIGGER_KINDS not found in timer-trigger.contract.ts');
  const codeKinds = kinds[1].split(',').map((k) => k.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(gate.PHASE_D_SWITCHES.WORKER_TIMER_TRIGGER_KINDS.split(','), codeKinds);
});

test('pay-statement sweep (owner decision 2026-11-11, J1a): committed in compose, never re-entered in an env file', () => {
  assert.deepEqual({ ...gate.STATEMENT_DISPATCH }, { WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS: '30' });
  // Every value, the committed one and the 5 s code default included: an env-file copy would duplicate or silently undo it.
  for (const value of ['1', '5', '30', '300']) {
    assertRefused(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout
WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS=${value}`), /WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS: committed in the compose files/);
    assertRefused(lintEnvText('database', `${DATABASE_OK}
WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS=${value}`), /WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS: committed in the compose files/);
  }
});

test('pay-statement sweep: 30 s is valid for the code (bounds read from the TypeScript source; the 5 s default stays)', () => {
  const intervals = fs.readFileSync(path.join(__dirname, '../../rab-server/src/engine/core-modules/environment/worker-scan-intervals.ts'), 'utf8');
  const m = /WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS:\s*s\('shift-statement-dispatch',\s*([\d_]+),\s*([\d_]+),\s*([\d_]+)\)/.exec(intervals);
  assert.ok(m, 'shift-statement-dispatch interval setting not found in worker-scan-intervals.ts');
  const [def, min, max] = m.slice(1).map((x) => Number(x.replace(/_/g, '')));
  const committed = Number(gate.STATEMENT_DISPATCH.WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS);
  assert.ok(Number.isInteger(committed) && committed >= min && committed <= max, `30 s must lie within the code bounds ${min}-${max}`);
  assert.equal(def, 5, 'development and tests keep the 5 s code default');
});

test('Phase D switches: the gate and the image-compose verifier enforce the same values', () => {
  const verifier = require('../staging/verify-image-compose.cjs');
  assert.deepEqual({ ...verifier.STATEMENT_DISPATCH }, { ...gate.STATEMENT_DISPATCH });
  assert.deepEqual({ ...verifier.PHASE_D_SWITCHES }, { ...gate.PHASE_D_SWITCHES });
  assert.deepEqual({ ...verifier.PHASE_D_UNCHANGED }, { ...gate.PHASE_D_UNCHANGED });
  assert.deepEqual({ ...verifier.NOTIFICATION_DELIVERY }, { ...gate.NOTIFICATION_DELIVERY });
});

test('bootstrap-admin authority and inputs are one-off `run -e` values only: refused in every env file', () => {
  for (const kind of ['database', 'runtime', 'compose']) {
    for (const name of ['DB_TARGET', 'ALLOW_PRODUCTION_DB_COMMANDS', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_ORG_SLUG', 'BOOTSTRAP_ADMIN_PASSWORD']) {
      assertRefused(lintEnvText(kind, `${name}=x`), new RegExp(`${name}: `));
    }
  }
});

test('compose env: interpolation values only, digests, never a secret, never every interface', () => {
  const ok = `CREWFLOW_IMAGE_TAG=sha256:${'a'.repeat(64)}\nCREWFLOW_REDIS_IMAGE=redis@sha256:${'b'.repeat(64)}\nCREWFLOW_SECRETS_DIR=/etc/crewflow/secrets`;
  assert.deepEqual(lintEnvText('compose', ok), []);
  assertRefused(lintEnvText('compose', 'CREWFLOW_REDIS_IMAGE=redis:7-alpine'), /not pinned by digest/);
  assertRefused(lintEnvText('compose', 'CREWFLOW_IMAGE_TAG=latest'), /not a sha256/);
  assertRefused(lintEnvText('compose', 'CREWFLOW_IMAGE_TAG=0e0a6edd4'), /a plain tag is refused/);
  assertRefused(lintEnvText('compose', `CREWFLOW_IMAGE_DIGEST=sha256:${'a'.repeat(64)}`), /renamed \(2026-11-11\); set CREWFLOW_IMAGE_TAG/);
  assertRefused(lintEnvText('compose', `CREWFLOW_API_IMAGE_TAG=sha256:${'a'.repeat(64)}`), /retired \(O2: one image\); set CREWFLOW_IMAGE_TAG/);
  assertRefused(lintEnvText('compose', `CREWFLOW_WORKER_IMAGE_TAG=sha256:${'a'.repeat(64)}`), /retired/);
  // O2: the retired per-role image variables are refused with the replacement named.
  assertRefused(lintEnvText('compose', `CREWFLOW_API_IMAGE_DIGEST=sha256:${'a'.repeat(64)}`), /retired \(O2: one image\); set CREWFLOW_IMAGE_TAG/);
  assertRefused(lintEnvText('compose', `CREWFLOW_WORKER_IMAGE_DIGEST=sha256:${'a'.repeat(64)}`), /retired/);
  assertRefused(lintEnvText('compose', 'CREWFLOW_WORKER_IMAGE_REPOSITORY=example/repo'), /set CREWFLOW_IMAGE_REPOSITORY/);
  assertRefused(lintEnvText('compose', 'CREWFLOW_OWNER_PASSWORD=x'), /secret-like name/);
  assertRefused(lintEnvText('compose', 'APP_SECRET=x'), /only CREWFLOW_\* interpolation values/);
  assertRefused(lintEnvText('compose', 'CREWFLOW_API_BIND=0.0.0.0'), /binds every interface/);
});

test('lint messages never contain a value', () => {
  const secret = 'Kq7-unique-marker-value-91'; // gitleaks:allow (synthetic)
  const text = `PG_DATABASE_URL=postgresql://neondb_owner:${secret}@ep-x-pooler.neon.tech:5432/db?sslmode=require\nPGPASSWORD=${secret}\nCREWFLOW_MIGRATION_APPROVED=${secret}\nAPP_SECRET=${secret}`;
  for (const kind of ['database', 'runtime', 'compose']) {
    for (const msg of lintEnvText(kind, text)) assert.ok(!msg.includes(secret), `${kind}: message leaks a value: ${msg}`);
  }
});

test('raw compose text: build, a committed token, the mode switch and privileged are refused', () => {
  assertRefused(lintComposeText('x.yml', 'services:\n  a:\n    build:\n      context: .\n'), /build/);
  assertRefused(lintComposeText('x.yml', 'services:\n  a:\n    environment:\n      CREWFLOW_MIGRATION_APPROVED: pending-1\n'), /CREWFLOW_MIGRATION_APPROVED/);
  assertRefused(lintComposeText('x.yml', 'services:\n  a:\n    environment:\n      CREWFLOW_DB_MODE: twenty\n'), /no mode switch/);
  assertRefused(lintComposeText('x.yml', 'services:\n  a:\n    privileged: true\n'), /privileged/);
  assert.deepEqual(lintComposeText('x.yml', '# run -e CREWFLOW_MIGRATION_APPROVED=<token> rab-migrate\n'), []);
});

// ------------------------------------------------------------------------------------------------ bundled database

let composeAvailable = true;
try {
  execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
} catch {
  composeAvailable = false;
}
const skip = composeAvailable ? false : 'docker compose is not available';
let model;
const fresh = () => {
  model ??= renderModels([STATIC_COMBO])[STATIC_COMBO.name];
  return structuredClone(model);
};
const problemsAfter = (mutate) => {
  const m = fresh();
  mutate(m.services, m);
  return checkStaticModel(m);
};

test('image + local-db: the committed override passes the bundled-database rules', { skip }, () => {
  assert.deepEqual(checkStaticModel(fresh()), []);
});

test('bundled database: hardening keys are required', { skip }, () => {
  assertRefused(problemsAfter((s) => { s['rab-postgres'].read_only = false; }), /rab-postgres: read_only/);
  assertRefused(problemsAfter((s) => { s['rab-postgres'].user = '0:0'; }), /rab-postgres: user "0:0" is root/);
  assertRefused(problemsAfter((s) => { s['rab-postgres'].cap_add = ['CHOWN']; }), /adds capabilities/);
  assertRefused(problemsAfter((s) => { s['rab-postgres'].image = 'postgres:16-alpine'; }), /not pinned by digest/);
  assertRefused(problemsAfter((s) => { s['rab-postgres'].ports = [{ target: 5432, host_ip: '0.0.0.0', published: '5432' }]; }), /publishes a port/);
  assertRefused(problemsAfter((s) => { delete s['rab-postgres'].healthcheck; }), /rab-postgres: no health check/);
});

test('bundled database: superuser never the app login, no clear-text password, TLS, reviewed hba', { skip }, () => {
  assertRefused(problemsAfter((s) => { s['rab-postgres'].environment.POSTGRES_USER = 'crewflow_owner'; }), /superuser is the app login/);
  assertRefused(problemsAfter((s) => { s['rab-postgres'].environment.POSTGRES_PASSWORD = 'x'; }), /POSTGRES_PASSWORD in the environment/);
  assertRefused(problemsAfter((s) => { s['rab-postgres'].environment.POSTGRES_HOST_AUTH_METHOD = 'trust'; }), /trust/);
  assertRefused(problemsAfter((s) => { s['rab-postgres'].command = s['rab-postgres'].command.filter((t) => t !== 'ssl=on'); }), /TLS is not on/);
  assertRefused(problemsAfter((s) => { s['rab-postgres'].command = s['rab-postgres'].command.filter((t) => !t.startsWith('hba_file=')); }), /pg_hba/);
  assertRefused(problemsAfter((s) => {
    for (const svc of ['rab-api', 'rab-worker']) s[svc].environment = { ...s[svc].environment, PG_DATABASE_URL: 'postgresql://postgres:x@rab-postgres:5432/crewflow?sslmode=verify-full' };
  }), /logs in as the bundled superuser/);
});

test('bundled database: exactly Agent 1\'s fresh-install SQL as the one init file, never the transition script or the directory', { skip }, () => {
  const init = (s) => s['rab-postgres'].volumes.find((v) => String(v.target).startsWith('/docker-entrypoint-initdb.d'));
  assertRefused(problemsAfter((s) => { init(s).target = '/docker-entrypoint-initdb.d'; init(s).source = init(s).source.replace(/\/01-crewflow-owner\.sql$/, ''); }), /exactly ONE read-only file/);
  assertRefused(problemsAfter((s) => { init(s).source = init(s).source.replace('01-crewflow-owner.sql', 'transition-from-separated.sql'); }), /transition/);
  assertRefused(problemsAfter((s) => { init(s).read_only = false; }), /exactly ONE read-only file|writable/);
  assertRefused(problemsAfter((s) => { s['rab-postgres'].volumes = s['rab-postgres'].volumes.filter((v) => !String(v.target).startsWith('/docker-entrypoint-initdb.d')); }), /exactly ONE read-only file/);
});

test('bundled database: internal network only, and every app service waits for it', { skip }, () => {
  assertRefused(problemsAfter((s) => { s['rab-postgres'].networks.default = null; }), /internal crewflow-db network only/);
  assertRefused(problemsAfter((s, m) => { m.networks['crewflow-db'].internal = false; }), /crewflow-db is not internal/);
  for (const svc of ['rab-api', 'rab-worker']) {
    assertRefused(problemsAfter((s) => { delete s[svc].depends_on['rab-postgres']; }), new RegExp(`${svc}: does not wait for a healthy rab-postgres`));
    assertRefused(problemsAfter((s) => { delete s[svc].networks['crewflow-db']; }), new RegExp(`${svc}: is not on the crewflow-db network`));
  }
});

// Phase X J2 (S0-J SJ-03): the push / realtime sweep rule once the feature is switched on.
test('J2: the rule values (push 30 s by the owner rule 2026-11-06; realtime not pinned) and the verifier mirrors them', () => {
  assert.equal(gate.FEATURE_SWEEPS.PUSH_ENABLED.key, 'WORKER_PUSH_DISPATCH_INTERVAL_SECONDS');
  assert.equal(gate.FEATURE_SWEEPS.PUSH_ENABLED.value, '30');
  assert.equal(gate.FEATURE_SWEEPS.REALTIME_ENABLED.key, 'WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS');
  assert.equal(gate.FEATURE_SWEEPS.REALTIME_ENABLED.value, null);
  const verifier = require('../staging/verify-image-compose.cjs');
  assert.deepEqual(JSON.parse(JSON.stringify(verifier.FEATURE_SWEEPS)), JSON.parse(JSON.stringify(gate.FEATURE_SWEEPS)));
});

test('J2: 30 s lies within the push sweep bounds read from the TypeScript source; the switches parse exactly as the code does', () => {
  const src = (rel) => fs.readFileSync(path.join(__dirname, '../../rab-server/src/engine/core-modules/environment', rel), 'utf8');
  const m = /WORKER_PUSH_DISPATCH_INTERVAL_SECONDS:\s*s\('push-dispatch',\s*(\d+),\s*(\d+),\s*(\d+)\)/.exec(src('worker-scan-intervals.ts'));
  assert.ok(m, 'push-dispatch interval setting not found');
  const [, , min, max] = m.map(Number);
  assert.ok(30 >= min && 30 <= max);
  const vars = src('environment-variables.ts');
  for (const flag of ['PUSH_ENABLED', 'REALTIME_ENABLED']) {
    assert.match(vars, new RegExp(`@Transform\\(\\(\\{ value \\}\\) => value === 'true'\\)\\s*@IsBoolean\\(\\)\\s*${flag}: boolean = false;`), flag);
  }
});

test('J2 featureSweepProblems: push on needs 30 s on BOTH services; the switch must match; off enforces nothing', () => {
  const f = gate.featureSweepProblems;
  assert.deepEqual(f({}, {}), []);
  assert.deepEqual(f({ PUSH_ENABLED: 'false' }, { PUSH_ENABLED: 'false' }), []);
  // Review J2-1 (fail closed): anything but exactly true / false is refused, never silently read as off.
  for (const bad of ['TRUE', '1', 'yes', ' true', 'true # on', '']) {
    assertRefused(f({ PUSH_ENABLED: bad }, { PUSH_ENABLED: bad }), /rab-api: PUSH_ENABLED must be exactly true or false/);
    assertRefused(f({ PUSH_ENABLED: 'false' }, { REALTIME_ENABLED: bad }), /rab-worker: REALTIME_ENABLED must be exactly true or false/);
  }
  const on = { PUSH_ENABLED: 'true' };
  assertRefused(f(on, on), /rab-api: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30" committed in the compose files \(owner rule 2026-11-06\); it is ""/);
  assertRefused(f(on, on), /rab-worker: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30"/);
  assertRefused(f({ ...on, WORKER_PUSH_DISPATCH_INTERVAL_SECONDS: '30' }, { ...on, WORKER_PUSH_DISPATCH_INTERVAL_SECONDS: '2' }), /rab-worker: PUSH_ENABLED=true needs .*it is "2"/);
  assertRefused(f(on, {}), /PUSH_ENABLED differs between rab-api and rab-worker/);
  assert.deepEqual(f({ ...on, WORKER_PUSH_DISPATCH_INTERVAL_SECONDS: '30' }, { ...on, WORKER_PUSH_DISPATCH_INTERVAL_SECONDS: '30' }), []);
  const rt = { REALTIME_ENABLED: 'true' };
  assertRefused(f({ ...rt, WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS: '2' }, { ...rt, WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS: '10' }), /REALTIME_ENABLED=true: WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS differs between rab-api and rab-worker/);
  assertRefused(f({ ...rt, WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS: '5' }, rt), /WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS differs/);
  assert.deepEqual(f(rt, rt), []); // unset on both = the same 2 s default on both (the value itself is the owner's decision)
  assertRefused(f(rt, {}), /REALTIME_ENABLED differs between rab-api and rab-worker/);
});

test('J2: the push and realtime sweep intervals are never accepted from an env file', () => {
  for (const key of ['WORKER_PUSH_DISPATCH_INTERVAL_SECONDS', 'WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS']) {
    for (const value of ['2', '30']) {
      assertRefused(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout\n${key}=${value}`), new RegExp(`${key}: commit it in the compose files on rab-api and rab-worker`));
    }
  }
  // The switches themselves stay runtime.env values (off by default; turning one on is the owner's decision).
  assert.deepEqual(lintEnvText('runtime', 'CREWFLOW_AUDIT_SINK=stdout\nPUSH_ENABLED=false\nREALTIME_ENABLED=false'), []);
});

// Review of #97, finding J2-1: switch values are read the way Docker Compose reads them, and anything but true/false fails closed.
test('J2-1: composeEnvValue reads a value the way Docker Compose does (quotes, inline # comments); ambiguous → null', () => {
  const v = gate.composeEnvValue;
  assert.equal(v('true # on'), 'true');
  assert.equal(v('true\t# on'), 'true');
  assert.equal(v('"true"'), 'true');
  assert.equal(v("'true' # on"), 'true');
  assert.equal(v('"true" # on'), 'true');
  assert.equal(v('  false  '), 'false');
  assert.equal(v('a#b'), 'a#b'); // a # not preceded by a blank is part of the value
  assert.equal(v('"a # b"'), 'a # b'); // inside quotes it is not a comment
  assert.equal(v('"true'), null); // unterminated quote
  assert.equal(v('"true" yes'), null); // text after the closing quote
  const verifier = require('../staging/verify-image-compose.cjs');
  for (const raw of ['true # on', '"true"', "'true' # x", 'a#b', '"a # b"', '"true', '"true" yes', '', 'yes']) assert.equal(verifier.composeEnvValue(raw), v(raw), raw);
});

test('J2-1: lintEnvText refuses a switch that is not exactly true or false once read as Compose reads it', () => {
  for (const line of ['PUSH_ENABLED=yes', 'PUSH_ENABLED=TRUE', 'PUSH_ENABLED=1', 'PUSH_ENABLED=', 'PUSH_ENABLED="true', 'PUSH_ENABLED="true" x', 'REALTIME_ENABLED=on # enabled']) {
    assertRefused(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout\n${line}`), /(PUSH|REALTIME)_ENABLED: must be exactly true or false/);
  }
  for (const line of ['PUSH_ENABLED=false # off for now', 'PUSH_ENABLED="false"', "REALTIME_ENABLED='false'", 'export PUSH_ENABLED=false']) {
    assert.deepEqual(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout\n${line}`), [], line);
  }
  // parseEnvText now gives every rule the value Compose gives the app.
  const [entry] = gate.parseEnvText('PUSH_ENABLED=true # on');
  assert.deepEqual([entry.key, entry.value, entry.unreadable], ['PUSH_ENABLED', 'true', false]);
  assert.equal(gate.parseEnvText('PUSH_ENABLED="true')[0].unreadable, true);
});
