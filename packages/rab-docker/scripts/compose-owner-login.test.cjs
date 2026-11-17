'use strict';
/**
 * Tests for compose-owner-login.cjs: env-file lint, raw-text lint, and the bundled-database (STATIC mode) rules.
 *
 *   node --test packages/rab-docker/scripts/compose-owner-login.test.cjs
 *
 * The rendered-model cases render docker-compose.image.yml (with its bundled `db`, DB-SETUP) once with `docker compose`
 * (they report as skipped without it; CI requires it), then mutate a COPY, so each proves one specific refusal. The FULL-mode
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
// DB-SETUP: PG_DATABASE_URL is a compose.env interpolation value now, never a database.env entry.
const DATABASE_OK = [
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

// rab-ops removal (PR 2, plan §2.6): the separated operations container is gone, but every one of its variables stays
// refused, by exact name and as a whole family, in a rendered service and in every env file.
const RETIRED_OPS_NAMES = Object.freeze([
  'CREWFLOW_OPS_RUN', 'PG_OPS_APP_DATABASE_URL', 'CREWFLOW_OPS_ACTOR_SOURCE', 'CREWFLOW_OPS_ACTOR_ID', 'CREWFLOW_OPS_CHANGE_REF',
]);

test('DENIAL: every retired ops variable (PG_OPS_* / CREWFLOW_OPS_*) is still refused, including unknown family members', () => {
  for (const name of RETIRED_OPS_NAMES) assert.ok(forbiddenReason(name), `${name} must be refused`);
  // The family pattern catches every name, not only the five known ones.
  for (const name of [...RETIRED_OPS_NAMES.filter((n) => n.startsWith('CREWFLOW_OPS_')), 'CREWFLOW_OPS_ANYTHING_NEW', 'PG_OPS_SOMETHING']) {
    assert.match(forbiddenReason(name), /retired separated-mode operations variable/, name);
  }
});

test('DENIAL: an env file carrying any retired ops variable fails the env-file lint (database, runtime and compose)', () => {
  for (const name of RETIRED_OPS_NAMES) {
    const value = name.endsWith('_URL') ? URL_OK : 'one-off';
    assertRefused(lintEnvText('database', `${DATABASE_OK}\n${name}=${value}`), new RegExp(`^${name}: `));
    assertRefused(lintEnvText('runtime', `${name}=${value}`), new RegExp(`^${name}: `));
    assertRefused(lintEnvText('compose', `${name}=${value}`), new RegExp(`^${name}: `));
  }
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

// DB-SETUP (T-1) + PR #125 option 2 + PG_ADMIN_URL (owner decision 2026-11-17): compose.env holds db-setup's inputs. Three
// modes: (a) the bundled db (PG_DATABASE_PASSWORD only); (b) CREWFLOW_BUNDLED_DB=0 + PG_ADMIN_URL (an admin login);
// (c) CREWFLOW_BUNDLED_DB=0 + PG_DATABASE_URL (crewflow_owner ONLY). PG_DATABASE_PASSWORD only in (a).
const COMPOSE_BASE = `CREWFLOW_IMAGE_TAG=sha256:${'a'.repeat(64)}\nCREWFLOW_REDIS_IMAGE=redis@sha256:${'b'.repeat(64)}\nCREWFLOW_SECRETS_DIR=/etc/crewflow/secrets`;
const COMPOSE_OK = `${COMPOSE_BASE}\nPG_DATABASE_PASSWORD=${'c'.repeat(64)}`;
const ADMIN_OK = URL_OK.replace('crewflow_owner', 'doadmin');
test('PG_ADMIN_URL modes: (a) bundled with PG_DATABASE_PASSWORD; (b) own db + PG_ADMIN_URL; (c) own db + a crewflow_owner PG_DATABASE_URL; no password in (b)/(c)', () => {
  assert.deepEqual(lintEnvText('compose', COMPOSE_OK), []);
  assert.deepEqual(lintEnvText('compose', `${COMPOSE_OK}\nCREWFLOW_BUNDLED_DB=1`), []);
  for (const login of ['postgres', 'neondb_owner', 'doadmin', 'someone_admin']) {
    assert.deepEqual(lintEnvText('compose', `${COMPOSE_BASE}\nCREWFLOW_BUNDLED_DB=0\nPG_ADMIN_URL=${URL_OK.replace('crewflow_owner', login)}`), [], login);
  }
  assert.deepEqual(lintEnvText('compose', `${COMPOSE_BASE}\nCREWFLOW_BUNDLED_DB=0\nPG_DATABASE_URL=${URL_OK}`), []);
  // The bundled db still running beside a URL stays accepted (an existing deployment's crewflow_owner on the bundled db, the
  // upgrade-with-data path; or an admin URL), with the bundled db's password.
  assert.deepEqual(lintEnvText('compose', `${COMPOSE_OK}\nPG_DATABASE_URL=${URL_OK}`), []);
  assert.deepEqual(lintEnvText('compose', `${COMPOSE_OK}\nPG_ADMIN_URL=${ADMIN_OK}`), []);
  for (const login of ['postgres', 'crewflow_owner']) {
    const dbUrl = URL_OK.replace('crewflow_owner', login).replace('db.internal.example', 'db');
    assert.deepEqual(lintEnvText('compose', `${COMPOSE_OK}\n${login === 'postgres' ? 'PG_ADMIN_URL' : 'PG_DATABASE_URL'}=${dbUrl}\nCREWFLOW_BUNDLED_DB=1`), [], login);
  }
});

test('DENIAL PG_ADMIN_URL: an admin login in PG_DATABASE_URL is refused ("renamed to PG_ADMIN_URL"), never reinterpreted; crewflow_owner in PG_ADMIN_URL; both at once', () => {
  for (const login of ['postgres', 'neondb_owner', 'doadmin', 'someone_admin']) {
    for (const base of [COMPOSE_OK, `${COMPOSE_BASE}\nCREWFLOW_BUNDLED_DB=0`]) {
      assertRefused(lintEnvText('compose', `${base}\nPG_DATABASE_URL=${URL_OK.replace('crewflow_owner', login)}`), /^PG_DATABASE_URL: is the app login and must log in as crewflow_owner; it is never an admin URL \(the admin URL was renamed to PG_ADMIN_URL/);
    }
  }
  assertRefused(lintEnvText('compose', `${COMPOSE_BASE}\nCREWFLOW_BUNDLED_DB=0\nPG_ADMIN_URL=${URL_OK}`), /^PG_ADMIN_URL: logs in as crewflow_owner, the app login: put that URL in PG_DATABASE_URL/);
  assertRefused(lintEnvText('compose', `${COMPOSE_BASE}\nCREWFLOW_BUNDLED_DB=0\nPG_ADMIN_URL=${ADMIN_OK}\nPG_DATABASE_URL=${URL_OK}`), /^PG_ADMIN_URL and PG_DATABASE_URL are both set/);
});

test('DENIAL no dummy password: PG_DATABASE_PASSWORD is required with the bundled db and refused with your own database', () => {
  assertRefused(lintEnvText('compose', COMPOSE_BASE), /^PG_DATABASE_PASSWORD: required for the bundled database/);
  assertRefused(lintEnvText('compose', `${COMPOSE_BASE}\nCREWFLOW_BUNDLED_DB=1`), /^PG_DATABASE_PASSWORD: required for the bundled database/);
  assertRefused(lintEnvText('compose', `${COMPOSE_BASE}\nPG_DATABASE_URL=${URL_OK}`), /^PG_DATABASE_PASSWORD: required for the bundled database/);
  assertRefused(lintEnvText('compose', `${COMPOSE_OK}\nCREWFLOW_BUNDLED_DB=0\nPG_ADMIN_URL=${ADMIN_OK}`), /^PG_DATABASE_PASSWORD: remove it with CREWFLOW_BUNDLED_DB=0/);
  assertRefused(lintEnvText('compose', `${COMPOSE_OK}\nCREWFLOW_BUNDLED_DB=0\nPG_DATABASE_URL=${URL_OK}`), /^PG_DATABASE_PASSWORD: remove it with CREWFLOW_BUNDLED_DB=0/);
});

test('DENIAL bundled db switch: 0 without your own database, any value but 0 or 1', () => {
  assertRefused(lintEnvText('compose', `${COMPOSE_BASE}\nCREWFLOW_BUNDLED_DB=0`), /^CREWFLOW_BUNDLED_DB: 0 \(no bundled db\) needs your own database in PG_ADMIN_URL or PG_DATABASE_URL/);
  assertRefused(lintEnvText('compose', `${COMPOSE_BASE}\nPG_DATABASE_URL=\nPG_ADMIN_URL=\nCREWFLOW_BUNDLED_DB=0`), /^CREWFLOW_BUNDLED_DB: 0 \(no bundled db\) needs your own database/);
  // Review F2: the bundled db's own host is not "your own database" (db would never start).
  for (const [key, login] of [['PG_ADMIN_URL', 'postgres'], ['PG_DATABASE_URL', 'crewflow_owner']]) {
    const dbUrl = URL_OK.replace('crewflow_owner', login).replace('db.internal.example', 'db');
    assertRefused(lintEnvText('compose', `${COMPOSE_BASE}\n${key}=${dbUrl}\nCREWFLOW_BUNDLED_DB=0`), /^CREWFLOW_BUNDLED_DB: 0 \(no bundled db\) needs your own database in PG_ADMIN_URL or PG_DATABASE_URL \(a host other than the bundled db\)/);
  }
  for (const v of ['2', '', 'false', 'no', '00', '-1', 'true', '"0"x']) {
    assertRefused(lintEnvText('compose', `${COMPOSE_OK}\nPG_DATABASE_URL=${URL_OK}\nCREWFLOW_BUNDLED_DB=${v}`), /^CREWFLOW_BUNDLED_DB: must be exactly 0 or 1/);
  }
});

test('DENIAL L1: a CREWFLOW_TEST_* seam is refused in every env file and as a container variable', () => {
  for (const name of ['CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS', 'CREWFLOW_TEST_OWNER_SETUP_ABORT', 'CREWFLOW_TEST_ANYTHING']) {
    assert.match(forbiddenReason(name), /a test seam/);
    assertRefused(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout\n${name}=1`), new RegExp(`${name}: a test seam`));
    assertRefused(lintEnvText('database', `${DATABASE_OK}\n${name}=1`), new RegExp(`${name}: a test seam`));
    assertRefused(lintEnvText('compose', `${COMPOSE_OK}\n${name}=1`), new RegExp(`${name}: a test seam`));
  }
});

test('DENIAL Twenty Helm model: a variable carrying the crewflow_owner password is refused in every env file', () => {
  for (const name of ['CREWFLOW_OWNER_PASSWORD', 'CREWFLOW_DB_OWNER_PASSWORD', 'CREWFLOW_DB_PASSWORD_FILE', 'PG_OWNER_PW']) {
    assert.match(forbiddenReason(name), /crewflow_owner password/);
    assertRefused(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout\n${name}=1`), new RegExp(`${name}: `));
    assertRefused(lintEnvText('database', `${DATABASE_OK}\n${name}=1`), new RegExp(`${name}: `));
    assertRefused(lintEnvText('compose', `${COMPOSE_OK}\n${name}=1`), new RegExp(`${name}: `));
  }
});

test('DENIAL N4: a CREWFLOW_MIGRATION_TEST_* seam is refused in every env file and as a container variable', () => {
  for (const name of ['CREWFLOW_MIGRATION_TEST_FAIL_AT', 'CREWFLOW_MIGRATION_TEST_ANYTHING']) {
    assert.match(forbiddenReason(name), /a migration test seam/);
    assertRefused(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout\n${name}=1`), new RegExp(`${name}: a migration test seam`));
    assertRefused(lintEnvText('database', `${DATABASE_OK}\n${name}=1`), new RegExp(`${name}: a migration test seam`));
    assertRefused(lintEnvText('compose', `${COMPOSE_OK}\n${name}=1`), new RegExp(`${name}: a migration test seam`));
  }
});

test('DENIAL PG_ADMIN_URL: the old name PG_DATABASE_ADMIN_URL is refused everywhere with "renamed to PG_ADMIN_URL"; PG_ADMIN_URL never in database.env / runtime.env', () => {
  assertRefused(lintEnvText('compose', `${COMPOSE_OK}\nPG_DATABASE_ADMIN_URL=${URL_OK.replace('crewflow_owner', 'doadmin')}`), /^PG_DATABASE_ADMIN_URL: renamed to PG_ADMIN_URL/);
  assert.match(forbiddenReason('PG_DATABASE_ADMIN_URL'), /^renamed to PG_ADMIN_URL/);
  for (const kind of ['database', 'runtime']) {
    assertRefused(lintEnvText(kind, `${kind === 'database' ? `${DATABASE_OK}\n` : 'CREWFLOW_AUDIT_SINK=stdout\n'}PG_DATABASE_ADMIN_URL=${ADMIN_OK}`), /^PG_DATABASE_ADMIN_URL: renamed to PG_ADMIN_URL/);
    // PG_ADMIN_URL in an app env file would hand the admin URL to rab-api / rab-worker.
    assertRefused(lintEnvText(kind, `${kind === 'database' ? `${DATABASE_OK}\n` : 'CREWFLOW_AUDIT_SINK=stdout\n'}PG_ADMIN_URL=${ADMIN_OK}`), /^PG_ADMIN_URL: set it in compose\.env .*rab-api \/ rab-worker refuse it/);
  }
  assertRefused(lintEnvText('compose', `${COMPOSE_OK}\nPG_DATABASE_ADMIN_URL=${URL_OK.replace('crewflow_owner', 'doadmin')}`), /PG_DATABASE_ADMIN_URL: holds a PostgreSQL URL/);
  for (const kind of ['database', 'runtime']) {
    assertRefused(lintEnvText(kind, `${kind === 'database' ? `${DATABASE_OK}\n` : 'CREWFLOW_AUDIT_SINK=stdout\n'}PG_DATABASE_ADMIN_URL=${URL_OK.replace('crewflow_owner', 'doadmin')}`), /PG_DATABASE_ADMIN_URL: (a second database URL|holds a PostgreSQL URL|does not belong)/);
  }
  // PG_DATABASE_URL in an env file: refused (it would reach rab-api / rab-worker, which refuse it).
  for (const kind of ['database', 'runtime']) {
    assertRefused(lintEnvText(kind, `${kind === 'database' ? `${DATABASE_OK}\n` : 'CREWFLOW_AUDIT_SINK=stdout\n'}PG_DATABASE_URL=${URL_OK}`), /PG_DATABASE_URL: set it in compose\.env/);
  }
});

test('DENIAL DB-SETUP compose env: the URL still needs verify-full, the direct host and a password; never a former separated login', () => {
  for (const login of ['crewflow_app', 'crewflow_migrator', 'crewflow_worker', 'crewflow', 'rab_app', 'rab_secure_owner']) {
    for (const key of ['PG_DATABASE_URL', 'PG_ADMIN_URL']) {
      assertRefused(lintEnvText('compose', `${COMPOSE_OK}\n${key}=${URL_OK.replace('crewflow_owner', login)}`), new RegExp(`^${key}: logs in as a former separated login or schema role`));
    }
  }
  for (const login of ['doadmin', 'crewflow_owner']) {
    const withUrl = (url) => `${COMPOSE_OK}\n${login === 'doadmin' ? 'PG_ADMIN_URL' : 'PG_DATABASE_URL'}=${url.replace('crewflow_owner', login)}`;
    assertRefused(lintEnvText('compose', withUrl(URL_OK.replace('verify-full', 'require'))), /sslmode is not verify-full/);
    assertRefused(lintEnvText('compose', withUrl(URL_OK.replace('?sslmode=verify-full', ''))), /sslmode is not verify-full/);
    assertRefused(lintEnvText('compose', withUrl(URL_OK.replace('db.internal.example', 'ep-x-pooler.eu.aws.neon.tech'))), /transaction pooler/);
    assertRefused(lintEnvText('compose', withUrl(URL_OK.replace(':5432', ':6543'))), /transaction pooler/);
    assertRefused(lintEnvText('compose', withUrl('postgresql://crewflow_owner@db.internal.example:5432/crewflow?sslmode=verify-full')), /no password/);
    assertRefused(lintEnvText('compose', withUrl('mysql://root:x@db.internal.example:3306/crewflow?sslmode=verify-full')), /not a postgres:\/\/ URL/);
    assertRefused(lintEnvText('compose', withUrl('not a url')), /not a parseable URL/);
  }
});

test('DENIAL DB-SETUP: PG_DATABASE_PASSWORD is a compose.env value only, URL-safe and long; never an env file or container variable', () => {
  assert.match(forbiddenReason('PG_DATABASE_PASSWORD'), /compose\.env only/);
  for (const kind of ['database', 'runtime']) {
    assertRefused(lintEnvText(kind, `${kind === 'database' ? `${DATABASE_OK}\n` : 'CREWFLOW_AUDIT_SINK=stdout\n'}PG_DATABASE_PASSWORD=${'c'.repeat(64)}`), /PG_DATABASE_PASSWORD: an interpolation value of compose\.env only/);
  }
  for (const bad of ['short', `${'c'.repeat(40)}@x`, `${'c'.repeat(40)}/x`, `${'c'.repeat(40)}%41`, '']) {
    assertRefused(lintEnvText('compose', COMPOSE_OK.replace(`PG_DATABASE_PASSWORD=${'c'.repeat(64)}`, `PG_DATABASE_PASSWORD=${bad}`)), /PG_DATABASE_PASSWORD: must be at least 32 URL-safe characters/);
  }
  // Every other secret-like or non-CREWFLOW_ name stays refused in compose.env.
  assertRefused(lintEnvText('compose', 'PG_DATABASE_REPLICA_URL=postgresql://a:b@h:5432/d?sslmode=verify-full'), /replica/);
  assertRefused(lintEnvText('compose', 'CREWFLOW_DB_URL=postgresql://a:b@h:5432/d?sslmode=verify-full'), /secret-like name|URL with credentials/);
  assertRefused(lintEnvText('compose', 'PGPASSWORD=x'), /libpq/);
});

test('DENIAL DB-SETUP: PG_DATABASE_URL in database.env or runtime.env is refused (the committed default would silently override it)', () => {
  for (const kind of ['database', 'runtime']) {
    assertRefused(lintEnvText(kind, `${kind === 'database' ? `${DATABASE_OK}\n` : 'CREWFLOW_AUDIT_SINK=stdout\n'}PG_DATABASE_URL=${URL_OK}`), /PG_DATABASE_URL: set it in compose\.env/);
  }
});

test('runtime env: PG_DATABASE_URL is refused there (compose.env only)', () => {
  assertRefused(lintEnvText('runtime', `PG_DATABASE_URL=${URL_OK}`), /set it in compose\.env/);
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
  for (const mode of ['none', 'token']) assert.deepEqual(lintEnvText('compose', `${COMPOSE_OK}\nCREWFLOW_MIGRATION_APPROVAL_MODE=${mode}`), []);
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

test('O3 / Part B3: the removed upgrade-failure choices, the scheduler keys and the start-up flag', () => {
  for (const v of ['continue', 'refuse']) {
    for (const kind of ['runtime', 'database']) assertRefused(lintEnvText(kind, `${kind === 'database' ? `${DATABASE_OK}\n` : ''}CREWFLOW_UPGRADE_FAILURE=${v}`), /removed \(OWNER-DB-ULTIMATE Part B3\)/);
  }
  assertRefused(lintEnvText('runtime', 'CREWFLOW_UPGRADE_FAILURE_POLICY=refuse'), /removed \(OWNER-DB-ULTIMATE Part B3\)/);
  assertRefused(lintEnvText('runtime', 'CREWFLOW_UPGRADE_INCOMPLETE=Beta1'), /retired with the C3 continue path/);
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
  // X3.1: strict (exactly true / false; a typo refuses to boot), default still false.
  assert.match(vars, /@Transform\(\(\{ value \}\) => strictBoolean\(value\)\)\s*@IsBoolean\(\{ message: STRICT_BOOLEAN_MESSAGE \}\)\s*WORKER_FAST_PUBLISH_NOTIFY: boolean = false;/);
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
  const ok = COMPOSE_OK;
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
  assertRefused(lintEnvText('compose', 'CREWFLOW_PG_CA_FILE=postgresql://a:b@h/d'), /URL with credentials/);
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

test('image (bundled db): the committed file passes the bundled-database rules', { skip }, () => {
  assert.deepEqual(checkStaticModel(fresh()), []);
});

test('DENIAL bundled db: hardening keys, digest, no port, health check', { skip }, () => {
  assertRefused(problemsAfter((s) => { s.db.read_only = false; }), /db: read_only/);
  assertRefused(problemsAfter((s) => { s.db.user = '0:0'; }), /db: user "0:0" is root/);
  assertRefused(problemsAfter((s) => { delete s.db.user; }), /db: no explicit user/);
  assertRefused(problemsAfter((s) => { s.db.cap_add = ['CHOWN']; }), /adds capabilities/);
  assertRefused(problemsAfter((s) => { s.db.cap_drop = []; }), /db: cap_drop ALL is missing/);
  assertRefused(problemsAfter((s) => { s.db.security_opt = []; }), /db: security_opt no-new-privileges/);
  assertRefused(problemsAfter((s) => { s.db.image = 'postgres:16'; }), /not pinned by digest/);
  assertRefused(problemsAfter((s) => { s.db.image = `someone/postgres@sha256:${'1'.repeat(64)}`; }), /official postgres repository/);
  assertRefused(problemsAfter((s) => { s.db.ports = [{ target: 5432, host_ip: '127.0.0.1', published: '5432' }]; }), /db: publishes a port/);
  assertRefused(problemsAfter((s) => { delete s.db.healthcheck; }), /db: no health check/);
  assertRefused(problemsAfter((s) => { s.db.healthcheck.test = ['CMD-SHELL', 'pg_isready -q -h /var/run/postgresql']; }), /pg_isready over TCP/);
  assertRefused(problemsAfter((s) => { delete s.db.pids_limit; }), /db: pids_limit/);
  assertRefused(problemsAfter((s) => { s.db.restart = 'no'; }), /db: restart/);
});

test('DENIAL bundled db: password only from PG_DATABASE_PASSWORD (T-2), never trust, superuser never the app login, no URL, TLS made by itself', { skip }, () => {
  assertRefused(problemsAfter((s) => { s.db.environment.POSTGRES_USER = 'crewflow_owner'; }), /superuser is the app login/);
  assertRefused(problemsAfter((s) => { s.db.environment.POSTGRES_PASSWORD = 'postgres'; }), /POSTGRES_PASSWORD must be exactly/);
  assertRefused(problemsAfter((s) => { delete s.db.environment.POSTGRES_PASSWORD; }), /POSTGRES_PASSWORD must be exactly/);
  assertRefused(problemsAfter((s) => { s.db.environment.POSTGRES_PASSWORD_FILE = '/run/secrets/x'; }), /POSTGRES_PASSWORD_FILE/);
  assertRefused(problemsAfter((s) => { s.db.environment.POSTGRES_HOST_AUTH_METHOD = 'trust'; }), /trust/);
  // PR #125 finding 6: any value of the switch is refused, and the environment is an exact allow-list.
  assertRefused(problemsAfter((s) => { s.db.environment.POSTGRES_HOST_AUTH_METHOD = 'scram-sha-256'; }), /POSTGRES_HOST_AUTH_METHOD is set/);
  assertRefused(problemsAfter((s) => { s.db.environment.POSTGRES_INITDB_WALDIR = '/x'; }), /environment has POSTGRES_INITDB_WALDIR \(only/);
  assertRefused(problemsAfter((s) => { s.db.environment.POSTGRES_USER = 'admin'; }), /POSTGRES_USER must be postgres/);
  assertRefused(problemsAfter((s) => { s.db.environment.POSTGRES_DB = 'other'; }), /POSTGRES_DB must be crewflow/);
  assertRefused(problemsAfter((s) => { s.db.environment.HOME = '/var/lib/postgresql'; }), /HOME must be \/tmp/);
  // PR #125 finding 5: TLS-only network logins from the pg_hba.conf the entrypoint writes.
  assertRefused(problemsAfter((s) => { s.db.command = s.db.command.filter((t) => !t.startsWith('hba_file=')); }), /does not read the TLS-only pg_hba\.conf/);
  assertRefused(problemsAfter((s) => { s.db.entrypoint = s.db.entrypoint.map((t) => t.replace('hostssl all all 0.0.0.0/0', 'host all all 0.0.0.0/0')); }), /does not write exactly the TLS-only pg_hba\.conf/);
  assertRefused(problemsAfter((s) => { s.db.entrypoint = s.db.entrypoint.map((t) => t.replace('exec docker-entrypoint.sh', "echo 'host all all all trust' >> x\n        exec docker-entrypoint.sh")); }), /does not write exactly the TLS-only pg_hba\.conf/);
  // Security review of F2, M1: the one-server-per-volume lock, present and taken first.
  const noLock = /does not take the one-server lock/;
  assertRefused(problemsAfter((s) => { s.db.entrypoint = s.db.entrypoint.map((t) => t.replace(/ *flock -n 8 [^\n]*\n/, '')); }), noLock);
  assertRefused(problemsAfter((s) => { s.db.entrypoint = s.db.entrypoint.map((t) => t.replace('flock -n 8', 'flock 8')); }), noLock);
  assertRefused(problemsAfter((s) => { s.db.entrypoint = s.db.entrypoint.map((t) => t.replace('/var/lib/postgresql/.crewflow-server.lock', '/tmp/x.lock')); }), noLock);
  assertRefused(
    problemsAfter((s) => {
      s.db.entrypoint = s.db.entrypoint.map((t) => {
        const m = t.match(/ *exec 8>[^\n]*\n *flock -n 8[^\n]*\n/);
        return m ? t.replace(m[0], '').replace('exec docker-entrypoint.sh', `${m[0].trimStart()}exec docker-entrypoint.sh`) : t;
      });
    }),
    noLock,
  );
  assertRefused(problemsAfter((s) => { s.db.environment.POSTGRES_INITDB_ARGS = '--auth-host=trust'; }), /trust/);
  assertRefused(problemsAfter((s) => { s.db.environment.PG_DATABASE_URL = 'postgresql://postgres:x@db:5432/crewflow'; }), /db: has PG_DATABASE_URL/);
  assertRefused(problemsAfter((s) => { s.db.environment.PGPASSWORD = 'x'; }), /db: environment has PGPASSWORD/);
  assertRefused(problemsAfter((s) => { s.db.environment.PGDATA = '/var/lib/postgresql/data'; }), /PGDATA must be/);
  assertRefused(problemsAfter((s) => { s.db.environment.PGDATA = '/var/lib/postgresql/18/docker'; }), /PGDATA must be/);
  assertRefused(problemsAfter((s) => { delete s.db.environment.PGDATA; }), /PGDATA is not set/);
  // Area 6 note (T-3 tightened): SCRAM for socket and TCP, never trust / peer.
  for (const args of ['--auth-local=peer --data-checksums', '--auth-local=scram-sha-256 --data-checksums', '--auth-host=scram-sha-256', '--auth-local=scram-sha-256 --auth-host=scram-sha-256 --auth-local=peer', '--auth-local=scram-sha-256 --auth-host=md5', '']) {
    assertRefused(problemsAfter((s) => { s.db.environment.POSTGRES_INITDB_ARGS = args; }), /POSTGRES_INITDB_ARGS must be exactly/);
  }
  assertRefused(problemsAfter((s) => { s.db.environment.POSTGRES_INITDB_ARGS = '--auth=trust'; }), /trust/);
  assertRefused(problemsAfter((s) => { s.db.tmpfs = s.db.tmpfs.filter((t) => !t.startsWith('/var/lib/postgresql/data')); }), /not an empty read-only tmpfs/);
  assertRefused(problemsAfter((s) => { s.db.command = s.db.command.filter((t) => t !== 'ssl=on'); }), /TLS is not on/);
  assertRefused(problemsAfter((s) => { s.db.command = s.db.command.map((t) => t.replace('/tls/server.key', '/other.key')); }), /certificate it makes itself/);
  assertRefused(problemsAfter((s) => { delete s.db.entrypoint; }), /create its own CA/);
  assertRefused(problemsAfter((s) => { s.db.entrypoint = s.db.entrypoint.map((t) => t.replace('rm -f ca.key', 'rm -f ca.srl')); }), /CA key deleted/);
  assertRefused(problemsAfter((s) => { s.db.volumes.push({ type: 'bind', source: '/x/01-crewflow-owner.sql', target: '/docker-entrypoint-initdb.d/01.sql', read_only: true }); }), /mounts an init script/);
});

test('DENIAL bundled db: internal network only, its own volumes, rab-api waits for it, the app mounts only its CA read-only', { skip }, () => {
  assertRefused(problemsAfter((s) => { s.db.networks.default = null; }), /internal crewflow-db network only/);
  assertRefused(problemsAfter((s, m) => { m.networks['crewflow-db'].internal = false; }), /crewflow-db is not internal/);
  assertRefused(problemsAfter((s) => { s.db.volumes = s.db.volumes.filter((v) => v.target !== '/var/lib/postgresql'); }), /crewflow-db-data at \/var\/lib\/postgresql is missing/);
  assertRefused(problemsAfter((s) => { s.db.volumes = s.db.volumes.filter((v) => v.target !== '/var/tmp'); }), /crewflow-db-ca at \/var\/tmp is missing/);
  assertRefused(problemsAfter((s) => { s.db.volumes.find((v) => v.target === '/var/tmp').source = 'other'; }), /db: unexpected named volume/);
  // The pre-fix layout (data on /var/lib/postgresql/data: root-owned on postgres:18, so the db cannot start there).
  assertRefused(problemsAfter((s) => { s.db.volumes.find((v) => v.target === '/var/lib/postgresql').target = '/var/lib/postgresql/data'; }), /db: unexpected named volume at \/var\/lib\/postgresql\/data/);
  assertRefused(problemsAfter((s) => { delete s['rab-api'].depends_on.db; }), /rab-api: does not wait for a healthy db/);
  for (const svc of ['rab-api', 'rab-worker']) {
    assertRefused(problemsAfter((s) => { delete s[svc].networks['crewflow-db']; }), new RegExp(`${svc}: is not on the crewflow-db network`));
    assertRefused(problemsAfter((s) => { s[svc].volumes.find((v) => v.source === 'crewflow-db-ca').read_only = false; }), new RegExp(`${svc}: (the bundled db's CA volume must be mounted read-only|does not mount)`));
    assertRefused(problemsAfter((s) => { s[svc].volumes = s[svc].volumes.filter((v) => v.source !== 'crewflow-db-ca'); }), new RegExp(`${svc}: does not mount the bundled db's CA`));
    assertRefused(problemsAfter((s) => { s[svc].volumes.push({ type: 'volume', source: 'crewflow-db-data', target: '/x', read_only: true }); }), new RegExp(`${svc}: (mounts the bundled db's data volume|unexpected named volume)`));
  }
  assertRefused(problemsAfter((s) => { delete s.db; }), /db: missing/);
  // PR #124's any-profile rule: the committed db has none; a profiled db is refused.
  assert.equal(fresh().services.db.profiles, undefined);
  assertRefused(problemsAfter((s) => { s.db.profiles = ['db']; }), /db: has profiles/);
});

test('SJ-05: the gate and production env validation refuse the same claim / dispatch switches (two layers, one rule)', () => {
  // The gate refuses the names in every compose and env file.
  for (const name of ['WORKER_CLAIM_MODE', 'WORKER_DISPATCH_MODE']) assert.ok(forbiddenReason(name), name);
  // Env validation refuses global claims and event dispatch in production (re-read from the TypeScript source).
  const validation = fs.readFileSync(path.join(__dirname, '../../rab-server/src/engine/core-modules/environment/env.validation.ts'), 'utf8');
  // assert.ok, not assert.match: a failure must not print the whole source file.
  assert.ok(/export const WORKER_GLOBAL_CLAIMS_PRODUCTION_APPROVED = false as boolean;/.test(validation), 'env.validation.ts lacks WORKER_GLOBAL_CLAIMS_PRODUCTION_APPROVED = false');
  assert.ok(/env\.WORKER_CLAIM_MODE === 'global'/.test(validation), 'env.validation.ts does not refuse WORKER_CLAIM_MODE=global in production');
  assert.ok(/env\.WORKER_DISPATCH_MODE === 'event'/.test(validation), 'env.validation.ts does not refuse WORKER_DISPATCH_MODE=event in production');
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
    // X3.1: strictBoolean (exactly true / false), the same values SWITCH_VALUES accepts.
    assert.match(vars, new RegExp(`@Transform\\(\\(\\{ value \\}\\) => strictBoolean\\(value\\)\\)\\s*@IsBoolean\\(\\{ message: STRICT_BOOLEAN_MESSAGE \\}\\)\\s*${flag}: boolean = false;`), flag);
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

// Phase X3.1 (XR-05 / ENV-01): the app now refuses a non-boolean on/off switch at boot, so the gate refuses it first.
test('X3.1: lintEnvText refuses a strict on/off switch that is not exactly true or false; empty keeps the default', () => {
  const app = ['EMAIL_DELIVERY_ENABLED', 'AUTH_CONTEXT_CACHE_ENABLED', 'USER_SESSION_CACHE_ENABLED', 'CORE_ENTITY_CACHE_ENABLED',
    'WORKSPACE_METADATA_CACHE_ENABLED', 'WORKER_FAST_PUBLISH_NOTIFY', 'USER_SESSION_ENFORCEMENT_CUTOVER', 'AUTH_PASSWORD_ENABLED',
    'AUTH_GOOGLE_ENABLED', 'AUTH_MICROSOFT_ENABLED', 'AUTH_OAUTH_HANDOFF_ENABLED', 'EMAIL_SMTP_NO_TLS', 'REALTIME_ENABLED', 'PUSH_ENABLED'];
  assert.deepEqual([...gate.X31_SWITCHES].sort(), [...app].sort());
  for (const key of app) assert.ok(gate.STRICT_SWITCHES.includes(key), key);
  for (const key of gate.STRICT_SWITCHES.filter((k) => !Object.hasOwn(gate.FEATURE_SWEEPS, k))) {
    for (const value of ['True', 'TRUE', '1', '0', 'yes', 'on', 'flase', '"true', '"true" x']) {
      const problems = lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout\n${key}=${value}`);
      assertRefused(problems, new RegExp(`${key}: must be exactly true or false \\(X3\\.1`));
      for (const msg of problems) assert.ok(!msg.includes('flase'), msg); // names only, never the value
    }
    for (const value of ['true', 'false', '', '"false"', 'true # on']) {
      // (WORKER_FAST_PUBLISH_NOTIFY is also refused in an env file for being committed; that rule is not under test here.)
      const problems = lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout\n${key}=${value}`);
      assert.deepEqual(problems.filter((msg) => /X3\.1/.test(msg)), [], `${key}=${value}`);
    }
  }
});

test('X3.1: strictSwitchProblems checks what each service receives (names only, never a value)', () => {
  assert.deepEqual(gate.strictSwitchProblems('rab-api', { EMAIL_DELIVERY_ENABLED: 'true', AUTH_GOOGLE_ENABLED: 'false', EMAIL_SMTP_NO_TLS: '' }), []);
  assert.deepEqual(gate.strictSwitchProblems('rab-worker', undefined), []);
  const problems = gate.strictSwitchProblems('rab-worker', { USER_SESSION_ENFORCEMENT_CUTOVER: 'True', WORKER_FAST_PUBLISH_NOTIFY: '1' });
  assert.equal(problems.length, 2);
  assertRefused(problems, /rab-worker: USER_SESSION_ENFORCEMENT_CUTOVER must be exactly true or false/);
  assertRefused(problems, /rab-worker: WORKER_FAST_PUBLISH_NOTIFY must be exactly true or false/);
  // PUSH_ENABLED / REALTIME_ENABLED are featureSweepProblems' job (one message, not two).
  assert.deepEqual(gate.strictSwitchProblems('rab-api', { PUSH_ENABLED: 'yes' }), []);
  // An already-strict switch from before X3.1 is checked too (the list is read from environment-variables.ts).
  assertRefused(gate.strictSwitchProblems('rab-api', { AUTH_MFA_ENFORCE_PLATFORM_ADMIN: 'True' }), /rab-api: AUTH_MFA_ENFORCE_PLATFORM_ADMIN must be exactly true or false/);
});

// Review of #169: the switch list is read from environment-variables.ts, never retyped.
test('X3.1: STRICT_SWITCHES equals an independent scan of environment-variables.ts (every strictBoolean property, plus HWS)', () => {
  const source = fs.readFileSync(gate.ENVIRONMENT_VARIABLES_TS, 'utf8');
  // A different method from the gate's: one multi-line regex over the whole file (decorators may sit between the
  // transform and the property).
  const re = /@Transform\(\(\{ value(?:, obj)? \}\) => (?:strictBoolean\(value\)|resolveHwsRuntimeEnabled\([^\n]*)\)[^\n]*\n(?:[ \t]*@[^\n]*\n)*[ \t]*([A-Z][A-Z0-9_]*)[?!]?\s*:/g;
  const independent = [...source.matchAll(re)].map((m) => m[1]).sort();
  assert.deepEqual([...gate.STRICT_SWITCHES], independent);
  // The switches that were strict before X3.1 are linted now as well.
  for (const key of ['APP_JWT_LEGACY_VERIFY_ENABLED', 'AUTH_MFA_ENROLMENT_ENABLED', 'AUTH_MFA_ENFORCE_PLATFORM_ADMIN', 'AUTH_MFA_ENFORCE_ORGANISATION_OWNER',
    'AUTH_MFA_ENFORCE_INITIAL_MANAGER', 'AUTH_MFA_ENFORCE_OTHER_WEB_USERS', 'WORKSPACE_HOST_ROUTING_ENABLED', 'S3_FORCE_PATH_STYLE', 'HWS_RUNTIME_ENABLED']) {
    assert.ok(gate.STRICT_SWITCHES.includes(key), key);
  }
  // AI_AGENTS_ENABLED stays loose on purpose (any value but true is off, never a boot refusal): never linted.
  assert.ok(!gate.STRICT_SWITCHES.includes('AI_AGENTS_ENABLED'));
  // Every strictBoolean transform in the file is accounted for (no property the scan could not attach to).
  assert.equal(independent.length, (source.match(/@Transform\(\(\{ value \}\) => strictBoolean\(value\)\)/g) ?? []).length + 1);
  // The scan is pure and attaches a transform to the next property only.
  assert.deepEqual(gate.scanStrictSwitches("  @Type(() => String)\n  @Transform(({ value }) => strictBoolean(value))\n  @IsBoolean()\n  A_ON: boolean = false;\n  B_LOOSE?: string;\n"), ['A_ON']);
});

test('PR #125 finding 6: bundledDbEnvironmentProblems (shared with the deployed-model check) accepts the committed env and a real-shaped password', () => {
  const ok = { POSTGRES_USER: 'postgres', POSTGRES_DB: 'crewflow', POSTGRES_PASSWORD: 'a'.repeat(64), POSTGRES_INITDB_ARGS: gate.DB_INITDB_ARGS, PGDATA: '/var/lib/postgresql/pgdata', HOME: '/tmp' };
  assert.deepEqual(gate.bundledDbEnvironmentProblems(ok), []);
  assertRefused(gate.bundledDbEnvironmentProblems({ ...ok, POSTGRES_PASSWORD: 'short' }), /POSTGRES_PASSWORD is missing or not 32\+ URL-safe/);
  assertRefused(gate.bundledDbEnvironmentProblems({ ...ok, POSTGRES_PASSWORD: '' }), /POSTGRES_PASSWORD is missing/);
  for (const msg of gate.bundledDbEnvironmentProblems({ ...ok, POSTGRES_PASSWORD: 'Kq7-unique-marker' })) assert.ok(!msg.includes('Kq7-unique-marker'), msg);
});

test('ADMIN_URL_PLACEMENT (owner requirement 2026-11-17): every committed compose file keeps PG_ADMIN_URL on db-setup only', () => {
  const files = gate.composeFilesInRepo();
  assert.ok(files.length >= 10, `found ${files.length} compose files`);
  for (const rel of ['docker-compose.production.yml', 'docker-compose.image.yml', 'docker-compose.yml', 'docker-compose.qa.yml']) {
    assert.ok(files.some((f) => f.endsWith(path.join('rab-docker', rel))), rel);
  }
  for (const file of files) assert.deepEqual(gate.adminUrlPlacementProblems(file, fs.readFileSync(file, 'utf8')), [], file);
  // The deploy files do interpolate it, on db-setup, exactly once.
  for (const rel of ['docker-compose.production.yml', 'docker-compose.image.yml']) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.equal(text.split('\n').filter((l) => !/^\s*#/.test(l) && l.includes('${PG_ADMIN_URL')).length, 1, rel);
  }
});

test('DENIAL ADMIN_URL_PLACEMENT: PG_ADMIN_URL with a value on rab-api / rab-worker (map, list or flow form), in an x- anchor merged into them, an anchor inside db-setup, or the old names, fails the static gate', () => {
  const setup = 'services:\n  db-setup:\n    environment:\n      PG_ADMIN_URL: ${PG_ADMIN_URL:-}\n';
  const pinned = `${setup}  rab-api:\n    environment:\n      PG_ADMIN_URL: ""\n  rab-worker:\n    environment:\n      PG_ADMIN_URL: ''\n`;
  assert.deepEqual(gate.adminUrlPlacementProblems('ok.yml', setup), []);
  // Owner decision L-2: the exact empty pin on rab-api / rab-worker is the one allowed occurrence outside db-setup.
  assert.deepEqual(gate.adminUrlPlacementProblems('ok.yml', pinned), []);
  // L-3: anchored, tagged and merge-key service headers are still read as service headers.
  for (const header of ['rab-api: &api', 'rab-api: !override', 'rab-api: <<']) {
    assert.deepEqual(gate.adminUrlPlacementProblems('ok.yml', `${setup}  ${header}\n    environment:\n      PG_ADMIN_URL: ""\n`), [], header);
  }
  const cases = [
    [`${setup}  rab-api:\n    environment:\n      PG_ADMIN_URL: x\n`, /PG_ADMIN_URL in service rab-api/],
    [`${setup}  rab-worker:\n    environment:\n      - PG_ADMIN_URL=postgres://a:b@h/d\n`, /PG_ADMIN_URL in service rab-worker/],
    [`${setup}  rab-worker:\n    environment:\n      - PG_ADMIN_URL=\n`, /PG_ADMIN_URL in service rab-worker/],
    [`${setup}  rab-worker:\n    environment:\n      X: \${PG_ADMIN_URL:-}\n`, /interpolated in service rab-worker/],
    // L-3: a flow mapping, the token anywhere on the line.
    [`${setup}  rab-api:\n    environment: { NODE_ENV: production, PG_ADMIN_URL: x }\n`, /PG_ADMIN_URL in service rab-api/],
    [`${setup}  rab-api:\n    environment: { PG_ADMIN_URL: "" }\n`, /PG_ADMIN_URL in service rab-api/],
    // An x- anchor merged into rab-api (the empty pin is allowed only in the service itself).
    [`x-env: &e\n  PG_ADMIN_URL: \${PG_ADMIN_URL:-}\n${setup}  rab-api:\n    environment:\n      <<: *e\n`, /PG_ADMIN_URL in top-level x-env/],
    [`x-env: &e\n  PG_ADMIN_URL: ""\n${setup}  rab-api:\n    environment:\n      <<: *e\n`, /PG_ADMIN_URL in top-level x-env/],
    // L-3: an anchor defined inside db-setup (its environment, or the service itself), aliased into rab-api.
    [`services:\n  db-setup:\n    environment: &setupenv\n      PG_ADMIN_URL: \${PG_ADMIN_URL:-}\n  rab-api:\n    environment:\n      <<: *setupenv\n`, /an anchor defined inside the db-setup service/],
    [`services:\n  db-setup: &setup\n    environment:\n      PG_ADMIN_URL: \${PG_ADMIN_URL:-}\n  rab-api:\n    <<: *setup\n`, /an anchor on the db-setup service/],
    // L-3: anchored / tagged headers of OTHER services do not hide them.
    [`${setup}  rab-api: &api\n    environment:\n      PG_ADMIN_URL: x\n`, /PG_ADMIN_URL in service rab-api/],
    [`${setup}  rab-worker: !reset\n    environment: { PG_ADMIN_URL: x }\n`, /PG_ADMIN_URL in service rab-worker/],
    [`${setup}  server:\n    environment:\n      PG_ADMIN_URL: ""\n`, /PG_ADMIN_URL in service server/],
    [`services:\n    db-setup:\n        environment:\n            PG_ADMIN_URL: x\n    rab-api:\n        environment:\n            PG_ADMIN_URL: x\n`, /PG_ADMIN_URL in service rab-api/],
    [`${setup}  db-setup2:\n    environment:\n      PG_DATABASE_ADMIN_URL: x\n`, /PG_DATABASE_ADMIN_URL \(renamed to PG_ADMIN_URL\)/],
    [`${setup}  rab-api:\n    environment: { X: "\${PG_DATABASE_ADMIN_URL}" }\n`, /PG_DATABASE_ADMIN_URL \(renamed to PG_ADMIN_URL\)/],
    [`${setup}  rab-api:\n    environment:\n      CREWFLOW_BUNDLED_DB_ADMIN_URL: x\n`, /CREWFLOW_BUNDLED_DB_ADMIN_URL in service rab-api/],
  ];
  for (const [text, pattern] of cases) assertRefused(gate.adminUrlPlacementProblems('bad.yml', text), pattern);
  // lintComposeText (the deploy files) runs the same rule, and refuses a `:?` on the bundled db's password.
  assertRefused(lintComposeText('bad.yml', `${setup}  rab-api:\n    environment:\n      PG_ADMIN_URL: x\n`), /PG_ADMIN_URL in service rab-api/);
  assertRefused(lintComposeText('bad.yml', 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${PG_DATABASE_PASSWORD:?required}\n'), /demands the bundled db's password with your own database too/);
});

// Review of PR #230, I-2: the db entrypoint's password check, run for real (sh) from the committed production file.
test('I-2: the db entrypoint refuses an empty password always, and a weak one only on a FIRST initialisation (empty PGDATA)', (t) => {
  let sh = 'sh';
  try { execFileSync(sh, ['-c', 'true']); } catch { t.skip('no POSIX sh'); return; }
  const prod = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.production.yml'), 'utf8');
  const m = /# BEGIN crewflow-db password check\n([\s\S]*?)# END crewflow-db password check/.exec(prod);
  assert.ok(m, 'the password-check block is in the db entrypoint');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'crewflow-db-pw-'));
  try {
    const pgdata = path.join(dir, 'pgdata').split(path.sep).join('/');
    fs.mkdirSync(pgdata);
    // Compose's `$$` is a literal `$`; the data directory is moved into a temp dir.
    const script = `set -eu\n${m[1].split('$$').join('$').split('/var/lib/postgresql/pgdata').join(pgdata)}echo CHECKED\n`;
    const run = (password, existing) => {
      if (existing) fs.writeFileSync(`${pgdata}/PG_VERSION`, '16\n'); else fs.rmSync(`${pgdata}/PG_VERSION`, { force: true });
      try {
        return { code: 0, out: execFileSync(sh, ['-c', script], { env: { ...process.env, POSTGRES_PASSWORD: password }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (e) {
        return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    };
    const hex = 'a1'.repeat(32);
    for (const [label, password, existing, code, pattern] of [
      ['empty, fresh', '', false, 64, /is required for the bundled database/],
      ['empty, existing volume', '', true, 64, /is required for the bundled database/],
      ['64 hex, fresh', hex, false, 0, /CHECKED/],
      ['32 of A-Z a-z 0-9 _ -, fresh', `Ab_-${'9'.repeat(28)}`, false, 0, /CHECKED/],
      ['31 characters, fresh', 'a'.repeat(31), false, 64, /must be 32\+ characters/],
      ['a URL-breaking character, fresh', `${'a'.repeat(40)}@x`, false, 64, /must be 32\+ characters/],
      ['a dot and a tilde, fresh', `${'a'.repeat(40)}.~`, false, 64, /must be 32\+ characters/],
      ['a short password on an EXISTING volume (never refused: the image ignores it)', 'short', true, 0, /CHECKED/],
      ['an odd character on an EXISTING volume', `${'a'.repeat(40)}@x`, true, 0, /CHECKED/],
    ]) {
      const r = run(password, existing);
      assert.equal(r.code, code, `${label}: ${r.out}`);
      assert.match(r.out, pattern, label);
      if (password.length > 3) assert.ok(!r.out.includes(password), `${label}: the value was printed`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The four files that carry the bundled db have the same block (dev and QA are verbatim copies; their parity gate checks
  // the rest of the service).
  for (const f of ['docker-compose.image.yml', 'docker-compose.yml', 'docker-compose.qa.yml']) {
    assert.equal(/# BEGIN crewflow-db password check\n[\s\S]*?# END crewflow-db password check/.exec(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))?.[0], m[0], f);
  }
});

test('dbSettingsProblems: the shared rule of the compose.env lint and the --environment preflight', () => {
  const r = gate.dbSettingsProblems;
  assert.deepEqual(r({ bundled: '1', passwordSet: true }), []);
  assert.deepEqual(r({ bundled: '0', adminUrl: ADMIN_OK }), []);
  assert.deepEqual(r({ bundled: '0', appUrl: URL_OK }), []);
  assertRefused(r({ bundled: '1' }), /^PG_DATABASE_PASSWORD: required for the bundled database/);
  assertRefused(r({ bundled: '0' }), /^CREWFLOW_BUNDLED_DB: 0 \(no bundled db\) needs your own database/);
  assertRefused(r({ bundled: '0', appUrl: ADMIN_OK }), /^PG_DATABASE_URL: is the app login/);
  assertRefused(r({ bundled: '0', adminUrl: URL_OK }), /^PG_ADMIN_URL: logs in as crewflow_owner/);
  assertRefused(r({ bundled: '0', adminUrl: ADMIN_OK, appUrl: URL_OK }), /both set/);
  assertRefused(r({ bundled: '0', adminUrl: ADMIN_OK, passwordSet: true }), /remove it with CREWFLOW_BUNDLED_DB=0/);
  // Review of PR #230, I-4: an encoded crewflow_owner login is the same login (decoded first); a login in a query parameter
  // is refused.
  assert.deepEqual(r({ bundled: '0', appUrl: URL_OK.replace('crewflow_owner', 'crewflow%5Fowner') }), []);
  for (const param of ['user=crewflow_owner', 'user=postgres', 'password=x', 'host=elsewhere', 'dbname=other']) {
    assertRefused(r({ bundled: '0', adminUrl: `${ADMIN_OK}&${param}` }), new RegExp(`^PG_ADMIN_URL: has a \\?${param.split('=')[0]}= query parameter`));
    assertRefused(r({ bundled: '0', appUrl: `${URL_OK}&${param}` }), new RegExp(`^PG_DATABASE_URL: has a \\?${param.split('=')[0]}= query parameter`));
  }
});
