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

// A real public test CA (rab-server's unit fixture; the private key was discarded), read from the fixture source.
const TEST_CA = /export const TEST_CA_A = `([^`]+)`/.exec(fs.readFileSync(path.join(__dirname, '../../rab-server/src/database/postgres/__tests__/fixtures/pg-test-ca.ts'), 'utf8'))[1];
const TEST_CA_LINE = TEST_CA.trim().split('\n').join('\\n'); // one env-file line, \n escapes

test('database env: the inline CA PG_SSL_CA_CERT (one line, \\n escapes) is accepted instead of the path, never beside it; the boot rules apply', () => {
  const inline = `PG_SSL_CA_CERT=${TEST_CA_LINE}`;
  const withoutPath = DATABASE_OK.split('\n').filter((l) => !l.startsWith('PG_SSL_CA_CERT_PATH=')).join('\n');
  assert.deepEqual(lintEnvText('database', `${withoutPath}\n${inline}`), []);
  assert.deepEqual(lintEnvText('database', `${withoutPath}\nPG_SSL_CA_CERT="${TEST_CA_LINE}"`), []);
  const KEY_LABEL = ['PRIVATE', 'KEY'].join(' '); // built, so no secret scanner mistakes the fixture for a key
  const both = lintEnvText('database', `${DATABASE_OK}\n${inline}`);
  assertRefused(both, /PG_SSL_CA_CERT and PG_SSL_CA_CERT_PATH: set exactly one/);
  const key = lintEnvText('database', `${withoutPath}\n${inline}\\n-----BEGIN ${KEY_LABEL}-----\\nMIGHAgEAMBMG\\n-----END ${KEY_LABEL}-----`);
  assertRefused(key, /PG_SSL_CA_CERT contains a PRIVATE KEY block/);
  const bare = lintEnvText('database', `${withoutPath}\n${inline}\\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAAAAAAAAAAAAAAAAAAAAAAAA`);
  assertRefused(bare, /PG_SSL_CA_CERT holds a long base64 run outside the PEM blocks, which looks like key material/);
  assertRefused(lintEnvText('database', `${withoutPath}\nPG_SSL_CA_CERT=/run/crewflow/pg-ca.crt`), /PG_SSL_CA_CERT does not contain a PEM certificate/);
  assertRefused(lintEnvText('database', `${withoutPath}\nPG_SSL_CA_CERT=-----BEGIN CERTIFICATE-----\\nMIIBfake\\n-----END CERTIFICATE-----`), /certificate 1 is not a parseable X\.509 certificate/);
  // The value is never echoed.
  for (const p of [...both, ...key, ...bare]) assert.ok(!/MIIB|MIGH/.test(p), p);
});

test('runtime env: the database CA keys belong in database.env only (I-3)', () => {
  assertRefused(lintEnvText('runtime', `CREWFLOW_AUDIT_SINK=stdout\nPG_SSL_CA_CERT=${TEST_CA_LINE}`), /PG_SSL_CA_CERT: belongs in database.env only/);
  assertRefused(lintEnvText('runtime', 'CREWFLOW_AUDIT_SINK=stdout\nPG_SSL_CA_CERT_PATH=/run/crewflow/pg-ca.crt'), /PG_SSL_CA_CERT_PATH: belongs in database.env only/);
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

// Owner decisions 2026-11-17 and 2026-11-18 (Twenty's way): compose.env holds the database inputs. Three modes:
// (a) the bundled db: PG_DATABASE_PASSWORD (its superuser) and PG_DATABASE_APP_PASSWORD (crewflow_owner), no URL;
// (b) CREWFLOW_BUNDLED_DB=0 + PG_ADMIN_URL (an admin login) + PG_DATABASE_URL (crewflow_owner, the same database);
// (c) CREWFLOW_BUNDLED_DB=0 + PG_DATABASE_URL (crewflow_owner ONLY). The two passwords only in (a).
const COMPOSE_BASE = `CREWFLOW_IMAGE_TAG=sha256:${'a'.repeat(64)}\nCREWFLOW_REDIS_IMAGE=redis@sha256:${'b'.repeat(64)}\nCREWFLOW_SECRETS_DIR=/etc/crewflow/secrets`;
const APP_PW = 'd'.repeat(64);
const COMPOSE_DB_PW = `${COMPOSE_BASE}\nPG_DATABASE_PASSWORD=${'c'.repeat(64)}`;
const COMPOSE_OK = `${COMPOSE_DB_PW}\nPG_DATABASE_APP_PASSWORD=${APP_PW}`;
const ADMIN_OK = URL_OK.replace('crewflow_owner', 'doadmin');
const OWN = `${COMPOSE_BASE}\nCREWFLOW_BUNDLED_DB=0`;
test('database modes: (a) bundled with both passwords; (b) own db + PG_ADMIN_URL + PG_DATABASE_URL; (c) own db + a crewflow_owner PG_DATABASE_URL; no password in (b)/(c)', () => {
  assert.deepEqual(lintEnvText('compose', COMPOSE_OK), []);
  assert.deepEqual(lintEnvText('compose', `${COMPOSE_OK}\nCREWFLOW_BUNDLED_DB=1`), []);
  // (b) both URLs set is the NORMAL own-database mode (owner decision 2026-11-18), whatever the admin login is called.
  for (const login of ['postgres', 'neondb_owner', 'doadmin', 'someone_admin']) {
    assert.deepEqual(lintEnvText('compose', `${OWN}\nPG_ADMIN_URL=${URL_OK.replace('crewflow_owner', login)}\nPG_DATABASE_URL=${URL_OK}`), [], login);
  }
  assert.deepEqual(lintEnvText('compose', `${OWN}\nPG_DATABASE_URL=${URL_OK}`), []);
  // The bundled db running beside your own admin + crewflow_owner URLs stays accepted (it runs unused).
  assert.deepEqual(lintEnvText('compose', `${COMPOSE_DB_PW}\nPG_ADMIN_URL=${ADMIN_OK}\nPG_DATABASE_URL=${URL_OK}`), []);
  // The bundled db with an explicit crewflow_owner URL on the bundled host (instead of PG_DATABASE_APP_PASSWORD).
  const onDb = (u) => u.replace('db.internal.example', 'db');
  assert.deepEqual(lintEnvText('compose', `${COMPOSE_DB_PW}\nPG_DATABASE_URL=${onDb(URL_OK)}`), []);
  assert.deepEqual(lintEnvText('compose', `${COMPOSE_DB_PW}\nPG_ADMIN_URL=${onDb(URL_OK.replace('crewflow_owner', 'postgres'))}\nPG_DATABASE_URL=${onDb(URL_OK)}\nCREWFLOW_BUNDLED_DB=1`), []);
});

test('DENIAL database modes: an admin login in PG_DATABASE_URL, crewflow_owner in PG_ADMIN_URL, PG_ADMIN_URL without PG_DATABASE_URL, two databases', () => {
  for (const login of ['postgres', 'neondb_owner', 'doadmin', 'someone_admin']) {
    for (const base of [COMPOSE_DB_PW, OWN]) {
      assertRefused(lintEnvText('compose', `${base}\nPG_DATABASE_URL=${URL_OK.replace('crewflow_owner', login)}`), /^PG_DATABASE_URL: is the app login and must log in as crewflow_owner; it is never an admin URL \(an admin URL goes in PG_ADMIN_URL/);
    }
  }
  assertRefused(lintEnvText('compose', `${OWN}\nPG_ADMIN_URL=${URL_OK}\nPG_DATABASE_URL=${URL_OK}`), /^PG_ADMIN_URL: logs in as crewflow_owner, the app login: put that URL in PG_DATABASE_URL/);
  // PG_ADMIN_URL alone: db-setup would have no crewflow_owner URL (and the bundled default names another database).
  for (const base of [OWN, COMPOSE_OK]) assertRefused(lintEnvText('compose', `${base}\nPG_ADMIN_URL=${ADMIN_OK}`), /^PG_ADMIN_URL needs PG_DATABASE_URL/);
  // The two URLs must name the same database (db-setup refuses it too: targetMismatch).
  for (const other of [URL_OK.replace('db.internal.example', 'db2.internal.example'), URL_OK.replace(':5432', ':5433'), URL_OK.replace('/crewflow?', '/other?')]) {
    assertRefused(lintEnvText('compose', `${OWN}\nPG_ADMIN_URL=${ADMIN_OK}\nPG_DATABASE_URL=${other}`), /^PG_ADMIN_URL and PG_DATABASE_URL name different databases/);
  }
  // The same database written differently (host case, the default port) is the same database.
  assert.deepEqual(lintEnvText('compose', `${OWN}\nPG_ADMIN_URL=${ADMIN_OK.replace('db.internal.example:5432', 'DB.internal.example')}\nPG_DATABASE_URL=${URL_OK}`), []);
  // The bundled db without PG_ADMIN_URL: db-setup creates crewflow_owner in the bundled db, so the URL must name it.
  assertRefused(lintEnvText('compose', `${COMPOSE_DB_PW}\nPG_DATABASE_URL=${URL_OK}`), /^PG_DATABASE_URL: with the bundled db \(CREWFLOW_BUNDLED_DB unset or 1\) and no PG_ADMIN_URL/);
});

test('DENIAL no dummy password: both bundled passwords are required with the bundled db and refused with your own database', () => {
  assertRefused(lintEnvText('compose', COMPOSE_BASE), /^PG_DATABASE_PASSWORD: required for the bundled database/);
  assertRefused(lintEnvText('compose', `${COMPOSE_BASE}\nCREWFLOW_BUNDLED_DB=1`), /^PG_DATABASE_PASSWORD: required for the bundled database/);
  assertRefused(lintEnvText('compose', `${COMPOSE_BASE}\nPG_DATABASE_APP_PASSWORD=${APP_PW}`), /^PG_DATABASE_PASSWORD: required for the bundled database/);
  // Owner decision 2026-11-18: the crewflow_owner password of the bundled db (compose builds PG_DATABASE_URL from it).
  assertRefused(lintEnvText('compose', COMPOSE_DB_PW), /^PG_DATABASE_APP_PASSWORD: required for the bundled database/);
  assertRefused(lintEnvText('compose', `${COMPOSE_DB_PW}\nCREWFLOW_BUNDLED_DB=1`), /^PG_DATABASE_APP_PASSWORD: required for the bundled database/);
  assertRefused(lintEnvText('compose', `${COMPOSE_DB_PW}\nPG_DATABASE_APP_PASSWORD=`), /^PG_DATABASE_APP_PASSWORD: required for the bundled database/);
  for (const urls of [`PG_ADMIN_URL=${ADMIN_OK}\nPG_DATABASE_URL=${URL_OK}`, `PG_DATABASE_URL=${URL_OK}`]) {
    assertRefused(lintEnvText('compose', `${COMPOSE_DB_PW}\nCREWFLOW_BUNDLED_DB=0\n${urls}`), /^PG_DATABASE_PASSWORD: remove it with CREWFLOW_BUNDLED_DB=0/);
    assertRefused(lintEnvText('compose', `${OWN}\nPG_DATABASE_APP_PASSWORD=${APP_PW}\n${urls}`), /^PG_DATABASE_APP_PASSWORD: remove it with CREWFLOW_BUNDLED_DB=0/);
  }
  // Beside an explicit PG_DATABASE_URL the app password would never be used.
  assertRefused(lintEnvText('compose', `${COMPOSE_OK}\nPG_ADMIN_URL=${ADMIN_OK}\nPG_DATABASE_URL=${URL_OK}`), /^PG_DATABASE_APP_PASSWORD: remove it: PG_DATABASE_URL is set, so it is never used/);
});

test('DENIAL PG_DATABASE_APP_PASSWORD: compose.env only, 32+ of A-Z a-z 0-9 _ -; never an env file or container variable', () => {
  assert.match(forbiddenReason('PG_DATABASE_APP_PASSWORD'), /compose\.env only/);
  for (const kind of ['database', 'runtime']) {
    assertRefused(lintEnvText(kind, `${kind === 'database' ? `${DATABASE_OK}\n` : 'CREWFLOW_AUDIT_SINK=stdout\n'}PG_DATABASE_APP_PASSWORD=${APP_PW}`), /^PG_DATABASE_APP_PASSWORD: an interpolation value of compose\.env only/);
  }
  // db-setup.sh refuses the same shapes (it is interpolated unencoded into the crewflow_owner URL).
  for (const bad of ['short', `${'d'.repeat(40)}@x`, `${'d'.repeat(40)}/x`, `${'d'.repeat(40)}%41`, `${'d'.repeat(40)}.x`, `${'d'.repeat(40)}~x`, `${'d'.repeat(31)}`]) {
    assertRefused(lintEnvText('compose', COMPOSE_OK.replace(`PG_DATABASE_APP_PASSWORD=${APP_PW}`, `PG_DATABASE_APP_PASSWORD=${bad}`)), /^PG_DATABASE_APP_PASSWORD: must be at least 32 characters of A-Z a-z 0-9 _ -/);
  }
  for (const good of ['d'.repeat(32), `${'D'.repeat(20)}_-${'9'.repeat(10)}`]) {
    assert.deepEqual(lintEnvText('compose', COMPOSE_OK.replace(`PG_DATABASE_APP_PASSWORD=${APP_PW}`, `PG_DATABASE_APP_PASSWORD=${good}`)), [], good);
  }
  // The committed template carries a placeholder, accepted in template mode only.
  assert.deepEqual(lintEnvText('compose', COMPOSE_OK.replace(`PG_DATABASE_APP_PASSWORD=${APP_PW}`, 'PG_DATABASE_APP_PASSWORD=<openssl-rand-hex-32>'), { template: true }), []);
});

test('DENIAL bundled db switch: 0 without your own database, any value but 0 or 1', () => {
  assertRefused(lintEnvText('compose', OWN), /^CREWFLOW_BUNDLED_DB: 0 \(no bundled db\) needs your own database's crewflow_owner URL in PG_DATABASE_URL/);
  assertRefused(lintEnvText('compose', `${COMPOSE_BASE}\nPG_DATABASE_URL=\nPG_ADMIN_URL=\nCREWFLOW_BUNDLED_DB=0`), /^CREWFLOW_BUNDLED_DB: 0 \(no bundled db\) needs your own database/);
  // Review F2: the bundled db's own host is not "your own database" (db would never start).
  const dbUrl = (login) => URL_OK.replace('crewflow_owner', login).replace('db.internal.example', 'db');
  assertRefused(lintEnvText('compose', `${OWN}\nPG_DATABASE_URL=${dbUrl('crewflow_owner')}`), /^CREWFLOW_BUNDLED_DB: 0 \(no bundled db\), but PG_DATABASE_URL names the bundled host db/);
  assertRefused(lintEnvText('compose', `${OWN}\nPG_ADMIN_URL=${dbUrl('postgres')}\nPG_DATABASE_URL=${dbUrl('crewflow_owner')}`), /^CREWFLOW_BUNDLED_DB: 0 \(no bundled db\), but PG_ADMIN_URL names the bundled host db/);
  for (const v of ['2', '', 'false', 'no', '00', '-1', 'true', '"0"x']) {
    assertRefused(lintEnvText('compose', `${COMPOSE_OK}\nCREWFLOW_BUNDLED_DB=${v}`), /^CREWFLOW_BUNDLED_DB: must be exactly 0 or 1/);
  }
});

// Security review L1: the committed default wait ends inside OpenShip's 180 s window for rab-api -> db-setup
// (service_completed_successfully on a service without a health check), so db-setup exits 70 with its own line first.
test('db-setup wait: the default bound is below 180 s and the same in db-setup.sh, both compose wrappers and both environments', () => {
  const wait = require('./db-setup-wait.cjs');
  assert.ok(Number(wait.WAIT_SECONDS_DEFAULT) < wait.OPENSHIP_DEPENDENCY_WINDOW_SECONDS && wait.OPENSHIP_DEPENDENCY_WINDOW_SECONDS === 180, wait.WAIT_SECONDS_DEFAULT);
  assert.equal(wait.WAIT_SECONDS_EXPR, `\${CREWFLOW_DB_WAIT_SECONDS:-${wait.WAIT_SECONDS_DEFAULT}}`);
  for (const rel of ['rab/db-setup.sh', 'docker-compose.production.yml', 'docker-compose.image.yml']) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const defaults = [...text.matchAll(/CREWFLOW_DB_WAIT_SECONDS:-(\d+)\}/g)].map((m) => m[1]);
    assert.ok(defaults.length >= 2, `${rel}: ${defaults.length} defaults`);
    assert.deepEqual([...new Set(defaults)], [wait.WAIT_SECONDS_DEFAULT], rel);
  }
});

// Owner instruction 2026-11-18 (Twenty's Helm wait-for-db): db-setup's wait bound, a compose.env value only, 0-900 seconds.
test('DENIAL db-setup wait: CREWFLOW_DB_WAIT_SECONDS is 0-900 whole seconds in compose.env, never in database.env / runtime.env', () => {
  for (const v of ['0', '10', '170', '900', '']) assert.deepEqual(lintEnvText('compose', `${COMPOSE_OK}\nCREWFLOW_DB_WAIT_SECONDS=${v}`), [], v);
  for (const v of ['901', '1000', '-1', '30s', '1e3', '0300', 'x']) {
    assertRefused(lintEnvText('compose', `${COMPOSE_OK}\nCREWFLOW_DB_WAIT_SECONDS=${v}`), /^CREWFLOW_DB_WAIT_SECONDS: must be a whole number of seconds from 0 to 900/);
  }
  for (const kind of ['database', 'runtime']) {
    assertRefused(lintEnvText(kind, 'CREWFLOW_DB_WAIT_SECONDS=170'), /^CREWFLOW_DB_WAIT_SECONDS: set it in compose\.env/);
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
  // PG_DATABASE_URL in an env file: refused (the committed expression on db-setup, rab-api and rab-worker overrides it).
  for (const kind of ['database', 'runtime']) {
    assertRefused(lintEnvText(kind, `${kind === 'database' ? `${DATABASE_OK}\n` : 'CREWFLOW_AUDIT_SINK=stdout\n'}PG_DATABASE_URL=${URL_OK}`), /PG_DATABASE_URL: set it in compose\.env/);
  }
});

test('DENIAL DB-SETUP compose env: the URL still needs verify-full, the direct host and a password; never a former separated login', () => {
  for (const login of ['crewflow_app', 'crewflow_migrator', 'crewflow_worker', 'crewflow', 'rab_app', 'rab_secure_owner']) {
    for (const key of ['PG_DATABASE_URL', 'PG_ADMIN_URL']) {
      assertRefused(lintEnvText('compose', `${OWN}\n${key}=${URL_OK.replace('crewflow_owner', login)}`), new RegExp(`^${key}: logs in as a former separated login or schema role`));
    }
  }
  for (const login of ['doadmin', 'crewflow_owner']) {
    const withUrl = (url) => `${OWN}\n${login === 'doadmin' ? 'PG_ADMIN_URL' : 'PG_DATABASE_URL'}=${url.replace('crewflow_owner', login)}`;
    assertRefused(lintEnvText('compose', withUrl(URL_OK.replace('verify-full', 'require'))), /sslmode is not verify-full/);
    assertRefused(lintEnvText('compose', withUrl(URL_OK.replace('?sslmode=verify-full', ''))), /sslmode is not verify-full/);
    // Owner instruction 2026-11-19 ("decide by capability"): no host or port is classified as a pooler any more.
    for (const pooled of [URL_OK.replace('db.internal.example', 'ep-x-pooler.eu.aws.neon.tech'), URL_OK.replace(':5432', ':6543')]) {
      assert.ok(!lintEnvText('compose', withUrl(pooled)).some((m) => /pooler/.test(m)), 'a pooler-looking host is not refused by its name');
    }
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
  for (const mode of ['none', 'token']) assert.deepEqual(lintEnvText('compose', `${COMPOSE_OK}\nCREWFLOW_MIGRATION_APPROVAL_MODE=${mode}`), [], mode);
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

// Owner decision 2026-11-18 (Twenty's way): PG_DATABASE_URL is interpolated ONLY as the one committed crewflow_owner
// expression, and the retired setup volume never comes back.
test('raw compose text: PG_DATABASE_URL only as the committed crewflow_owner expression; the retired setup volume is refused', () => {
  const expr = gate.APP_URL_EXPR;
  assert.equal(expr, '${PG_DATABASE_URL:-postgresql://crewflow_owner:${PG_DATABASE_APP_PASSWORD:-}@db:5432/crewflow?sslmode=verify-full}');
  const svc = (line) => `services:\n  rab-api:\n    environment:\n      ${line}\n`;
  assert.deepEqual(lintComposeText('x.yml', svc(`PG_DATABASE_URL: ${expr}`)), []);
  assert.deepEqual(lintComposeText('x.yml', `${svc(`PG_DATABASE_URL: ${expr}`)}  rab-worker:\n    environment:\n      PG_DATABASE_URL: ${expr}\n`), []);
  for (const line of [
    'PG_DATABASE_URL: ${PG_DATABASE_URL:-}', // the pre-2026-11-18 db-setup line: no bundled default
    'PG_DATABASE_URL: ${PG_DATABASE_URL}',
    'PG_DATABASE_URL: ${PG_DATABASE_URL:-postgresql://postgres:${PG_DATABASE_PASSWORD:-}@db:5432/crewflow?sslmode=verify-full}', // the superuser
    `PG_DATABASE_URL: ${expr.replace('verify-full', 'require')}`,
    `PG_DATABASE_URL: ${expr.replace('@db:', '@db.evil.example:')}`,
    `OTHER_URL: ${expr}`,
    'X: ${PG_DATABASE_APP_PASSWORD:-}',
    'PG_DATABASE_URL: postgresql://crewflow_owner:${PG_DATABASE_APP_PASSWORD}@db:5432/crewflow?sslmode=verify-full',
    `- PG_DATABASE_URL=${expr}`,
  ]) {
    assertRefused(lintComposeText('x.yml', svc(line)), /interpolates \$\{PG_DATABASE_URL\.\.\.\} or \$\{PG_DATABASE_APP_PASSWORD\.\.\.\} other than as the committed line/);
  }
  assertRefused(lintComposeText('x.yml', svc('PG_DATABASE_URL: ${PG_DATABASE_URL:-postgresql://crewflow_owner:${PG_DATABASE_APP_PASSWORD:?required}@db:5432/crewflow?sslmode=verify-full}')), /PG_DATABASE_APP_PASSWORD:\?\.\.\.\} demands the bundled crewflow_owner password/);
  // A comment may name anything.
  assert.deepEqual(lintComposeText('x.yml', `# PG_DATABASE_URL: \${PG_DATABASE_URL:-}\n# crewflow-db-target was retired\n${svc(`PG_DATABASE_URL: ${expr}`)}`), []);
  for (const text of [
    'services:\n  db-setup:\n    volumes:\n      - crewflow-db-target:/run/crewflow/db-target\n',
    'services:\n  rab-api:\n    volumes:\n      - other:/run/crewflow/db-target:ro\n',
    'volumes:\n  crewflow-db-target:\n',
  ]) assertRefused(lintComposeText('x.yml', text), /names the retired crewflow-db-target volume or \/run\/crewflow\/db-target/);
  // The same two rules on docker-compose.production.yml (its other rules are other gates'), and the committed file passes.
  assert.deepEqual(gate.databaseExpressionProblems('docker-compose.production.yml', fs.readFileSync(gate.PRODUCTION_FILE, 'utf8')), []);
  assertRefused(gate.databaseExpressionProblems('p.yml', svc('PG_DATABASE_URL: ""').replace('""', '${PG_DATABASE_URL:-}')), /other than as the committed line/);
  assertRefused(gate.databaseExpressionProblems('p.yml', 'volumes:\n  crewflow-db-target:\n'), /retired crewflow-db-target/);
  const prod = fs.readFileSync(gate.PRODUCTION_FILE, 'utf8');
  assert.ok(prod.includes(`PG_DATABASE_URL: ${expr}`), 'production commits the expression');
  assertRefused(gate.databaseExpressionProblems('docker-compose.production.yml', prod.replace(`PG_DATABASE_URL: ${expr}`, 'PG_DATABASE_URL: ${PG_DATABASE_URL:-}')), /other than as the committed line/);
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

test('DENIAL bundled db: internal network only, its own volumes, nothing depends on it, the app mounts only its CA read-only', { skip }, () => {
  assertRefused(problemsAfter((s) => { s.db.networks.default = null; }), /internal crewflow-db network only/);
  assertRefused(problemsAfter((s, m) => { m.networks['crewflow-db'].internal = false; }), /crewflow-db is not internal/);
  assertRefused(problemsAfter((s) => { s.db.volumes = s.db.volumes.filter((v) => v.target !== '/var/lib/postgresql'); }), /crewflow-db-data at \/var\/lib\/postgresql is missing/);
  assertRefused(problemsAfter((s) => { s.db.volumes = s.db.volumes.filter((v) => v.target !== '/var/tmp'); }), /crewflow-db-ca at \/var\/tmp is missing/);
  assertRefused(problemsAfter((s) => { s.db.volumes.find((v) => v.target === '/var/tmp').source = 'other'; }), /db: unexpected named volume/);
  // The pre-fix layout (data on /var/lib/postgresql/data: root-owned on postgres:18, so the db cannot start there).
  assertRefused(problemsAfter((s) => { s.db.volumes.find((v) => v.target === '/var/lib/postgresql').target = '/var/lib/postgresql/data'; }), /db: unexpected named volume at \/var\/lib\/postgresql\/data/);
  // Owner instruction 2026-11-18 (Twenty's Helm wait-for-db): nothing depends on db (with CREWFLOW_BUNDLED_DB=0 it has no
  // container, and OpenShip then skipped the dependent instead of starting it); db-setup waits for the database itself.
  for (const svc of ['rab-api', 'rab-worker', 'db-setup']) {
    assertRefused(problemsAfter((s) => { s[svc].depends_on = { ...(s[svc].depends_on ?? {}), db: { condition: 'service_healthy', required: true } }; }), new RegExp(`${svc}: depends on db`));
  }
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
  // The deploy files do interpolate it, once on db-setup and once on db-harden (owner decision 2026-11-18, M1). `$$` is
  // Compose's literal `$`: db-setup's wait-for-db wrapper reads the variable in its own shell, which is not an interpolation.
  for (const rel of ['docker-compose.production.yml', 'docker-compose.image.yml']) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.equal(text.split('\n').filter((l) => !/^\s*#/.test(l) && l.split('$$').join('').includes('${PG_ADMIN_URL')).length, 2, rel);
  }
});

test('DENIAL ADMIN_URL_PLACEMENT: PG_ADMIN_URL with a value on rab-api / rab-worker (map, list or flow form), in an x- anchor merged into them, an anchor inside db-setup, or the old names, fails the static gate', () => {
  const setup = 'services:\n  db-setup:\n    environment:\n      PG_ADMIN_URL: ${PG_ADMIN_URL:-}\n';
  const pinned = `${setup}  rab-api:\n    environment:\n      PG_ADMIN_URL: ""\n  rab-worker:\n    environment:\n      PG_ADMIN_URL: ''\n`;
  assert.deepEqual(gate.adminUrlPlacementProblems('ok.yml', setup), []);
  // An escaped `$${PG_ADMIN_URL}` (a shell reference inside db-setup) is not an interpolation; an unescaped second one is.
  assert.deepEqual(gate.adminUrlPlacementProblems('ok.yml', `${setup}    entrypoint: ["/bin/sh", "-c", "echo ` + '$${PG_ADMIN_URL:-}"]\n'), []);
  assert.match(gate.adminUrlPlacementProblems('x.yml', `${setup}    entrypoint: ["/bin/sh", "-c", "echo ` + '$$${PG_ADMIN_URL:-}"]\n').join('\n'), /interpolates \$\{PG_ADMIN_URL\.\.\.\} 2 times/);
  // Owner decision L-2: the exact empty pin on rab-api / rab-worker is the one allowed occurrence outside db-setup.
  assert.deepEqual(gate.adminUrlPlacementProblems('ok.yml', pinned), []);
  // ... and on the dev / QA stacks' server / worker (follow-up of the review: the same pin there).
  assert.deepEqual(gate.adminUrlPlacementProblems('ok.yml', `${setup}  server:\n    environment:\n      PG_ADMIN_URL: ''\n  worker:\n    environment:\n      PG_ADMIN_URL: ""\n`), []);
  for (const rel of ['docker-compose.yml', 'docker-compose.qa.yml']) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.equal(text.split('\n').filter((l) => /^\s*PG_ADMIN_URL: ''\s*$/.test(l)).length, 2, `${rel}: server and worker pin PG_ADMIN_URL`);
  }
  // The dev stack blanks the host-native test / harness URLs its server and worker could read from ../rab-server/.env.
  const dev = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  // The deprecated test admin name is not blanked (X3.5-S7: no code line names only the old name); the entrypoints' generic
  // database-URL refusal stops a .env that still carries it.
  for (const name of ['TEST_DATABASE_URL', 'TEST_DATABASE_ADMIN_URL', 'TEST_DATABASE_CREWFLOW_URL', 'MIGRATION_SECURITY_ADMIN_URL']) {
    assert.equal(dev.split('\n').filter((l) => new RegExp(`^\\s*${name}: ''\\s*$`).test(l)).length, 2, `docker-compose.yml: ${name} blanked on server and worker`);
  }
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
    [`${setup}  server:\n    environment:\n      PG_ADMIN_URL: x\n`, /PG_ADMIN_URL in service server/],
    [`${setup}  front:\n    environment:\n      PG_ADMIN_URL: ""\n`, /PG_ADMIN_URL in service front/],
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

// ------------------------------------------------------------------------------------------------ db-harden (M1)
// Owner decision 2026-11-18 (security review of PR #246, M1): the one-shot CREATEROLE hardening service. These cases need no
// rendering: the raw-text rules, the env lint and dbHardenProblems on a hand-built model of the committed shape.

test('db-harden: both deploy files commit it with db-setup\'s database settings, its own entrypoint and timeout, no depends_on', () => {
  for (const rel of ['docker-compose.production.yml', 'docker-compose.image.yml']) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const block = text.split(/\n(?=  [a-z][a-z0-9-]*:\n)/).find((b) => b.startsWith('  db-harden:\n'));
    assert.ok(block, `${rel}: db-harden is committed`);
    const code = block.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.match(code, /entrypoint: \["\.\/db-setup\.sh", "harden"\]/, rel);
    assert.match(code, /PG_ADMIN_URL: \$\{PG_ADMIN_URL:-\}/, rel);
    assert.ok(code.includes(`PG_DATABASE_URL: ${gate.APP_URL_EXPR}`), rel);
    assert.match(code, /CREWFLOW_BUNDLED_DB_ADMIN_URL: postgresql:\/\/postgres:\$\{PG_DATABASE_PASSWORD:-\}@db:5432\/crewflow\?sslmode=verify-full/, rel);
    assert.ok(code.includes(`${gate.HARDEN_TIMEOUT_KEY}: ${gate.HARDEN_TIMEOUT_EXPR}`), rel);
    assert.match(code, /restart: "no"/, rel);
    assert.doesNotMatch(code, /depends_on/, `${rel}: db-harden has no depends_on`);
    assert.doesNotMatch(code, /runtime\.env/, `${rel}: db-harden never reads runtime.env`);
    // Nothing waits for it: no depends_on entry anywhere names it.
    // (Services sit at two spaces; a depends_on entry naming db-harden would sit deeper, or be a list item.)
    const lines = text.split('\n').filter((l) => !/^\s*#/.test(l));
    assert.ok(!lines.some((l) => /^ {4,}db-harden:\s*$/.test(l) || /^\s*-\s*db-harden\s*$/.test(l)), `${rel}: no service depends on db-harden`);
  }
});

test('DENIAL ADMIN_URL_PLACEMENT (M1): db-harden may hold the admin login under db-setup\'s rules; one interpolation per admin service; no anchor on it', () => {
  const both = 'services:\n  db-setup:\n    environment:\n      PG_ADMIN_URL: ${PG_ADMIN_URL:-}\n      CREWFLOW_BUNDLED_DB_ADMIN_URL: x\n  db-harden:\n    environment:\n      PG_ADMIN_URL: ${PG_ADMIN_URL:-}\n      CREWFLOW_BUNDLED_DB_ADMIN_URL: x\n';
  assert.deepEqual(gate.adminUrlPlacementProblems('ok.yml', both), []);
  const cases = [
    [`${both}      X: \${PG_ADMIN_URL:-}\n`, /interpolates \$\{PG_ADMIN_URL\.\.\.\} 2 times in db-harden/],
    ['services:\n  db-harden: &h\n    environment:\n      PG_ADMIN_URL: ${PG_ADMIN_URL:-}\n  rab-api:\n    <<: *h\n', /an anchor on the db-harden service/],
    ['services:\n  db-harden:\n    environment: &henv\n      PG_ADMIN_URL: ${PG_ADMIN_URL:-}\n  rab-api:\n    environment:\n      <<: *henv\n', /an anchor defined inside the db-harden service/],
    // Any other name is still refused (db-harden2, a renamed copy).
    ['services:\n  db-harden2:\n    environment:\n      PG_ADMIN_URL: ${PG_ADMIN_URL:-}\n', /interpolated in service db-harden2/],
    ['services:\n  db-harden2:\n    environment:\n      CREWFLOW_BUNDLED_DB_ADMIN_URL: x\n', /CREWFLOW_BUNDLED_DB_ADMIN_URL in service db-harden2/],
  ];
  for (const [text, pattern] of cases) assertRefused(gate.adminUrlPlacementProblems('bad.yml', text), pattern);
});

test('DENIAL db-harden timeout: committed only as ${CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS:-1200}; compose.env only, 60-7200', () => {
  assert.deepEqual(lintComposeText('ok.yml', `services:\n  db-harden:\n    environment:\n      ${gate.HARDEN_TIMEOUT_KEY}: ${gate.HARDEN_TIMEOUT_EXPR}\n`), []);
  assertRefused(lintComposeText('bad.yml', `services:\n  db-harden:\n    environment:\n      ${gate.HARDEN_TIMEOUT_KEY}: "30"\n`), /CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS must be exactly/);
  for (const ok of ['60', '1200', '7200']) assert.deepEqual(lintEnvText('compose', `${gate.HARDEN_TIMEOUT_KEY}=${ok}\n`).filter((x) => x.startsWith(gate.HARDEN_TIMEOUT_KEY)), [], ok);
  for (const bad of ['59', '7201', '20m', '-1', '1e3']) assertRefused(lintEnvText('compose', `${gate.HARDEN_TIMEOUT_KEY}=${bad}\n`), /CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: must be a whole number of seconds from 60 to 7200/);
  for (const kind of ['database', 'runtime']) assertRefused(lintEnvText(kind, `${gate.HARDEN_TIMEOUT_KEY}=1200\n`), /CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: set it in compose\.env/);
  assert.equal(gate.hardenTimeoutOk('1200'), true);
  assert.equal(gate.hardenTimeoutOk('7201'), false);
});

/** A hand-built model of the committed db-setup / db-harden / rab-api shapes (what `docker compose config` renders). */
function hardenModel() {
  const image = `adhin007/adolphus@sha256:${'0'.repeat(64)}`;
  const want = {
    PG_ADMIN_URL: '',
    PG_DATABASE_URL: gate.BUNDLED_APP_URL,
    CREWFLOW_BUNDLED_DB: '1',
    CREWFLOW_BUNDLED_DB_ADMIN_URL: gate.BUNDLED_URL,
    PG_DATABASE_SESSION_URL: '',
  };
  const oneShot = (entrypoint, extraEnv) => ({
    image,
    entrypoint,
    environment: { ...want, ...extraEnv, NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production' },
    networks: { default: null, 'crewflow-db': null },
    volumes: [{ type: 'volume', source: 'crewflow-db-ca', target: '/run/crewflow/db-ca', read_only: true }],
    restart: 'no',
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '5' } },
    user: '1000:1000',
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    pids_limit: 64,
    mem_limit: '268435456',
    cpus: 1,
    stop_grace_period: '30s',
  });
  const services = {
    'rab-api': { image, depends_on: { 'db-setup': { condition: 'service_completed_successfully' } } },
    'rab-worker': { image, depends_on: { 'rab-api': { condition: 'service_healthy' } } },
    'db-setup': { ...oneShot(['./db-setup.sh'], { CREWFLOW_DB_WAIT_SECONDS: '170' }), depends_on: { db: { condition: 'service_healthy' } }, stop_grace_period: '40s' },
    'db-harden': oneShot(['./db-setup.sh', 'harden'], { [gate.HARDEN_TIMEOUT_KEY]: '1200', CREWFLOW_DB_WAIT_SECONDS: '170' }),
  };
  return { services, want };
}
const hardenProblems = (mutate, timeout = '1200') => {
  const { services, want } = hardenModel();
  if (mutate) mutate(services);
  const out = [];
  gate.dbHardenProblems(services, (m) => out.push(m), want, timeout);
  return out;
};

test('dbHardenProblems: the committed shape passes', () => {
  assert.deepEqual(hardenProblems(), []);
});

test('DENIAL dbHardenProblems: missing, any depends_on, a service depending on it, another entrypoint or image, a different database setting, the timeout, runtime.env', () => {
  const cases = [
    [(s) => { delete s['db-harden']; }, /db-harden: missing/],
    [(s) => { s['db-harden'].depends_on = { db: { condition: 'service_healthy' } }; }, /db-harden: has depends_on/],
    [(s) => { s['db-harden'].depends_on = { 'rab-api': { condition: 'service_started' } }; }, /db-harden: has depends_on/],
    [(s) => { s['rab-api'].depends_on['db-harden'] = { condition: 'service_completed_successfully' }; }, /rab-api: depends on db-harden/],
    [(s) => { s['rab-worker'].depends_on['db-harden'] = { condition: 'service_started' }; }, /rab-worker: depends on db-harden/],
    [(s) => { s['rab-worker'].depends_on = ['db-harden']; }, /rab-worker: depends on db-harden/],
    [(s) => { s['db-harden'].entrypoint = ['./db-setup.sh']; }, /entrypoint is not exactly \.\/db-setup\.sh harden/],
    [(s) => { s['db-harden'].entrypoint = ['./api-prestart.sh']; }, /entrypoint is not exactly \.\/db-setup\.sh harden/],
    [(s) => { s['db-harden'].command = ['harden']; }, /db-harden: has a command/],
    [(s) => { s['db-harden'].image = `adhin007/adolphus@sha256:${'1'.repeat(64)}`; }, /db-harden: image differs from rab-api/],
    [(s) => { s['db-harden'].environment.PG_ADMIN_URL = 'postgresql://x:y@elsewhere:5432/crewflow'; }, /db-harden: PG_ADMIN_URL is not db-setup's committed value/],
    [(s) => { delete s['db-harden'].environment.CREWFLOW_BUNDLED_DB_ADMIN_URL; }, /db-harden: CREWFLOW_BUNDLED_DB_ADMIN_URL is missing/],
    [(s) => { delete s['db-harden'].environment[gate.HARDEN_TIMEOUT_KEY]; }, /CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS is missing/],
    [(s) => { s['db-harden'].environment[gate.HARDEN_TIMEOUT_KEY] = '30'; }, /CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS is "30"/],
    // Owner instruction 2026-11-18 (Twenty's Helm wait-for-db): db-harden's database wait, bounded by db-setup's value.
    [(s) => { delete s['db-harden'].environment.CREWFLOW_DB_WAIT_SECONDS; }, /db-harden: CREWFLOW_DB_WAIT_SECONDS is missing/],
    [(s) => { s['db-harden'].environment.CREWFLOW_DB_WAIT_SECONDS = '900'; }, /db-harden: CREWFLOW_DB_WAIT_SECONDS is not db-setup's committed value/],
    [(s) => { s['db-harden'].environment.CREWFLOW_DB_WAIT_SECONDS = '901'; s['db-setup'].environment.CREWFLOW_DB_WAIT_SECONDS = '901'; }, /db-harden: CREWFLOW_DB_WAIT_SECONDS is not db-setup's committed value/],
    [(s) => { s['db-harden'].restart = 'on-failure'; }, /db-harden: restart is "on-failure", expected "no"/],
    [(s) => { s['db-harden'].profiles = ['harden']; }, /db-harden: has profiles/],
    [(s) => { s['db-harden'].env_file = [{ path: '/secrets/runtime.env' }]; }, /db-harden: reads runtime\.env/],
    [(s) => { s['db-harden'].environment.APP_SECRET = 'x'; }, /db-harden: has APP_SECRET/],
    [(s) => { s['db-harden'].user = '0:0'; }, /db-harden: user is "0:0"/],
    [(s) => { s['db-harden'].volumes = []; }, /db-harden: does not mount the bundled db's CA read-only/],
    [(s) => { s['db-harden'].networks = { default: null }; }, /db-harden: is not on the crewflow-db network/],
    [(s) => { s['db-harden'].environment.NODE_ENV = 'development'; }, /db-harden: NODE_ENV is not production/],
    [(s) => { s['db-harden'].environment.RAB_RUNTIME_ENV = 'staging'; }, /db-harden: RAB_RUNTIME_ENV is not production/],
    [(s) => { s['db-harden'].environment.PG_DATABASE_ADMIN_URL = ''; }, /db-harden: has PG_DATABASE_ADMIN_URL \(renamed to PG_ADMIN_URL\)/],
    [(s) => { s['db-harden'].depends_on = ['db']; }, /db-harden: has depends_on/],
    [(s) => { s['db-harden'].init = true; }, /db-harden: init: true/],
    // Its own rule (exact message), beside the shared hardening rule that also refuses any port off rab-api.
    [(s) => { s['db-harden'].ports = [{ target: 5432, published: '5432' }]; }, /^db-harden: publishes a port$/],
    [(s) => { s['db-harden'].deploy = { replicas: 2 }; }, /db-harden: 2 replicas/],
    // db-setup's container hardening (stop_grace_period aside).
    [(s) => { s['db-harden'].read_only = false; }, /db-harden: read_only root filesystem is not set/],
    [(s) => { s['db-harden'].cap_drop = []; }, /db-harden: cap_drop ALL is missing/],
    [(s) => { s['db-harden'].security_opt = []; }, /db-harden: security_opt no-new-privileges:true is missing/],
    [(s) => { delete s['db-harden'].pids_limit; }, /db-harden: pids_limit is missing/],
    [(s) => { delete s['db-harden'].mem_limit; }, /db-harden: mem_limit is missing/],
  ];
  for (const [mutate, pattern] of cases) assertRefused(hardenProblems(mutate), pattern);
  // A rendered compose.env value outside the child's bounds (the lint refuses it too).
  for (const v of ['30', '7201', '99999']) assertRefused(hardenProblems((s) => { s['db-harden'].environment[gate.HARDEN_TIMEOUT_KEY] = v; }, v), /db-harden: CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS must be a whole number of seconds from 60 to 7200/);
  assert.deepEqual(hardenProblems((s) => { s['db-harden'].environment[gate.HARDEN_TIMEOUT_KEY] = '600'; }, '600'), []);
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
    // Compose's `$$` is a literal `$`; PGDATA (the db service's environment) points at a temp dir.
    const script = `set -eu\n${m[1].split('$$').join('$')}echo CHECKED\n`;
    const run = (password, existing) => {
      if (existing) fs.writeFileSync(`${pgdata}/PG_VERSION`, '16\n'); else fs.rmSync(`${pgdata}/PG_VERSION`, { force: true });
      try {
        return { code: 0, out: execFileSync(sh, ['-c', script], { env: { ...process.env, PGDATA: pgdata, POSTGRES_PASSWORD: password }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
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
  assert.deepEqual(r({ bundled: '1', passwordSet: true, appPasswordSet: true }), []);
  assert.deepEqual(r({ bundled: '0', adminUrl: ADMIN_OK, appUrl: URL_OK }), []);
  assert.deepEqual(r({ bundled: '0', appUrl: URL_OK }), []);
  assertRefused(r({ bundled: '1' }), /^PG_DATABASE_PASSWORD: required for the bundled database/);
  // Fail closed: a caller that does not say the app password is set gets it reported missing in the bundled mode.
  assertRefused(r({ bundled: '1', passwordSet: true }), /^PG_DATABASE_APP_PASSWORD: required for the bundled database/);
  assertRefused(r({ bundled: '0' }), /^CREWFLOW_BUNDLED_DB: 0 \(no bundled db\) needs your own database/);
  assertRefused(r({ bundled: '0', adminUrl: ADMIN_OK }), /^PG_ADMIN_URL needs PG_DATABASE_URL/);
  assertRefused(r({ bundled: '0', appUrl: ADMIN_OK }), /^PG_DATABASE_URL: is the app login/);
  assertRefused(r({ bundled: '0', adminUrl: URL_OK, appUrl: URL_OK }), /^PG_ADMIN_URL: logs in as crewflow_owner/);
  assertRefused(r({ bundled: '0', adminUrl: ADMIN_OK, appUrl: URL_OK.replace('/crewflow?', '/other?') }), /name different databases/);
  assertRefused(r({ bundled: '0', adminUrl: ADMIN_OK, appUrl: URL_OK, passwordSet: true }), /PG_DATABASE_PASSWORD: remove it with CREWFLOW_BUNDLED_DB=0/);
  assertRefused(r({ bundled: '0', appUrl: URL_OK, appPasswordSet: true }), /PG_DATABASE_APP_PASSWORD: remove it with CREWFLOW_BUNDLED_DB=0/);
  // Owner decision 2026-11-18: both URLs set is no longer a refusal.
  assert.ok(!r({ bundled: '0', adminUrl: ADMIN_OK, appUrl: URL_OK }).some((p) => /both set/.test(p)));
  // Review of PR #230, I-4: an encoded crewflow_owner login is the same login (decoded first); a login in a query parameter
  // is refused.
  assert.deepEqual(r({ bundled: '0', appUrl: URL_OK.replace('crewflow_owner', 'crewflow%5Fowner') }), []);
  for (const param of ['user=crewflow_owner', 'user=postgres', 'password=x', 'host=elsewhere', 'dbname=other']) {
    assertRefused(r({ bundled: '0', adminUrl: `${ADMIN_OK}&${param}`, appUrl: URL_OK }), new RegExp(`^PG_ADMIN_URL: has a \\?${param.split('=')[0]}= query parameter`));
    assertRefused(r({ bundled: '0', appUrl: `${URL_OK}&${param}` }), new RegExp(`^PG_DATABASE_URL: has a \\?${param.split('=')[0]}= query parameter`));
  }
});

// ---- Transaction pooler support (owner instruction 2026-11-19): PG_DATABASE_SESSION_URL, a compose.env value only.
const POOLER = 'postgresql://crewflow_owner:Zq81-not-a-real-password-77@pool.internal.example:6432/crewflow?sslmode=verify-full'; // gitleaks:allow
const SESSION = URL_OK; // the direct host of the same database and login

test('PG_DATABASE_SESSION_URL: compose.env accepts it beside a pooler PG_DATABASE_URL (own database), with or without PG_ADMIN_URL', () => {
  assert.deepEqual(lintEnvText('compose', `${OWN}\nPG_DATABASE_URL=${POOLER}\nPG_DATABASE_SESSION_URL=${SESSION}`), []);
  const admin = URL_OK.replace('crewflow_owner:', 'doadmin:');
  assert.deepEqual(lintEnvText('compose', `${OWN}\nPG_ADMIN_URL=${admin}\nPG_DATABASE_URL=${POOLER}\nPG_DATABASE_SESSION_URL=${SESSION}`), []);
  assert.equal(gate.SESSION_URL_EXPR, '${PG_DATABASE_SESSION_URL:-}');
  assert.ok(gate.DB_SETUP_DB_KEYS.includes('PG_DATABASE_SESSION_URL'));
});

test('DENIAL PG_DATABASE_SESSION_URL: another login, another database, the same host, no pooler URL, the bundled db, an env file, TLS, an admin URL elsewhere', () => {
  const with_ = (session, extra = `PG_DATABASE_URL=${POOLER}`, base = OWN) => lintEnvText('compose', `${base}\n${extra}\nPG_DATABASE_SESSION_URL=${session}`);
  assertRefused(with_(SESSION.replace('crewflow_owner:', 'doadmin:')), /^PG_DATABASE_SESSION_URL: must log in as crewflow_owner/);
  assertRefused(with_(SESSION.replace('crewflow_owner:', 'crewflow_app:')), /^PG_DATABASE_SESSION_URL: logs in as a former separated login/);
  assertRefused(with_(SESSION.replace('/crewflow?', '/other?')), /PG_DATABASE_SESSION_URL and PG_DATABASE_URL name different databases/);
  assertRefused(with_(POOLER), /PG_DATABASE_SESSION_URL names the same host and port as PG_DATABASE_URL/);
  assertRefused(with_(SESSION, 'CREWFLOW_IMAGE_TAG_UNUSED='), /PG_DATABASE_SESSION_URL needs PG_DATABASE_URL/);
  assertRefused(with_(SESSION.replace('verify-full', 'require')), /PG_DATABASE_SESSION_URL: sslmode is not verify-full/);
  assertRefused(with_('postgresql://crewflow_owner@db.internal.example:5432/crewflow?sslmode=verify-full'), /PG_DATABASE_SESSION_URL: has no password/);
  assertRefused(with_(`${SESSION}&user=doadmin`), /PG_DATABASE_SESSION_URL: has a \?user= query parameter/);
  assertRefused(lintEnvText('compose', `${COMPOSE_OK}\nPG_DATABASE_SESSION_URL=${SESSION}`), /PG_DATABASE_SESSION_URL: only with your own database/);
  // The admin URL must name the SESSION URL's database (the direct host), not the pooler's.
  const admin = URL_OK.replace('crewflow_owner:', 'doadmin:').replace('db.internal.example', 'other.internal.example');
  assertRefused(lintEnvText('compose', `${OWN}\nPG_ADMIN_URL=${admin}\nPG_DATABASE_URL=${POOLER}\nPG_DATABASE_SESSION_URL=${SESSION}`), /PG_ADMIN_URL and PG_DATABASE_SESSION_URL name different databases/);
  // Never an env file (the committed ${PG_DATABASE_SESSION_URL:-} would override it).
  for (const kind of ['database', 'runtime']) {
    assertRefused(lintEnvText(kind, `${kind === 'database' ? `${DATABASE_OK}\n` : 'CREWFLOW_AUDIT_SINK=stdout\n'}PG_DATABASE_SESSION_URL=${SESSION}`), /PG_DATABASE_SESSION_URL: set it in compose\.env/);
  }
});

test('DENIAL PG_DATABASE_SESSION_URL raw text: only the committed line `PG_DATABASE_SESSION_URL: ${PG_DATABASE_SESSION_URL:-}`', () => {
  const ok = 'services:\n  rab-api:\n    environment:\n      PG_DATABASE_SESSION_URL: ${PG_DATABASE_SESSION_URL:-}\n';
  assert.ok(!gate.databaseExpressionProblems('f.yml', ok).some((m) => /PG_DATABASE_SESSION_URL/.test(m)));
  for (const bad of [
    '      PG_DATABASE_SESSION_URL: ${PG_DATABASE_SESSION_URL:-postgresql://crewflow_owner:x@db:5432/crewflow}',
    '      PG_DATABASE_SESSION_URL: postgresql://crewflow_owner:x@db:5432/crewflow',
    '      OTHER: ${PG_DATABASE_SESSION_URL:-}',
    '      - PG_DATABASE_SESSION_URL=${PG_DATABASE_SESSION_URL}',
  ]) {
    assertRefused(gate.databaseExpressionProblems('f.yml', `services:\n  rab-api:\n    environment:\n${bad}\n`), /names PG_DATABASE_SESSION_URL other than as the committed line/);
  }
});

test('dbHardenProblems: db-harden\'s PG_DATABASE_SESSION_URL must be db-setup\'s', () => {
  const out = hardenProblems((s) => { s['db-harden'].environment.PG_DATABASE_SESSION_URL = SESSION; });
  assert.ok(out.some((m) => /db-harden: PG_DATABASE_SESSION_URL is not db-setup's committed value/.test(m)), JSON.stringify(out));
});
