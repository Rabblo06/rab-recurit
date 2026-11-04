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
  assert.match(forbiddenReason('CREWFLOW_MIGRATION_APPROVED'), /run -e/);
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

test('database env: the approval token is refused, with the run -e reason', () => {
  assertRefused(lintEnvText('database', `${DATABASE_OK}\nCREWFLOW_MIGRATION_APPROVED=pending-1-${'a'.repeat(64)}`), /CREWFLOW_MIGRATION_APPROVED: .*run -e/);
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

test('compose env: interpolation values only, digests, never a secret, never every interface', () => {
  const ok = `CREWFLOW_API_IMAGE_DIGEST=sha256:${'a'.repeat(64)}\nCREWFLOW_REDIS_IMAGE=redis@sha256:${'b'.repeat(64)}\nCREWFLOW_SECRETS_DIR=/etc/crewflow/secrets`;
  assert.deepEqual(lintEnvText('compose', ok), []);
  assertRefused(lintEnvText('compose', 'CREWFLOW_REDIS_IMAGE=redis:7-alpine'), /not pinned by digest/);
  assertRefused(lintEnvText('compose', 'CREWFLOW_API_IMAGE_DIGEST=latest'), /not a sha256/);
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
    for (const svc of ['rab-api', 'rab-worker', 'rab-migrate']) s[svc].environment = { ...s[svc].environment, PG_DATABASE_URL: 'postgresql://postgres:x@rab-postgres:5432/crewflow?sslmode=verify-full' };
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
  for (const svc of ['rab-api', 'rab-worker', 'rab-migrate']) {
    assertRefused(problemsAfter((s) => { delete s[svc].depends_on['rab-postgres']; }), new RegExp(`${svc}: does not wait for a healthy rab-postgres`));
    assertRefused(problemsAfter((s) => { delete s[svc].networks['crewflow-db']; }), new RegExp(`${svc}: is not on the crewflow-db network`));
  }
});
