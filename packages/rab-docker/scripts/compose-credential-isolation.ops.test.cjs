'use strict';
/**
 * rab-ops removal (PR 2, plan §2.6): compose-credential-isolation.cjs keeps refusing the retired operations container and
 * its environment. Each case below is one refusal: a rab-ops service, an "ops" profile, a service naming .env.ops, a value
 * from the .env.ops sentinel, and each of the five ops-only names (CREWFLOW_OPS_*, PG_OPS_*).
 *
 *   node --test packages/rab-docker/scripts/compose-credential-isolation.ops.test.cjs
 *
 * The pure cases need nothing; the rendered case needs `docker compose` (reported as skipped without it; CI has it).
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { opsRefusalChecks, render, OPS_ONLY_NAMES, OPS_SENTINEL_PASSWORD, OPS_SENTINEL_APP_URL } = require('./compose-credential-isolation.cjs');

const REL = 'fixture.yml';
const failed = (checks) => checks.filter(([ok]) => !ok).map(([, label]) => label);
const refused = (checks, re) => {
  const f = failed(checks);
  assert.ok(f.some((l) => re.test(l)), `expected a failed check matching ${re}; failed: ${JSON.stringify(f)}`);
};
const clean = () => ({
  'rab-api': { environment: { PG_DATABASE_URL: 'postgresql://crewflow_owner:x@db:5432/rab', NODE_ENV: 'production' } },
  'rab-worker': { environment: { PG_DATABASE_URL: 'postgresql://crewflow_owner:x@db:5432/rab' } },
  'rab-redis': {},
});
const cleanRaw = () => ({ 'rab-api': ['/secrets/database.env'], 'rab-worker': ['/secrets/database.env'], 'rab-redis': [] });

test('the committed shape (no rab-ops, nothing of the ops environment) passes every check', () => {
  assert.deepEqual(failed(opsRefusalChecks(REL, clean(), cleanRaw())), []);
  assert.deepEqual(failed(opsRefusalChecks(REL, clean(), null)), []);
});

test('the gate still lists exactly the five retired ops names', () => {
  assert.deepEqual([...OPS_ONLY_NAMES].sort(), [
    'CREWFLOW_OPS_ACTOR_ID', 'CREWFLOW_OPS_ACTOR_SOURCE', 'CREWFLOW_OPS_CHANGE_REF', 'CREWFLOW_OPS_RUN', 'PG_OPS_APP_DATABASE_URL',
  ]);
});

test('DENIAL: a rab-ops service is present (with or without the old profile)', () => {
  const s = clean();
  s['rab-ops'] = { environment: {} };
  refused(opsRefusalChecks(REL, s, null), /has no rab-ops service/);
  s['rab-ops'].profiles = ['ops'];
  refused(opsRefusalChecks(REL, s, null), /has no rab-ops service/);
  refused(opsRefusalChecks(REL, s, null), /rab-ops has no "ops" profile/);
});

test('DENIAL: any service under the "ops" profile, whatever its name', () => {
  const s = clean();
  s.operations = { profiles: ['ops'], environment: {} };
  refused(opsRefusalChecks(REL, s, null), /operations has no "ops" profile/);
});

test('DENIAL: a service naming .env.ops as its env_file (every path spelling)', () => {
  for (const f of ['.env.ops', './.env.ops', 'packages/rab-docker/.env.ops']) {
    const raw = cleanRaw();
    raw['rab-worker'] = [...raw['rab-worker'], f];
    refused(opsRefusalChecks(REL, clean(), raw), /rab-worker does not name \.env\.ops/);
  }
});

test('DENIAL: a value from the .env.ops sentinel reaching a service', () => {
  for (const svc of ['rab-api', 'rab-worker']) {
    const s = clean();
    s[svc].environment.SOME_URL = OPS_SENTINEL_APP_URL;
    refused(opsRefusalChecks(REL, s, null), new RegExp(`${svc} carries no value of the ops environment`));
  }
});

test('DENIAL: each retired ops-only name (PG_OPS_* / CREWFLOW_OPS_*) on any service', () => {
  for (const name of OPS_ONLY_NAMES) {
    for (const svc of ['rab-api', 'rab-worker', 'rab-redis']) {
      const s = clean();
      (s[svc].environment ??= {})[name] = 'one-off';
      refused(opsRefusalChecks(REL, s, null), new RegExp(`${svc} holds no ops-only variable \\(${name}\\)`));
    }
  }
});

test('an ops-only name declared EMPTY is not a value (compose renders an unset `KEY:` as empty)', () => {
  const s = clean();
  s['rab-api'].environment.CREWFLOW_OPS_RUN = '';
  assert.deepEqual(failed(opsRefusalChecks(REL, s, null)), []);
});

function dockerCompose() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('DENIAL (rendered): a file that reads .env.ops, or re-adds rab-ops under the ops profile, fails', { skip: !dockerCompose() && 'docker compose not available' }, () => {
  const repo = path.resolve(__dirname, '../../..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-ops-'));
  try {
    const file = path.join(dir, 'c.yml');
    fs.writeFileSync(file, [
      'services:',
      '  rab-api:',
      '    image: r',
      '    env_file: [.env.ops]',
      '  rab-worker: { image: r }',
      '  rab-ops:',
      '    image: r',
      '    profiles: ["ops"]',
      '',
    ].join('\n'));
    // render() plants the sentinel .env.ops in its throw-away project and renders with --profile ops.
    const model = render(path.relative(repo, file));
    const checks = opsRefusalChecks('rendered', model.services ?? {}, null);
    refused(checks, /has no rab-ops service/);
    refused(checks, /rab-ops has no "ops" profile/);
    refused(checks, /rab-api carries no value of the ops environment/);
    refused(checks, /rab-api holds no ops-only variable \(.*CREWFLOW_OPS_RUN/);
    refused(checks, /rab-api holds no ops-only variable \(.*PG_OPS_APP_DATABASE_URL/);
    assert.ok(!JSON.stringify(failed(checks)).includes(OPS_SENTINEL_PASSWORD), 'a failed-check label never prints a value');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// DB-SETUP (owner decisions D1 a / D4, T-2): the bundled db's superuser password is a compose interpolation value only.
test('DB-SETUP: the bundled db password may appear only as db POSTGRES_PASSWORD; no service has a PG_DATABASE_PASSWORD variable', () => {
  const { dbPasswordChecks, DB_SENTINEL_PASSWORD } = require('./compose-credential-isolation.cjs');
  const ok = { ...clean(), db: { environment: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: DB_SENTINEL_PASSWORD } } };
  assert.deepEqual(failed(dbPasswordChecks(REL, ok)), []);
  for (const [svc, key] of [['rab-api', 'PG_DATABASE_URL'], ['rab-worker', 'X'], ['rab-redis', 'Y'], ['db', 'OTHER']]) {
    const m = structuredClone(ok);
    m[svc].environment = { ...(m[svc].environment ?? {}), [key]: `postgresql://postgres:${DB_SENTINEL_PASSWORD}@db:5432/crewflow` };
    refused(dbPasswordChecks(REL, m), new RegExp(`${svc} carries the bundled db's password only as db's POSTGRES_PASSWORD \\(found in ${key}\\)`));
  }
  for (const svc of ['rab-api', 'rab-worker', 'db']) {
    const m = structuredClone(ok);
    m[svc].environment = { ...m[svc].environment, PG_DATABASE_PASSWORD: 'x' };
    refused(dbPasswordChecks(REL, m), new RegExp(`${svc} has no PG_DATABASE_PASSWORD variable`));
  }
});
