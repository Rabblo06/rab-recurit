'use strict';
/**
 * Worker bundle launcher + health tests. Dependency-free (node:test). No database, Redis, network or cloud access:
 * children are synthetic fixture scripts and every URL is a dummy.
 *
 * Run inside the real bundle image as root (Linux), so UID/GID dropping, /proc evidence and signal handling are the
 * real ones:
 *   docker run --rm --user 0:0 -v "<repo>/packages/rab-docker/rab/worker-bundle:/bundle:ro" <bundle image> \
 *     node --test /bundle/test/launcher.test.cjs
 * The first 11 cases are the reviewed reference cases (crewflow-four-service-reference/launcher.test.cjs), adapted where
 * the integrated launcher deliberately differs (named in each case).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const launcher = require('../start-worker-bundle.cjs');
const health = require('../worker-bundle-health.cjs');

const { makePlan, supervise, preflight, JOBS_ENV_KEYS, PROVISIONER_ENV_KEYS, FORBIDDEN_SERVICE_KEYS, PROVISIONER_INTERVAL } = launcher;
const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;
const SECRET_MARKERS = ['dummy-app-pw', 'dummy-direct-pw', 'dummy-prov-pw', 'fake-test-only', 'fake-email-secret', 'fake-s3-secret'];

const env = () => ({
  NODE_ENV: 'production',
  RAB_RUNTIME_ENV: 'production',
  // Phase B: one PG_DATABASE_URL (crewflow_app, direct; it is also the session-lock connection). A production service
  // refuses the legacy DATABASE_URL / DATABASE_DIRECT_URL / DB_POOL_MAX (see test B1).
  PG_DATABASE_URL: 'postgres://crewflow_app:dummy-app-pw@db.example:5432/testdb?sslmode=verify-full',
  PG_SSL_CA_CERT_PATH: '/run/secrets/pg-ca.pem',
  CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production',
  CREWFLOW_DEPLOYMENT_ID: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
  PG_EXPECTED_DATABASE_NAME: 'testdb',
  CREWFLOW_PROVISIONER_DATABASE_URL: 'postgres://crewflow:dummy-prov-pw@db.example:5432/testdb?sslmode=verify-full',
  // Phase A: the provisioner child is opt-in. The reference cases below run the ENABLED topology (what every committed
  // compose file sets); the "Phase A" cases further down cover the disabled default.
  CREWFLOW_PROVISIONER_ENABLED: 'true',
  REDIS_URL: 'redis://redis:6379',
  TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
  APP_SECRET: 'fake-test-only',
  EMAIL_SMTP_PASSWORD: 'fake-email-secret',
  S3_SECRET_ACCESS_KEY: 'fake-s3-secret',
  APNS_AUTH_KEY_P8: 'fake-apns',
  // DB_TARGET is not here any more: security review L-4 made it a refusal on the Worker service (test 12), not a dropped key.
  NODE_OPTIONS: '--inspect=0.0.0.0:9229',
  DOTENV_CONFIG_PATH: '/somewhere/.env',
  SOME_UNKNOWN_VARIABLE: 'x',
});

/** Outside production the deprecated names still work (DATABASE_URL pooled + DATABASE_DIRECT_URL for the locks). */
const legacyEnv = (overrides = {}) => {
  const e = {
    ...env(),
    NODE_ENV: 'development',
    RAB_RUNTIME_ENV: 'development',
    DATABASE_URL: 'postgres://crewflow_app:dummy-app-pw@db-pooler.example:5432/testdb',
    DATABASE_DIRECT_URL: 'postgres://crewflow_app:dummy-direct-pw@db.example:5432/testdb',
  };
  delete e.PG_DATABASE_URL;
  delete e.CREWFLOW_DEPLOYMENT_ENVIRONMENT;
  delete e.CREWFLOW_DEPLOYMENT_ID;
  Object.assign(e, overrides);
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete e[k];
  return e;
};

const legacyRefusal = (overrides) => {
  try {
    makePlan(legacyEnv(overrides));
  } catch (e) {
    return e;
  }
  return null;
};

const refusal = (overrides) => {
  try {
    makePlan({ ...env(), ...overrides });
  } catch (e) {
    return e;
  }
  return null;
};

// ---------------------------------------------------------------- reference cases (adapted)

test('1 jobs child does not receive provisioning, migration or command authority', () => {
  const [w] = makePlan(env());
  for (const key of ['DATABASE_URL_UNPOOLED', 'CREWFLOW_PROVISIONER_DATABASE_URL', 'CREWFLOW_MIGRATION_DATABASE_URL', 'ALLOW_PRODUCTION_DB_COMMANDS', 'DB_TARGET', 'NODE_OPTIONS', 'DOTENV_CONFIG_PATH', 'SOME_UNKNOWN_VARIABLE']) {
    assert.equal(w.env[key], undefined, key);
  }
  assert.match(w.env.PG_DATABASE_URL, /crewflow_app/);
  assert.equal(w.env.DATABASE_URL, undefined);
  assert.equal(w.env.DATABASE_DIRECT_URL, undefined);
  // Phase B: TLS and the deployment identity reach the jobs child (its runtime guard compares them with the marker).
  assert.equal(w.env.PG_SSL_CA_CERT_PATH, '/run/secrets/pg-ca.pem');
  assert.equal(w.env.CREWFLOW_DEPLOYMENT_ENVIRONMENT, 'production');
  assert.equal(w.env.CREWFLOW_DEPLOYMENT_ID, env().CREWFLOW_DEPLOYMENT_ID);
  assert.equal(w.env.PG_EXPECTED_DATABASE_NAME, 'testdb');
  // Adapted: the reference forwarded APP_SECRET etc.; so does this one — the jobs child needs them (push/QR/email/S3).
  assert.equal(w.env.APP_SECRET, 'fake-test-only');
  assert.equal(w.env.S3_SECRET_ACCESS_KEY, 'fake-s3-secret');
  // Every forwarded key is on the reviewed allowlist, plus the four the launcher sets itself.
  const extra = Object.keys(w.env).filter((k) => !JOBS_ENV_KEYS.includes(k) && !['PATH', 'HOME', 'TMPDIR', 'CREWFLOW_INSTANCE_HEALTH_FILE'].includes(k));
  assert.deepEqual(extra, []);
});

test('2 provisioner gets only its DB mapping and minimal infrastructure environment', () => {
  const [, p] = makePlan(env());
  // Phase B: the provisioner credential arrives as PG_DATABASE_URL; never DATABASE_URL / DATABASE_URL_UNPOOLED.
  assert.equal(p.env.PG_DATABASE_URL, env().CREWFLOW_PROVISIONER_DATABASE_URL);
  assert.equal(p.env.DATABASE_URL, undefined);
  assert.equal(p.env.DATABASE_URL_UNPOOLED, undefined);
  // Phase A: HWS_RUNTIME_ENABLED is no longer forced (env() does not set it, so the child does not get it); the explicit
  // opt-in and the validated interval are set by the launcher.
  assert.equal(p.env.HWS_RUNTIME_ENABLED, undefined);
  assert.equal(p.env.CREWFLOW_PROVISIONER_ENABLED, 'true');
  assert.equal(p.env.WORKSPACE_PROVISIONER_INTERVAL_SECONDS, '60');
  assert.deepEqual(
    Object.keys(p.env).sort(),
    [
      'CREWFLOW_DEPLOYMENT_ENVIRONMENT',
      'CREWFLOW_DEPLOYMENT_ID',
      'CREWFLOW_INSTANCE_HEALTH_FILE',
      'CREWFLOW_PROVISIONER_ENABLED',
      'HOME',
      'NODE_ENV',
      'PATH',
      'PG_DATABASE_URL',
      'PG_EXPECTED_DATABASE_NAME',
      'PG_SSL_CA_CERT_PATH',
      'RAB_RUNTIME_ENV',
      'REDIS_URL',
      'TMPDIR',
      'WORKSPACE_PROVISIONER_INTERVAL_SECONDS',
    ].sort(),
  );
  for (const key of ['APP_SECRET', 'EMAIL_SMTP_PASSWORD', 'S3_SECRET_ACCESS_KEY', 'APNS_AUTH_KEY_P8', 'DATABASE_DIRECT_URL', 'CREWFLOW_PROVISIONER_DATABASE_URL', 'PG_DATABASE_REPLICA_URL', 'PG_POOL_MAX_CONNECTIONS']) {
    assert.equal(p.env[key], undefined, key);
  }
  assert.ok(PROVISIONER_ENV_KEYS.every((k) => !/SECRET|PASSWORD|KEY/.test(k)));
});

test('3 children have different non-root identities and separate homes/health files', () => {
  const [w, p] = makePlan(env());
  assert.notEqual(w.uid, p.uid);
  assert.notEqual(w.gid, p.gid);
  for (const id of [w.uid, w.gid, p.uid, p.gid]) assert.ok(id > 0);
  assert.notEqual(w.env.HOME, p.env.HOME);
  assert.notEqual(w.healthFile, p.healthFile);
});

test('4 rejects globally injected privileged URL (DATABASE_URL_UNPOOLED)', () => {
  assert.match(refusal({ DATABASE_URL_UNPOOLED: 'postgres://crewflow:x@db/testdb' }).message, /DATABASE_URL_UNPOOLED must not be configured/);
  // Empty value is tolerated (compose blanks it on purpose); it is still never forwarded.
  const [w] = makePlan({ ...env(), DATABASE_URL_UNPOOLED: '' });
  assert.equal(w.env.DATABASE_URL_UNPOOLED, undefined);
});

test('5 rejects privileged worker login (pooled or direct)', () => {
  assert.match(refusal({ PG_DATABASE_URL: 'postgres://crewflow:x@db/testdb' }).message, /PG_DATABASE_URL must log in as crewflow_app/);
  assert.match(legacyRefusal({ DATABASE_URL: 'postgres://crewflow:x@db/testdb' }).message, /crewflow_app/);
  assert.match(legacyRefusal({ DATABASE_DIRECT_URL: 'postgres://crewflow:x@db/testdb' }).message, /crewflow_app/);
  assert.match(refusal({ CREWFLOW_PROVISIONER_DATABASE_URL: 'postgres://crewflow_app:x@db/testdb' }).message, /must log in as crewflow/);
});

test('6 rejects missing database URL / provisioner URL / Redis; the direct URL is no longer needed (Phase B)', () => {
  assert.match(refusal({ PG_DATABASE_URL: '' }).message, /^Missing PG_DATABASE_URL$/);
  assert.match(legacyRefusal({ DATABASE_URL: undefined }).message, /^Missing PG_DATABASE_URL$/);
  // Without DATABASE_DIRECT_URL the (deprecated) DATABASE_URL is the session-lock connection: a pooled host is refused,
  // a direct one plans.
  assert.match(legacyRefusal({ DATABASE_DIRECT_URL: '' }).message, /DATABASE_URL is a transaction-pooler host/);
  const direct = 'postgres://crewflow_app:dummy-app-pw@db.example:5432/testdb';
  assert.equal(makePlan(legacyEnv({ DATABASE_DIRECT_URL: '', DATABASE_URL: direct }))[0].env.DATABASE_URL, direct);
  assert.match(refusal({ CREWFLOW_PROVISIONER_DATABASE_URL: undefined }).message, /Missing CREWFLOW_PROVISIONER_DATABASE_URL/);
  assert.match(refusal({ REDIS_URL: ' ' }).message, /Missing REDIS_URL/);
});

test('7 rejects different database name', () => {
  assert.match(legacyRefusal({ DATABASE_DIRECT_URL: 'postgres://crewflow_app:x@db/other' }).message, /different databases/);
  assert.match(refusal({ CREWFLOW_PROVISIONER_DATABASE_URL: 'postgres://crewflow:x@db/other' }).message, /different databases/);
  assert.match(
    legacyRefusal({ PG_DATABASE_URL: 'postgres://crewflow_app:x@db.example:5432/other' }).message,
    /PG_DATABASE_URL and the deprecated DATABASE_URL name different targets/,
  );
});

test('8 (Phase A) HWS_RUNTIME_ENABLED is passed through unchanged to BOTH children — never forced', () => {
  // Before Phase A the launcher forced "true" on the provisioner child. Now provisioning is enabled by the explicit opt-in
  // (CREWFLOW_PROVISIONER_ENABLED=true, set on the child by the launcher) and HWS keeps the service's own value everywhere.
  const [w1, p1] = makePlan(env());
  assert.equal(w1.env.HWS_RUNTIME_ENABLED, undefined);
  assert.equal(p1.env.HWS_RUNTIME_ENABLED, undefined);
  const [w2, p2] = makePlan({ ...env(), HWS_RUNTIME_ENABLED: 'false' });
  assert.equal(w2.env.HWS_RUNTIME_ENABLED, 'false');
  assert.equal(p2.env.HWS_RUNTIME_ENABLED, 'false');
  assert.equal(p2.env.CREWFLOW_PROVISIONER_ENABLED, 'true');
  const [w3, p3] = makePlan({ ...env(), HWS_RUNTIME_ENABLED: 'true' });
  assert.equal(w3.env.HWS_RUNTIME_ENABLED, 'true');
  assert.equal(p3.env.HWS_RUNTIME_ENABLED, 'true');
});

test('9 rejects missing production proxy trust declaration and half-declared production', () => {
  assert.match(refusal({ TRUSTED_PROXY_CIDRS: '' }).message, /TRUSTED_PROXY_CIDRS/);
  assert.match(refusal({ RAB_RUNTIME_ENV: 'development' }).message, /must be set together/);
});

test('10 invalid URL and every refusal never leak a value', () => {
  const secret = 'not-url-password-DO-NOT-LOG';
  const cases = [
    { PG_DATABASE_URL: secret },
    { DATABASE_URL: secret },
    { DATABASE_DIRECT_URL: `mysql://u:${secret}@h/db` },
    { CREWFLOW_PROVISIONER_DATABASE_URL: `postgres://crewflow:${secret}@db-pooler.x/testdb` },
    { PG_DATABASE_URL: `postgres://crewflow:${secret}@db/testdb` },
    { CREWFLOW_MIGRATION_DATABASE_URL: `postgres://rab_owner:${secret}@db/testdb` },
    { CREWFLOW_BOOTSTRAP_PASSWORD: secret },
  ];
  for (const c of cases) {
    const e = refusal(c);
    assert.ok(e, JSON.stringify(Object.keys(c)));
    assert.ok(!e.message.includes(secret));
    for (const marker of SECRET_MARKERS) assert.ok(!e.message.includes(marker));
  }
});

test('11 a failed mandatory process stops the surviving process and returns failure', { skip: !linuxRoot && 'needs root on Linux' }, async () => {
  const fx = fixtures({
    'fail.cjs': 'setTimeout(()=>process.exit(7),150);',
    'wait.cjs': "process.on('SIGTERM',()=>{console.log('wait: got SIGTERM');process.exit(0)}); setInterval(()=>{},1000);",
  });
  try {
    const lines = [];
    const result = await supervise(
      [spec(fx, 'failure-fixture', 'fail.cjs', 1000), spec(fx, 'waiting-fixture', 'wait.cjs', 10001)],
      quiet({ graceMs: 3000, out: (n, l) => lines.push(`${n}: ${l}`) }),
    );
    assert.equal(result, 1);
    assert.ok(lines.includes('waiting-fixture: wait: got SIGTERM'), lines.join('\n'));
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------- integrated launcher: configuration

test('12 refuses migration/bootstrap authority on the Worker service, by name only', () => {
  // Security review L-4: the names the review found missing from this list are refused too.
  for (const key of ['CREWFLOW_MIGRATOR_PASSWORD', 'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL', 'DB_TARGET']) {
    assert.ok(FORBIDDEN_SERVICE_KEYS.includes(key), key);
  }
  for (const key of FORBIDDEN_SERVICE_KEYS) {
    const e = refusal({ [key]: 'set' });
    assert.ok(e, key);
    assert.match(e.message, new RegExp(`^${key} must not be configured`));
  }
  // L-4 follow-up: the in-process guard tolerates DB_TARGET=local|test in a non-production runtime (local `yarn start`),
  // but this launcher runs only in the Worker image (docker-compose.yml blanks DB_TARGET) and stays strict BY NAME:
  // every value is refused, production or not, and the value never appears in the message.
  for (const value of ['local', 'test', 'production']) {
    for (const NODE_ENV of ['development', 'production']) {
      const e = refusal({ NODE_ENV, DB_TARGET: value });
      assert.ok(e, `DB_TARGET=${value} NODE_ENV=${NODE_ENV}`);
      assert.match(e.message, /^DB_TARGET must not be configured/);
    }
  }
  // A blank value (docker-compose.yml's `DB_TARGET: ''`) counts as absent.
  const blank = refusal({ DB_TARGET: '' });
  assert.ok(!blank || !/^DB_TARGET/.test(blank.message));
});

test('13 refuses transaction-pooler hosts where a direct (session) connection is required', () => {
  assert.match(legacyRefusal({ DATABASE_DIRECT_URL: 'postgres://crewflow_app:x@ep-a-pooler.eu.aws.neon.tech/testdb' }).message, /DATABASE_DIRECT_URL is a transaction-pooler host/);
  // Phase B: with no DATABASE_DIRECT_URL, PG_DATABASE_URL itself is the session-lock connection, so it must be direct.
  for (const url of [
    'postgres://crewflow_app:x@ep-a-pooler.eu.aws.neon.tech/testdb',
    'postgres://crewflow_app:x@aws-0-eu-west-1.pooler.supabase.com:6543/testdb',
    'postgres://crewflow_app:x@db-1.b.db.ondigitalocean.com:25061/testdb',
    'postgres://crewflow_app:x@app.proxy-abc123.eu-west-1.rds.amazonaws.com/testdb',
  ]) {
    assert.match(refusal({ PG_DATABASE_URL: url }).message, /PG_DATABASE_URL is a transaction-pooler host/, url);
  }
  assert.equal(makePlan({ ...env(), PG_DATABASE_URL: 'postgres://crewflow_app:x@aws-0-eu-west-1.pooler.supabase.com:5432/testdb' }).length, 2);
  assert.match(refusal({ CREWFLOW_PROVISIONER_DATABASE_URL: 'postgres://crewflow:x@ep-a-pooler.eu.aws.neon.tech/testdb' }).message, /CREWFLOW_PROVISIONER_DATABASE_URL is a pooled/);
});

test('14 the allowlist covers every variable the environment validator declares except the excluded ones', () => {
  // Reconciliation guard: the validator file is not in the image, so this runs only from a repo checkout.
  const validator = path.resolve(__dirname, '../../../../rab-server/src/engine/core-modules/environment/environment-variables.ts');
  if (!fs.existsSync(validator)) return;
  const declared = [...fs.readFileSync(validator, 'utf8').matchAll(/^\s{2}([A-Z][A-Z0-9_]+)[!?]?:/gm)].map((m) => m[1]);
  // API-only: never read by the worker or provisioner (APP_GIT_COMMIT is the Admin Panel's build commit).
  // CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP (Phase B / B3): a migration-command-only flag the runtime refuses; the launcher
  // refuses it on the Worker service (FORBIDDEN_SERVICE_KEYS) instead of forwarding it.
  // PG_DATABASE_REPLICA_* (Phase B / B4): the read replica is API-only (PgReplicaService is enabled in the API process only).
  const excluded = new Set([
    'PORT',
    'AUTH_GOOGLE_ISSUER_URL',
    'AUTH_MICROSOFT_ISSUER_URL',
    'APP_GIT_COMMIT',
    'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP',
    'PG_DATABASE_REPLICA_URL',
    'PG_DATABASE_REPLICA_TIMEOUT_MS',
    'PG_DATABASE_REPLICA_MAX_LAG_MS',
  ]);
  for (const key of ['PG_DATABASE_REPLICA_URL', 'PG_DATABASE_REPLICA_TIMEOUT_MS', 'PG_DATABASE_REPLICA_MAX_LAG_MS']) {
    assert.ok(declared.includes(key), `${key} is declared by the validator`);
    assert.ok(!JOBS_ENV_KEYS.includes(key) && !PROVISIONER_ENV_KEYS.includes(key), `${key} is API-only`);
  }
  for (const key of ['PG_EXPECTED_API_INSTANCES', 'PG_EXPECTED_WORKER_INSTANCES', 'PG_EXPECTED_API_POOL_MAX', 'PG_EXPECTED_WORKER_POOL_MAX', 'PG_EXPECTED_MIGRATE_CONNECTIONS', 'PG_PROVIDER_RESERVED_CONNECTIONS']) {
    assert.ok(declared.includes(key) && JOBS_ENV_KEYS.includes(key), `${key} is declared and reaches the jobs child (connection-budget check)`);
  }
  assert.ok(FORBIDDEN_SERVICE_KEYS.includes('CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP'));
  // Phase B (ops): the one-off operations container's variables never reach the Worker service.
  for (const key of ['CREWFLOW_OPS_RUN', 'PG_OPS_APP_DATABASE_URL', 'CREWFLOW_OPS_ACTOR_SOURCE', 'CREWFLOW_OPS_ACTOR_ID', 'CREWFLOW_OPS_CHANGE_REF']) {
    assert.ok(FORBIDDEN_SERVICE_KEYS.includes(key), `${key} is refused on the Worker service`);
    assert.ok(!JOBS_ENV_KEYS.includes(key) && !PROVISIONER_ENV_KEYS.includes(key), `${key} is never forwarded to a child`);
  }
  // Phase B: every PG_* setting and the deployment identity reach the jobs child.
  for (const key of declared.filter((k) => k.startsWith('PG_') || k.startsWith('CREWFLOW_DEPLOYMENT_')).filter((k) => !excluded.has(k))) {
    assert.ok(JOBS_ENV_KEYS.includes(key), `${key} is forwarded to the jobs child`);
  }
  const missing = declared.filter((k) => !excluded.has(k) && !JOBS_ENV_KEYS.includes(k));
  assert.deepEqual(missing, []);
  // AI Part A + Phase 1 real models: the five provider keys, the model defaults and the real-provider/budget switches reach
  // the jobs child (the rab-ai consumer) and NEVER the provisioner child.
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY', 'AI_DEV_ALLOW_REAL_PROVIDERS', 'AI_DAILY_BUDGET_USD', 'AI_MODELS_DEFAULT_FAST', 'AI_MODELS_DEFAULT_SMART', 'AI_MODELS_DEFAULT_DISABLED']) {
    assert.ok(declared.includes(key), `${key} is declared by the validator`);
    assert.ok(JOBS_ENV_KEYS.includes(key), `${key} is forwarded to the jobs child`);
    assert.ok(!PROVISIONER_ENV_KEYS.includes(key), `${key} never reaches the provisioner child`);
  }
  // The retired names are neither declared nor forwarded anywhere (PHASE1_TWENTY_PLAN §5).
  for (const key of ['AI_PROVIDER', 'AI_MODEL', 'AI_PROVIDER_API_KEY']) {
    assert.ok(!declared.includes(key), `${key} is no longer declared`);
    assert.ok(!JOBS_ENV_KEYS.includes(key), `${key} is not forwarded to the jobs child`);
    assert.ok(!PROVISIONER_ENV_KEYS.includes(key), `${key} is not forwarded to the provisioner child`);
  }
});

// ---------------------------------------------------------------- integrated launcher: supervision (real processes)

test('15 an unexpected zero exit is a failure of the whole service', { skip: !linuxRoot && 'needs root on Linux' }, async () => {
  const fx = fixtures({ 'zero.cjs': 'setTimeout(()=>process.exit(0),200);', 'wait.cjs': WAIT_FIXTURE });
  try {
    const result = await supervise([spec(fx, 'zero', 'zero.cjs', 1000), spec(fx, 'wait', 'wait.cjs', 10001)], quiet({ graceMs: 3000 }));
    assert.equal(result, 1);
  } finally {
    fx.cleanup();
  }
});

test('16 SIGTERM is forwarded to each child (not its group), drains are awaited, clean stop exits 0', { skip: !linuxRoot && 'needs root on Linux' }, async () => {
  const fx = fixtures({ 'drain.cjs': DRAIN_FIXTURE });
  const signals = new EventEmitter();
  try {
    const lines = [];
    const started = Date.now();
    const pending = supervise([spec(fx, 'a', 'drain.cjs', 1000), spec(fx, 'b', 'drain.cjs', 10001)], quiet({ graceMs: 10_000, signals, out: (n, l) => lines.push(`${n}: ${l}`) }));
    await waitFor(() => lines.filter((l) => l.endsWith('ready')).length === 2);
    signals.emit('SIGTERM');
    const result = await pending;
    assert.equal(result, 0);
    assert.ok(lines.includes('a: drained') && lines.includes('b: drained'), lines.join('\n'));
    assert.ok(Date.now() - started >= 1500, 'waited for the 1.5 s drain');
  } finally {
    fx.cleanup();
  }
});

test('16b SIGINT is handled like SIGTERM (forwarded as SIGTERM, drains awaited, exit 0); a second signal forces', { skip: !linuxRoot && 'needs root on Linux' }, async () => {
  const fx = fixtures({ 'drain.cjs': DRAIN_FIXTURE, 'stubborn.cjs': "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000);" });
  try {
    const signals = new EventEmitter();
    const lines = [];
    const pending = supervise([spec(fx, 'a', 'drain.cjs', 1000), spec(fx, 'b', 'drain.cjs', 10001)], quiet({ graceMs: 10_000, signals, out: (n, l) => lines.push(`${n}: ${l}`) }));
    await waitFor(() => lines.filter((l) => l.endsWith('ready')).length === 2);
    signals.emit('SIGINT');
    assert.equal(await pending, 0);
    assert.ok(lines.includes('a: drained') && lines.includes('b: drained'), lines.join('\n'));

    const signals2 = new EventEmitter();
    const lines2 = [];
    const pending2 = supervise([spec(fx, 'stubborn', 'stubborn.cjs', 1000), spec(fx, 'ok', 'drain.cjs', 10001)], quiet({ graceMs: 60_000, signals: signals2, out: (n, l) => lines2.push(l) }));
    await waitFor(() => lines2.filter((l) => l === 'ready').length === 2);
    const t0 = Date.now();
    signals2.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 300));
    signals2.emit('SIGINT'); // operator presses Ctrl-C twice
    assert.equal(await pending2, 1);
    assert.ok(Date.now() - t0 < 8000, 'second signal must not wait for the 60 s grace');
  } finally {
    fx.cleanup();
  }
});

test('17 a child that ignores SIGTERM is SIGKILLed at the bounded deadline and the stop reports failure', { skip: !linuxRoot && 'needs root on Linux' }, async () => {
  const fx = fixtures({ 'stubborn.cjs': "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000);", 'drain.cjs': DRAIN_FIXTURE });
  const signals = new EventEmitter();
  try {
    const lines = [];
    const pending = supervise([spec(fx, 'stubborn', 'stubborn.cjs', 1000), spec(fx, 'ok', 'drain.cjs', 10001)], quiet({ graceMs: 2000, signals, out: (n, l) => lines.push(`${n}: ${l}`) }));
    await waitFor(() => lines.filter((l) => l.endsWith('ready')).length === 2);
    const t0 = Date.now();
    signals.emit('SIGTERM');
    const result = await pending;
    assert.equal(result, 1);
    assert.ok(Date.now() - t0 < 9000, 'bounded');
  } finally {
    fx.cleanup();
  }
});

test('18 descendants that escaped the child process group (setsid, like Playwright Chromium) are killed on stop', { skip: !linuxRoot && 'needs root on Linux' }, async () => {
  const fx = fixtures({
    'parent.cjs':
      "const {spawn}=require('node:child_process'); const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); g.unref(); console.log('grandchild '+g.pid); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);",
    'drain.cjs': DRAIN_FIXTURE,
  });
  const signals = new EventEmitter();
  try {
    let grandchild = null;
    const lines = [];
    const pending = supervise([spec(fx, 'parent', 'parent.cjs', 1000), spec(fx, 'ok', 'drain.cjs', 10001)], quiet({
      graceMs: 5000, signals, sweepUids: true,
      out: (n, l) => { lines.push(l); const m = /^grandchild (\d+)$/.exec(l); if (m) grandchild = Number(m[1]); },
    }));
    await waitFor(() => grandchild !== null && lines.includes('ready'));
    assert.equal(health.processUid(grandchild), 1000, 'grandchild alive as uid 1000 before stop');
    signals.emit('SIGTERM');
    assert.equal(await pending, 0);
    await waitFor(() => health.processUid(grandchild) === null, 3000);
  } finally {
    fx.cleanup();
  }
});

test('19 watchdog: a child whose heartbeat goes stale (event loop blocked) fails the service', { skip: !linuxRoot && 'needs root on Linux' }, async () => {
  const fx = fixtures({
    'hang.cjs': "const fs=require('fs'); fs.writeFileSync(process.env.HB, JSON.stringify({role:'jobs',pid:process.pid,at:Date.now()})); console.log('ready'); setTimeout(()=>{ for(;;){} }, 50);",
    'drain.cjs': DRAIN_FIXTURE,
  });
  try {
    const hbDir = path.join(fx.dir, 'hb');
    fs.mkdirSync(hbDir, { mode: 0o755 });
    fs.chownSync(hbDir, 1000, 1000);
    const hang = spec(fx, 'hang', 'hang.cjs', 1000);
    hang.healthFile = path.join(hbDir, 'heartbeat.json');
    hang.env.HB = hang.healthFile;
    const logs = [];
    const started = Date.now();
    const result = await supervise([hang, spec(fx, 'ok', 'drain.cjs', 10001)], quiet({
      graceMs: 10_000, watchdogIntervalMs: 200, staleHeartbeatMs: 1000, log: (s) => logs.push(s),
    }));
    assert.equal(result, 1);
    assert.ok(logs.some((l) => /hang: no heartbeat for \d+s — process is hung, killing it/.test(l)), logs.join('\n'));
    // The hung child is killed at once (it cannot drain); only the healthy child's 1.5 s drain is waited for.
    assert.ok(Date.now() - started < 8000, `took ${Date.now() - started}ms — waited for the grace period`);
  } finally {
    fx.cleanup();
  }
});

test('20 live identity cross-check: children that reached different clusters fail the service', { skip: !linuxRoot && 'needs root on Linux' }, async () => {
  const fx = fixtures({ 'g1.cjs': guardFixture('worker', 'crewflow_app', 'rab', '111'), 'g2.cjs': guardFixture('provisioner', 'crewflow', 'rab', '222') });
  try {
    const logs = [];
    const a = spec(fx, 'jobs', 'g1.cjs', 1000);
    a.expectGuard = { process: 'worker', role: 'crewflow_app' };
    const b = spec(fx, 'provisioner', 'g2.cjs', 10001);
    b.expectGuard = { process: 'provisioner', role: 'crewflow' };
    const result = await supervise([a, b], quiet({ graceMs: 3000, requireGuardLines: true, log: (s) => logs.push(s) }));
    assert.equal(result, 1);
    assert.ok(logs.some((l) => /live identity probes disagree: .*cluster=111.*cluster=222/.test(l)), logs.join('\n'));
  } finally {
    fx.cleanup();
  }
});

test('21 live identity cross-check: matching clusters continue; wrong live role fails', { skip: !linuxRoot && 'needs root on Linux' }, async () => {
  const fx = fixtures({
    'g1.cjs': guardFixture('worker', 'crewflow_app', 'rab', '333'),
    'g2.cjs': guardFixture('provisioner', 'crewflow', 'rab', '333'),
    'bad.cjs': guardFixture('worker', 'crewflow', 'rab', '333'),
  });
  const signals = new EventEmitter();
  try {
    const logs = [];
    const mk = (file, name, uid, expect) => Object.assign(spec(fx, name, file, uid), { expectGuard: expect });
    const ok = supervise([mk('g1.cjs', 'jobs', 1000, { process: 'worker', role: 'crewflow_app' }), mk('g2.cjs', 'provisioner', 10001, { process: 'provisioner', role: 'crewflow' })],
      quiet({ graceMs: 3000, requireGuardLines: true, signals, log: (s) => logs.push(s) }));
    await waitFor(() => logs.some((l) => /live identity probes agree: database=rab cluster=333/.test(l)));
    signals.emit('SIGTERM');
    assert.equal(await ok, 0);
    const logs2 = [];
    const bad = await supervise([mk('bad.cjs', 'jobs', 1000, { process: 'worker', role: 'crewflow_app' }), mk('g2.cjs', 'provisioner', 10001, { process: 'provisioner', role: 'crewflow' })],
      quiet({ graceMs: 3000, requireGuardLines: true, log: (s) => logs2.push(s) }));
    assert.equal(bad, 1);
    assert.ok(logs2.some((l) => /role=crewflow, expected process=worker role=crewflow_app/.test(l)), logs2.join('\n'));
  } finally {
    fx.cleanup();
  }
});

test('22 children see exactly their planned environment, run as their own UID/GID, no supplementary groups, no effective capabilities', { skip: !linuxRoot && 'needs root on Linux' }, async () => {
  const fx = fixtures({
    'introspect.cjs':
      "const s=require('fs').readFileSync('/proc/self/status','utf8'); const pick=k=>{const l=s.split(String.fromCharCode(10)).find(x=>x.startsWith(k+':')); return l===undefined?undefined:l.slice(k.length+1).trim();}; console.log(JSON.stringify({keys:Object.keys(process.env).sort(),uid:pick('Uid'),gid:pick('Gid'),groups:pick('Groups'),capEff:pick('CapEff'),capPrm:pick('CapPrm'),capAmb:pick('CapAmb'),noNewPrivs:pick('NoNewPrivs')})); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);",
  });
  const signals = new EventEmitter();
  process.env.LAUNCHER_ONLY_SENTINEL = 'must-not-be-inherited';
  try {
    const [jobsPlan, provPlan] = makePlan({ ...env(), NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development' });
    const reports = {};
    const mk = (name, plan) => Object.assign(spec(fx, name, 'introspect.cjs', plan.uid, plan.gid), { env: { ...plan.env } });
    const pending = supervise([mk('jobs', jobsPlan), mk('provisioner', provPlan)], quiet({ graceMs: 3000, signals, out: (n, l) => { try { reports[n] = JSON.parse(l); } catch { /* not ours */ } } }));
    await waitFor(() => reports.jobs && reports.provisioner);
    signals.emit('SIGTERM');
    assert.equal(await pending, 0);
    assert.deepEqual(reports.jobs.keys, Object.keys(jobsPlan.env).sort());
    assert.deepEqual(reports.provisioner.keys, Object.keys(provPlan.env).sort());
    for (const [name, plan] of [['jobs', jobsPlan], ['provisioner', provPlan]]) {
      const r = reports[name];
      assert.ok(!r.keys.includes('LAUNCHER_ONLY_SENTINEL'));
      assert.deepEqual(r.uid.split(/\s+/).map(Number), [plan.uid, plan.uid, plan.uid, plan.uid], `${name} uid`);
      assert.deepEqual(r.gid.split(/\s+/).map(Number), [plan.gid, plan.gid, plan.gid, plan.gid], `${name} gid`);
      assert.equal(r.groups.trim(), '', `${name} supplementary groups`);
      assert.equal(r.capEff, '0000000000000000', `${name} CapEff`);
      assert.equal(r.capPrm, '0000000000000000', `${name} CapPrm`);
      assert.equal(r.capAmb, '0000000000000000', `${name} CapAmb`);
    }
    console.log(`# evidence jobs: uid=${reports.jobs.uid} gid=${reports.jobs.gid} groups='${reports.jobs.groups}' CapEff=${reports.jobs.capEff} NoNewPrivs=${reports.jobs.noNewPrivs}`);
    console.log(`# evidence provisioner: uid=${reports.provisioner.uid} gid=${reports.provisioner.gid} groups='${reports.provisioner.groups}' CapEff=${reports.provisioner.capEff} NoNewPrivs=${reports.provisioner.noNewPrivs}`);
  } finally {
    delete process.env.LAUNCHER_ONLY_SENTINEL;
    fx.cleanup();
  }
});

// ---------------------------------------------------------------- preflight

test('23 preflight refuses non-root / non-Linux', () => {
  const plan = makePlan(env());
  assert.throws(() => preflight(plan, launcher.DEFAULT_LAYOUT, { platform: 'linux', uid: 1000 }), /must run as root on Linux/);
  assert.throws(() => preflight(plan, launcher.DEFAULT_LAYOUT, { platform: 'win32', uid: 0 }), /must run as root on Linux/);
});

test('24 preflight refuses child-writable code, packaged dotenv files and wrongly owned temp/health dirs', { skip: !linuxRoot && 'needs root on Linux' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-pre-'));
  try {
    const layout = {
      root,
      jobs: { uid: 1000, gid: 1000, home: path.join(root, 'tmp-jobs'), healthFile: path.join(root, 'health/jobs/heartbeat.json') },
      provisioner: { uid: 10001, gid: 10001, home: path.join(root, 'tmp-prov'), healthFile: path.join(root, 'health/provisioner/heartbeat.json') },
    };
    const dist = path.join(root, 'packages/rab-worker/dist');
    fs.mkdirSync(dist, { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.join(root, 'node_modules'), { mode: 0o755 });
    fs.chmodSync(root, 0o755);
    for (const f of ['main.js', 'workspace-provisioner.main.js']) fs.writeFileSync(path.join(dist, f), '', { mode: 0o444 });
    for (const [d, uid, mode] of [[layout.jobs.home, 1000, 0o700], [layout.provisioner.home, 10001, 0o700], [path.dirname(layout.jobs.healthFile), 1000, 0o755], [path.dirname(layout.provisioner.healthFile), 10001, 0o755]]) {
      fs.mkdirSync(d, { recursive: true });
      fs.chownSync(d, uid, uid);
      fs.chmodSync(d, mode);
    }
    const plan = makePlan(env(), layout);
    preflight(plan, layout); // baseline passes

    fs.chownSync(path.join(dist, 'main.js'), 1000, 1000);
    assert.throws(() => preflight(plan, layout), /writable by a child identity: packages\/rab-worker\/dist\/main.js/);
    fs.chownSync(path.join(dist, 'main.js'), 0, 0);
    fs.chmodSync(path.join(root, 'node_modules'), 0o777);
    assert.throws(() => preflight(plan, layout), /writable by a child identity: node_modules/);
    fs.chmodSync(path.join(root, 'node_modules'), 0o755);

    fs.writeFileSync(path.join(root, 'packages/rab-worker/.env.provisioner'), 'X=1');
    assert.throws(() => preflight(plan, layout), /packaged dotenv file present: packages\/rab-worker\/.env.provisioner/);
    fs.rmSync(path.join(root, 'packages/rab-worker/.env.provisioner'));

    fs.chownSync(layout.provisioner.home, 1000, 1000);
    assert.throws(() => preflight(plan, layout), /provisioner temporary directory/);
    fs.chownSync(layout.provisioner.home, 10001, 10001);
    fs.chmodSync(layout.jobs.home, 0o755);
    assert.throws(() => preflight(plan, layout), /jobs temporary directory/);
    fs.chmodSync(layout.jobs.home, 0o700);
    fs.chownSync(path.dirname(layout.provisioner.healthFile), 1000, 1000);
    assert.throws(() => preflight(plan, layout), /provisioner health directory/);
    fs.chownSync(path.dirname(layout.provisioner.healthFile), 10001, 10001);
    fs.rmSync(path.join(dist, 'workspace-provisioner.main.js'));
    assert.throws(() => preflight(plan, layout), /entrypoint missing: packages\/rab-worker\/dist\/workspace-provisioner.main.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('25 main() refuses a bad configuration with exit code 1 and no value in its output', async () => {
  const captured = [];
  const original = console.error;
  console.error = (...a) => captured.push(a.join(' '));
  try {
    const code = await launcher.main({ ...env(), PG_DATABASE_URL: 'postgres://crewflow:dummy-app-pw@db/testdb', CREWFLOW_BUNDLE_FAILURE_EXIT_DELAY_MS: '0' });
    assert.equal(code, 1);
  } finally {
    console.error = original;
  }
  assert.ok(captured.some((l) => /refused: PG_DATABASE_URL must log in as crewflow_app/.test(l)), captured.join('\n'));
  for (const marker of SECRET_MARKERS) assert.ok(!captured.join('\n').includes(marker));
});

// ---------------------------------------------------------------- health evaluation

const NOW = 1_800_000_000_000;
const goodBeat = (role, pid, extra = {}) => ({
  v: 1, role, pid, at: NOW - 5_000, redisOkAt: NOW - 5_000, startedAt: NOW - 600_000,
  lastCycleSettledAt: NOW - 2_000, lastCycleSucceededAt: NOW - 2_000, inFlight: 0, oldestInFlight: null, shuttingDown: false, ...extra,
});
const uidOf = (map) => (pid) => (pid in map ? map[pid] : null);
const evalWith = (beats, uids = { 100: 1000, 200: 10001 }) => health.evaluate({ now: NOW, read: (file) => beats[file] ?? null, uidOf: uidOf(uids) });
const J = health.ROLES.jobs.file;
const P = health.ROLES.provisioner.file;

test('26 health: both roles fresh and progressing → healthy', () => {
  const r = evalWith({ [J]: goodBeat('jobs', 100), [P]: goodBeat('provisioner', 200) });
  assert.equal(r.healthy, true, JSON.stringify(r));
});

test('27 health: each failure mode of ONE role makes the instance unhealthy (no masking by the other role)', () => {
  const cases = [
    ['missing provisioner file', { [J]: goodBeat('jobs', 100) }, /provisioner: .*no heartbeat file/],
    ['stale jobs heartbeat (hung)', { [J]: goodBeat('jobs', 100, { at: NOW - 60_000 }), [P]: goodBeat('provisioner', 200) }, /jobs: .*heartbeat stale/],
    ['provisioner pid dead', { [J]: goodBeat('jobs', 100), [P]: goodBeat('provisioner', 999) }, /provisioner: .*not running/],
    ['provisioner file written by wrong uid process', { [J]: goodBeat('jobs', 100), [P]: goodBeat('provisioner', 100) }, /provisioner: .*runs as uid 1000, expected 10001/],
    ['role mislabelled', { [J]: goodBeat('jobs', 100), [P]: goodBeat('jobs', 200) }, /provisioner: .*names role "jobs"/],
    ['redis writes failing', { [J]: goodBeat('jobs', 100, { redisOkAt: NOW - 120_000 }), [P]: goodBeat('provisioner', 200) }, /jobs: .*Redis/],
    ['no cycle settled', { [J]: goodBeat('jobs', 100), [P]: goodBeat('provisioner', 200, { lastCycleSettledAt: NOW - 400_000 }) }, /provisioner: .*no cycle finished/],
    ['cycles failing (DB down)', { [J]: goodBeat('jobs', 100, { lastCycleSucceededAt: NOW - 400_000 }), [P]: goodBeat('provisioner', 200) }, /jobs: .*no cycle succeeded/],
    ['hung cycle', { [J]: goodBeat('jobs', 100), [P]: goodBeat('provisioner', 200, { oldestInFlight: { name: 'workspace provisioning', startedAt: NOW - 700_000 } }) }, /provisioner: .*"workspace provisioning" in flight/],
  ];
  for (const [label, beats, pattern] of cases) {
    const r = evalWith(beats);
    assert.equal(r.healthy, false, label);
    const text = r.roles.map((x) => `${x.role}: ${x.problems.join('; ')}`).join(' | ');
    assert.match(text, pattern, label);
  }
});

test('28 health: readHeartbeat tolerates garbage and oversized files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
  try {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'big.json'), 'x'.repeat(70 * 1024));
    assert.equal(health.readHeartbeat(path.join(dir, 'bad.json')), null);
    assert.equal(health.readHeartbeat(path.join(dir, 'big.json')), null);
    assert.equal(health.readHeartbeat(path.join(dir, 'absent.json')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('29 instance heartbeat writer (compiled rab-worker dist in the image) writes only progress timestamps', { skip: !fs.existsSync('/app/packages/rab-worker/dist/core/runtime/instance-heartbeat.js') && 'compiled dist not present (run inside the image)' }, () => {
  const { createInstanceHeartbeat } = require('/app/packages/rab-worker/dist/core/runtime/instance-heartbeat.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihb-'));
  try {
    const runtime = { progress: () => ({ startedAt: 1, lastCycleSettledAt: 2, lastCycleSucceededAt: 3, inFlight: 0, oldestInFlight: null, shuttingDown: false }) };
    const noop = createInstanceHeartbeat('jobs', runtime, {});
    noop.beat();
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.throws(() => createInstanceHeartbeat('jobs', runtime, { CREWFLOW_INSTANCE_HEALTH_FILE: 'relative.json' }), /absolute/);
    const file = path.join(dir, 'heartbeat.json');
    const hb = createInstanceHeartbeat('provisioner', runtime, { CREWFLOW_INSTANCE_HEALTH_FILE: file });
    hb.beat();
    let parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.role, 'provisioner');
    assert.equal(parsed.pid, process.pid);
    assert.equal(parsed.redisOkAt, null);
    hb.markRedisOk();
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(parsed.redisOkAt > 0);
    assert.deepEqual(Object.keys(parsed).sort(), ['at', 'inFlight', 'lastCycleSettledAt', 'lastCycleSucceededAt', 'oldestInFlight', 'pid', 'redisOkAt', 'role', 'shuttingDown', 'startedAt', 'v'].sort());
    assert.deepEqual(fs.readdirSync(dir), ['heartbeat.json'], 'temp file renamed away');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- BullMQ migration (Lane A)

const bullmqBeat = (pid, extra = {}) =>
  goodBeat('jobs', pid, { mode: 'bullmq', consumersReadyAt: NOW - 5_000, reconcileOkAt: NOW - 30_000, ...extra });

test('30 health (bullmq mode): an IDLE replica that won no scan job for an hour is healthy — no restart loop', () => {
  // Never ran a cycle since start (lastCycle* null), started an hour ago: interval-mode rules would call this
  // "no cycle finished for 3600s" and the platform would restart it forever.
  const idle = bullmqBeat(100, { startedAt: NOW - 3_600_000, lastCycleSettledAt: null, lastCycleSucceededAt: null });
  const r = evalWith({ [J]: idle, [P]: goodBeat('provisioner', 200) });
  assert.equal(r.healthy, true, JSON.stringify(r));
  // Same file WITHOUT the bullmq marker (interval mode) is still unhealthy, exactly as before.
  const { mode, consumersReadyAt, reconcileOkAt, ...intervalShape } = idle;
  const r2 = evalWith({ [J]: intervalShape, [P]: goodBeat('provisioner', 200) });
  assert.equal(r2.healthy, false);
  assert.match(r2.roles[0].problems.join('; '), /no cycle finished/);
});

test('31 health (bullmq mode): consumers stopped, reconcile failing, local cycles all failing, hang → unhealthy', () => {
  const cases = [
    ['consumers not running', bullmqBeat(100, { consumersReadyAt: NOW - 120_000 }), /BullMQ consumers not confirmed running/],
    ['consumers never confirmed', bullmqBeat(100, { consumersReadyAt: null }), /BullMQ consumers not confirmed running/],
    ['reconcile failing (Redis/scheduler)', bullmqBeat(100, { reconcileOkAt: NOW - 400_000 }), /scheduler reconcile has not succeeded/],
    ['local cycles failing', bullmqBeat(100, { lastCycleSettledAt: NOW - 10_000, lastCycleSucceededAt: NOW - 400_000 }), /cycles on this instance are failing/],
    ['hung scan', bullmqBeat(100, { oldestInFlight: { name: 'storage cleanup', startedAt: NOW - 31 * 60_000 } }), /"storage cleanup" in flight/],
    ['stale event loop', bullmqBeat(100, { at: NOW - 60_000 }), /heartbeat stale/],
  ];
  for (const [label, beat, pattern] of cases) {
    const r = evalWith({ [J]: beat, [P]: goodBeat('provisioner', 200) });
    assert.equal(r.healthy, false, label);
    assert.match(r.roles[0].problems.join('; '), pattern, label);
  }
});

test('32 the jobs allowlist forwards the scheduler flags (otherwise WORKER_SCHEDULER would silently never reach the child)', () => {
  for (const key of ['WORKER_SCHEDULER', 'BULLMQ_PREFIX', 'WORKER_SCHEDULER_RECONCILE_SECONDS']) {
    assert.ok(JOBS_ENV_KEYS.includes(key), key);
    assert.ok(!PROVISIONER_ENV_KEYS.includes(key), `${key} must not reach the provisioner`);
  }
  const [jobs, provisioner] = makePlan({ ...env(), WORKER_SCHEDULER: 'bullmq', BULLMQ_PREFIX: 'crewflow:production:bull', WORKER_SCHEDULER_RECONCILE_SECONDS: '60' });
  assert.equal(jobs.env.WORKER_SCHEDULER, 'bullmq');
  assert.equal(jobs.env.BULLMQ_PREFIX, 'crewflow:production:bull');
  assert.equal(jobs.env.WORKER_SCHEDULER_RECONCILE_SECONDS, '60');
  assert.equal(provisioner.env.WORKER_SCHEDULER, undefined);
});

// ---------------------------------------------------------------- helpers

const WAIT_FIXTURE = "process.on('SIGTERM',()=>process.exit(0)); console.log('ready'); setInterval(()=>{},1000);";
const DRAIN_FIXTURE = "process.on('SIGTERM',()=>{ setTimeout(()=>{ console.log('drained'); process.exit(0); }, 1500); }); console.log('ready'); setInterval(()=>{},1000);";

function guardFixture(proc, role, db, cluster) {
  return `console.log('[runtime-db-guard] process=${proc} runtime=development classification=LOCAL endpoint=pg database=${db} cluster=${cluster} role=${role} probe=read-only-ok'); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`;
}

function fixtures(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
  fs.chmodSync(dir, 0o755);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
    fs.chmodSync(path.join(dir, name), 0o644);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function spec(fx, name, file, uid, gid = uid) {
  return { name, entry: path.join(fx.dir, file), cwd: fx.dir, env: { PATH: process.env.PATH }, uid, gid };
}

function quiet(options) {
  return { log: () => {}, out: () => {}, err: () => {}, requireGuardLines: false, sweepUids: false, ...options };
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('33 the jobs allowlist forwards AI_TITLE_GENERATION (AI Phase 2 titles) and never to the provisioner', () => {
  assert.ok(JOBS_ENV_KEYS.includes('AI_TITLE_GENERATION'));
  assert.ok(!PROVISIONER_ENV_KEYS.includes('AI_TITLE_GENERATION'));
  const [jobs, provisioner] = makePlan({ ...env(), AI_TITLE_GENERATION: 'false' });
  assert.equal(jobs.env.AI_TITLE_GENERATION, 'false');
  assert.equal(provisioner.env.AI_TITLE_GENERATION, undefined);
});

test('35 the jobs allowlist forwards the 7b budget and rate names (T7-W1) and never to the provisioner', () => {
  for (const name of ['AI_USER_DAILY_BUDGET_USD', 'AI_ORG_RATE_PER_MIN', 'AI_USER_TURNS_PER_DAY', 'AI_USER_RATE_PER_MIN', 'AI_DAILY_BUDGET_USD']) {
    assert.ok(JOBS_ENV_KEYS.includes(name), name);
    assert.ok(!PROVISIONER_ENV_KEYS.includes(name), name);
  }
  const [jobs, provisioner] = makePlan({ ...env(), AI_USER_DAILY_BUDGET_USD: '1', AI_ORG_RATE_PER_MIN: '60', AI_USER_TURNS_PER_DAY: '100' });
  assert.equal(jobs.env.AI_USER_DAILY_BUDGET_USD, '1');
  assert.equal(jobs.env.AI_USER_TURNS_PER_DAY, '100');
  assert.equal(provisioner.env.AI_USER_DAILY_BUDGET_USD, undefined);
});

test('34 the jobs allowlist forwards AI_AGENTS_ENABLED (AI Phase 6a, default false) and never to the provisioner', () => {
  assert.ok(JOBS_ENV_KEYS.includes('AI_AGENTS_ENABLED'));
  assert.ok(!PROVISIONER_ENV_KEYS.includes('AI_AGENTS_ENABLED'));
  const [jobs, provisioner] = makePlan({ ...env(), AI_AGENTS_ENABLED: 'false' });
  assert.equal(jobs.env.AI_AGENTS_ENABLED, 'false');
  assert.equal(provisioner.env.AI_AGENTS_ENABLED, undefined);
});

// ---------------------------------------------------------------- Phase A (pa-provisioner): provisioner switch

// Explicit opt-out: the only way to run the jobs child alone (unset = legacy = provisioner on, see A1b).
const disabledEnv = (overrides = {}) => {
  const e = { ...env(), ...overrides, CREWFLOW_PROVISIONER_ENABLED: 'false' };
  delete e.CREWFLOW_PROVISIONER_DATABASE_URL;
  return e;
};
const PROVISIONER_ONLY_KEYS = ['CREWFLOW_PROVISIONER_DATABASE_URL', 'CREWFLOW_PROVISIONER_ENABLED', 'DATABASE_URL_UNPOOLED', 'WORKSPACE_PROVISIONER_INTERVAL_SECONDS'];

test('A1 explicitly disabled ("false") → ONE child (jobs); the provisioner is never planned', () => {
  for (const flag of ['false', ' false ']) {
    const plan = makePlan({ ...disabledEnv(), CREWFLOW_PROVISIONER_ENABLED: flag });
    assert.equal(plan.length, 1, String(flag));
    assert.equal(plan[0].name, 'jobs');
    assert.ok(!plan.some((s) => /workspace-provisioner/.test(s.entry)));
  }
});

test('A1b switch unset or empty (every pre-Phase-A environment) → the pre-Phase-A behaviour: provisioner ON at 5 s, URL required', () => {
  for (const flag of [undefined, '', ' ']) {
    const e = { ...env() };
    if (flag === undefined) delete e.CREWFLOW_PROVISIONER_ENABLED;
    else e.CREWFLOW_PROVISIONER_ENABLED = flag;
    const plan = makePlan(e);
    assert.deepEqual(plan.map((s) => s.name), ['jobs', 'provisioner'], String(flag));
    assert.equal(plan[1].env.CREWFLOW_PROVISIONER_ENABLED, 'true');
    assert.equal(plan[1].env.WORKSPACE_PROVISIONER_INTERVAL_SECONDS, String(PROVISIONER_INTERVAL.legacyDefaultSeconds));
    assert.equal(PROVISIONER_INTERVAL.legacyDefaultSeconds, 5);
    // An explicit interval still wins.
    assert.equal(makePlan({ ...e, WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '30' })[1].env.WORKSPACE_PROVISIONER_INTERVAL_SECONDS, '30');
    // Without the URL it refuses exactly as the base launcher did — never a silent jobs-only start.
    const noUrl = { ...e };
    delete noUrl.CREWFLOW_PROVISIONER_DATABASE_URL;
    let refused = null;
    try {
      makePlan(noUrl);
    } catch (err) {
      refused = err;
    }
    assert.ok(refused instanceof launcher.BundleConfigError, String(flag));
    assert.match(refused.message, /^Missing CREWFLOW_PROVISIONER_DATABASE_URL$/);
  }
});

test('A2 explicitly disabled + CREWFLOW_PROVISIONER_DATABASE_URL present → refused (fail closed), by name only', () => {
  for (const flag of ['false']) {
    const e = { ...env(), CREWFLOW_PROVISIONER_ENABLED: flag };
    let error = null;
    try {
      makePlan(e);
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof launcher.BundleConfigError, String(flag));
    assert.match(error.message, /^CREWFLOW_PROVISIONER_DATABASE_URL is set but the workspace provisioner is disabled/);
    for (const marker of SECRET_MARKERS) assert.ok(!error.message.includes(marker));
  }
  // An empty value is tolerated (a compose file may blank it) and still never forwarded.
  const [jobs, ...rest] = makePlan(disabledEnv({ CREWFLOW_PROVISIONER_DATABASE_URL: '' }));
  assert.deepEqual(rest, []);
  assert.equal(jobs.env.CREWFLOW_PROVISIONER_DATABASE_URL, undefined);
});

test('A3 an invalid CREWFLOW_PROVISIONER_ENABLED refuses to start (no silent mode choice), value not echoed', () => {
  for (const flag of ['TRUE', 'True', '1', 'yes', 'on', 'ture', 'enabled']) {
    const e = refusal({ CREWFLOW_PROVISIONER_ENABLED: flag });
    assert.ok(e, flag);
    assert.match(e.message, /^CREWFLOW_PROVISIONER_ENABLED must be "true" or "false"/, flag);
    assert.ok(!e.message.includes(`"${flag}"`) || flag === 'true', 'value not echoed');
  }
  // Surrounding whitespace is trimmed: ' true ' is a valid "true".
  assert.equal(makePlan({ ...env(), CREWFLOW_PROVISIONER_ENABLED: ' true ' }).length, 2);
});

test('A4 the jobs child never receives provisioner keys or the privileged credential — in BOTH modes', () => {
  const plans = [
    ['enabled', makePlan({ ...env(), WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '30', HWS_RUNTIME_ENABLED: 'true' })],
    ['disabled', makePlan(disabledEnv({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '30', HWS_RUNTIME_ENABLED: 'true' }))],
  ];
  for (const [mode, [jobs]] of plans) {
    for (const key of PROVISIONER_ONLY_KEYS) assert.equal(jobs.env[key], undefined, `${mode}: ${key}`);
    assert.ok(!Object.values(jobs.env).some((v) => String(v).includes('dummy-prov-pw')), `${mode}: provisioner password reached the jobs child`);
    // CREWFLOW_DEPLOYMENT_ENVIRONMENT / _ID are identity declarations (Phase B / B3), not authority.
    const allowedCrewflow = ['CREWFLOW_INSTANCE_HEALTH_FILE', 'CREWFLOW_DEPLOYMENT_ENVIRONMENT', 'CREWFLOW_DEPLOYMENT_ID'];
    assert.ok(!Object.keys(jobs.env).some((k) => k.startsWith('CREWFLOW_') && !allowedCrewflow.includes(k)), `${mode}: CREWFLOW_* reached the jobs child`);
    assert.match(jobs.env.PG_DATABASE_URL, /^postgres:\/\/crewflow_app:/);
    assert.equal(jobs.env.HWS_RUNTIME_ENABLED, 'true', `${mode}: HWS passed through to jobs`);
  }
  for (const key of PROVISIONER_ONLY_KEYS) assert.ok(!JOBS_ENV_KEYS.includes(key), key);
  assert.ok(!PROVISIONER_ENV_KEYS.includes('CREWFLOW_PROVISIONER_DATABASE_URL'));
});

test('A5 enabled → TWO children; HWS passed through; validated interval forwarded to the provisioner only', () => {
  const plan = makePlan({ ...env(), HWS_RUNTIME_ENABLED: 'false' });
  assert.deepEqual(plan.map((s) => s.name), ['jobs', 'provisioner']);
  const [jobs, prov] = plan;
  assert.equal(prov.env.HWS_RUNTIME_ENABLED, 'false');
  assert.equal(prov.env.CREWFLOW_PROVISIONER_ENABLED, 'true');
  assert.equal(prov.env.WORKSPACE_PROVISIONER_INTERVAL_SECONDS, String(PROVISIONER_INTERVAL.defaultSeconds));
  assert.equal(PROVISIONER_INTERVAL.defaultSeconds, 60);
  assert.equal(jobs.env.WORKSPACE_PROVISIONER_INTERVAL_SECONDS, undefined);
  assert.equal(makePlan({ ...env(), WORKSPACE_PROVISIONER_INTERVAL_SECONDS: ' 30 ' })[1].env.WORKSPACE_PROVISIONER_INTERVAL_SECONDS, '30');
});

test('A6 interval bounds: whole seconds from 5 to 120 accepted; anything else refused when the provisioner is enabled', () => {
  for (const ok of ['5', '6', '60', '119', '120', '']) {
    const [, prov] = makePlan({ ...env(), WORKSPACE_PROVISIONER_INTERVAL_SECONDS: ok });
    assert.equal(prov.env.WORKSPACE_PROVISIONER_INTERVAL_SECONDS, ok === '' ? '60' : ok, ok);
  }
  for (const bad of ['0', '4', '121', '3600', '-5', '5.5', '1e2', '60s', 'sixty', '0x10']) {
    const e = refusal({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: bad });
    assert.ok(e, bad);
    assert.match(e.message, /^WORKSPACE_PROVISIONER_INTERVAL_SECONDS must be a whole number of seconds from 5 to 120$/, bad);
  }
  // A disabled provisioner ignores it (never forwarded, nothing to validate).
  assert.equal(makePlan(disabledEnv({ WORKSPACE_PROVISIONER_INTERVAL_SECONDS: 'garbage' })).length, 1);
});

test('A7 launcher interval bounds equal the provisioner entrypoint constants (repo checkout only)', () => {
  const file = path.resolve(__dirname, '../../../../rab-worker/src/workspace-provisioner.config.ts');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const constant = (name) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(text)?.[1]);
  assert.equal(constant('PROVISIONER_INTERVAL_DEFAULT_SECONDS'), PROVISIONER_INTERVAL.defaultSeconds);
  assert.equal(constant('PROVISIONER_INTERVAL_LEGACY_DEFAULT_SECONDS'), PROVISIONER_INTERVAL.legacyDefaultSeconds);
  assert.equal(constant('PROVISIONER_INTERVAL_MIN_SECONDS'), PROVISIONER_INTERVAL.minSeconds);
  assert.equal(constant('PROVISIONER_INTERVAL_MAX_SECONDS'), PROVISIONER_INTERVAL.maxSeconds);
  // The longest interval plus a slow cycle must still settle inside the health window.
  assert.ok(PROVISIONER_INTERVAL.maxSeconds * 1000 * 2 <= health.ROLES.provisioner.settledMaxAgeMs);
});

test('A8 health: a disabled provisioner is not expected; an enabled or legacy one still is; an invalid flag is null (fail closed)', () => {
  // Unset/empty = legacy = the provisioner runs, so the health check must still expect it.
  assert.deepEqual(Object.keys(health.rolesFor({})).sort(), ['jobs', 'provisioner']);
  assert.deepEqual(Object.keys(health.rolesFor({ CREWFLOW_PROVISIONER_ENABLED: '' })).sort(), ['jobs', 'provisioner']);
  assert.deepEqual(Object.keys(health.rolesFor({ CREWFLOW_PROVISIONER_ENABLED: 'false' })), ['jobs']);
  assert.deepEqual(Object.keys(health.rolesFor({ CREWFLOW_PROVISIONER_ENABLED: 'true' })).sort(), ['jobs', 'provisioner']);
  assert.equal(health.rolesFor({ CREWFLOW_PROVISIONER_ENABLED: 'yes' }), null);
  assert.deepEqual(['true', 'false', '', undefined, 'yes'].map((v) => health.provisionerMode(v === undefined ? {} : { CREWFLOW_PROVISIONER_ENABLED: v })), ['on', 'off', 'legacy', 'legacy', null]);
  const jobsOnly = { [J]: goodBeat('jobs', 100) };
  const off = { CREWFLOW_PROVISIONER_ENABLED: 'false' };
  const disabled = health.evaluate({ now: NOW, roles: health.rolesFor(off), read: (f) => jobsOnly[f] ?? null, uidOf: uidOf({ 100: 1000 }) });
  assert.equal(disabled.healthy, true, JSON.stringify(disabled));
  const enabled = health.evaluate({ now: NOW, roles: health.rolesFor({ CREWFLOW_PROVISIONER_ENABLED: 'true' }), read: (f) => jobsOnly[f] ?? null, uidOf: uidOf({ 100: 1000 }) });
  assert.equal(enabled.healthy, false);
  assert.match(enabled.roles.find((r) => r.role === 'provisioner').problems.join('; '), /no heartbeat file/);
  // A dead jobs child is still unhealthy when the provisioner is disabled.
  const dead = health.evaluate({ now: NOW, roles: health.rolesFor(off), read: (f) => jobsOnly[f] ?? null, uidOf: uidOf({}) });
  assert.equal(dead.healthy, false);
});

test('A9 health CLI: exits 1 on an invalid flag without echoing it', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '../worker-bundle-health.cjs')], { env: { PATH: process.env.PATH, CREWFLOW_PROVISIONER_ENABLED: 'maybe' }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /CREWFLOW_PROVISIONER_ENABLED must be "true" or "false"/);
  assert.ok(!r.stdout.includes('maybe'));
});

test('A10 main() refuses explicitly disabled + provisioner URL with exit 1, naming the variable only', async () => {
  const captured = [];
  const original = console.error;
  console.error = (...a) => captured.push(a.join(' '));
  try {
    const e = { ...env(), CREWFLOW_PROVISIONER_ENABLED: 'false', CREWFLOW_BUNDLE_FAILURE_EXIT_DELAY_MS: '0' };
    assert.equal(await launcher.main(e), 1);
  } finally {
    console.error = original;
  }
  assert.ok(captured.some((l) => /refused: CREWFLOW_PROVISIONER_DATABASE_URL is set but the workspace provisioner is disabled/.test(l)), captured.join('\n'));
  for (const marker of SECRET_MARKERS) assert.ok(!captured.join('\n').includes(marker));
});

test('A11 preflight (disabled): no provisioner entrypoint/temp/health directory required; code still not writable by either identity', { skip: !linuxRoot && 'needs root on Linux' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-pre-a-'));
  try {
    const layout = {
      root,
      jobs: { uid: 1000, gid: 1000, home: path.join(root, 'tmp-jobs'), healthFile: path.join(root, 'health/jobs/heartbeat.json') },
      provisioner: { uid: 10001, gid: 10001, home: path.join(root, 'tmp-prov'), healthFile: path.join(root, 'health/provisioner/heartbeat.json') },
    };
    const dist = path.join(root, 'packages/rab-worker/dist');
    fs.mkdirSync(dist, { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.join(root, 'node_modules'), { mode: 0o755 });
    fs.chmodSync(root, 0o755);
    fs.writeFileSync(path.join(dist, 'main.js'), '', { mode: 0o444 }); // no provisioner entrypoint at all
    for (const [d, uid, mode] of [[layout.jobs.home, 1000, 0o700], [path.dirname(layout.jobs.healthFile), 1000, 0o755]]) {
      fs.mkdirSync(d, { recursive: true });
      fs.chownSync(d, uid, uid);
      fs.chmodSync(d, mode);
    }
    const plan = makePlan(disabledEnv(), layout);
    preflight(plan, layout); // passes without the provisioner's entrypoint, temp dir or health dir
    fs.chownSync(path.join(dist, 'main.js'), 10001, 10001);
    assert.throws(() => preflight(plan, layout), /writable by a child identity: packages\/rab-worker\/dist\/main.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('A12 supervise (disabled plan): exactly one child runs, as uid 1000, with no provisioner key in its environment', { skip: !linuxRoot && 'needs root on Linux' }, async () => {
  const fx = fixtures({
    'introspect.cjs': "console.log(JSON.stringify({keys:Object.keys(process.env).sort(),uid:process.getuid()})); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);",
  });
  const signals = new EventEmitter();
  try {
    const plan = makePlan(disabledEnv({ NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development' }));
    assert.equal(plan.length, 1);
    const reports = [];
    const logs = [];
    const specs = plan.map((p) => Object.assign(spec(fx, p.name, 'introspect.cjs', p.uid, p.gid), { env: { ...p.env } }));
    const pending = supervise(specs, quiet({ graceMs: 3000, signals, log: (s) => logs.push(s), out: (n, l) => { try { reports.push({ n, r: JSON.parse(l) }); } catch { /* not ours */ } } }));
    await waitFor(() => reports.length === 1);
    assert.equal(launcher.processesOwnedBy(new Set([10001])).length, 0, 'no process runs as the provisioner identity');
    signals.emit('SIGTERM');
    assert.equal(await pending, 0);
    assert.equal(reports[0].n, 'jobs');
    assert.equal(reports[0].r.uid, 1000);
    for (const key of PROVISIONER_ONLY_KEYS) assert.ok(!reports[0].r.keys.includes(key), key);
    assert.equal(logs.filter((l) => /started pid=/.test(l)).length, 1, logs.join('\n'));
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------- Phase B: one PG_DATABASE_URL per process

test('B1 a production Worker service refuses the legacy database names, by name only', () => {
  for (const key of ['DATABASE_URL', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX']) {
    const e = refusal({ [key]: key === 'DB_POOL_MAX' ? '10' : 'postgres://crewflow_app:dummy-app-pw@db.example:5432/testdb' });
    assert.ok(e, key);
    assert.match(e.message, new RegExp(`^${key} is a deprecated name a production Worker service must not carry`));
    for (const marker of SECRET_MARKERS) assert.ok(!e.message.includes(marker));
  }
  // Production requires PG_DATABASE_URL even when a legacy name would have been accepted outside production.
  const e = { ...env() };
  delete e.PG_DATABASE_URL;
  assert.throws(() => makePlan(e), /^BundleConfigError: Missing PG_DATABASE_URL$/);
});

test('B2 outside production the deprecated names still plan (DATABASE_URL + DATABASE_DIRECT_URL forwarded to jobs only)', () => {
  const [jobs, prov] = makePlan(legacyEnv());
  assert.match(jobs.env.DATABASE_URL, /crewflow_app/);
  assert.match(jobs.env.DATABASE_DIRECT_URL, /crewflow_app/);
  assert.equal(prov.env.PG_DATABASE_URL, legacyEnv().CREWFLOW_PROVISIONER_DATABASE_URL);
  assert.equal(prov.env.DATABASE_URL, undefined);
  assert.equal(prov.env.DATABASE_URL_UNPOOLED, undefined);
});

test('B3 the bootstrap flag of an unbound production database is refused on the Worker service', () => {
  assert.match(refusal({ CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'unbound-production-database' }).message, /^CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP must not be configured/);
});
