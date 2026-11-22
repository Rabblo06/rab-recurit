'use strict';
/**
 * Tests for verify-digitalocean.cjs (the DigitalOcean deployment shape; owner decisions 24, 25, 26, 53).
 *
 *   node --test packages/rab-docker/digitalocean/verify-digitalocean.test.cjs
 *
 * The lint and ACL cases need nothing. The rendered cases need `docker compose` (CLI only: `config` renders, nothing runs)
 * and skip without it locally; CI (ci-security.yaml, deployment-config) requires it. Every negative case changes ONE thing
 * and proves the gate refuses that specific weakening.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const v = require('./verify-digitalocean.cjs');

const skip = v.composeAvailable() ? false : 'docker compose is not available';
const assertRefused = (problems, pattern) => {
  assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}; got: ${problems.join(' | ') || '(none)'}`);
};
const read = (f) => fs.readFileSync(f, 'utf8');
const composeTemplate = () => v.materialise(read(v.TEMPLATES.compose));
const databaseTemplate = () => v.materialise(read(v.TEMPLATES.database));
const aclTemplate = () => v.materialise(read(v.TEMPLATES.acl));
/** Applies `fn` to the PG_ADMIN_URL line only (the comments mention sslmode too). */
const adminLine = (text, fn) => text.split('\n').map((l) => (l.startsWith('PG_ADMIN_URL=') ? fn(l) : l)).join('\n');
/** Sets (or, with null, removes) KEY in env text. */
const withKey = (text, key, value) => {
  const lines = text.split('\n').filter((l) => !new RegExp(`^${key}=`).test(l));
  if (value !== null) lines.push(`${key}=${value}`);
  return `${lines.join('\n')}\n`;
};

let model;
const fresh = () => {
  model ??= v.render();
  return structuredClone(model);
};
const problemsAfter = (mutate) => {
  const m = fresh();
  mutate(m);
  return v.checkModel(m);
};

// ---------------------------------------------------------------------------------------------------------- templates

test('the committed DigitalOcean templates pass the DigitalOcean rules and the generic env-file lint', () => {
  assert.deepEqual(v.templateProblems(), []);
});

test('the templates hold no secret: every credential is a <placeholder>', () => {
  for (const f of [v.TEMPLATES.compose, v.TEMPLATES.database, v.TEMPLATES.runtime, v.TEMPLATES.acl]) {
    const text = read(f);
    assert.doesNotMatch(text, /#[0-9a-f]{64}\b/, `${path.basename(f)}: a real password hash`);
    for (const line of text.split('\n').filter((l) => /^[A-Z_]+=/.test(l))) {
      const [key, ...rest] = line.split('=');
      const value = rest.join('=');
      if (/PASSWORD|SECRET(?!S_DIR)|_KEY$|KEY_ID$/.test(key)) assert.match(value, /^<[a-z0-9-]+>$/, `${path.basename(f)}: ${key} is not a placeholder`);
      if (/:\/\/[^/@\s]+@/.test(value)) assert.match(value, /:\/\/[^:]+:<[a-z0-9-]+>@/, `${path.basename(f)}: ${key} carries a credential`);
    }
  }
});

test('the connection-budget constants match connection-budget.ts (the lint computes the same total as the API)', () => {
  const ts = read(path.resolve(__dirname, '../../rab-server/src/database/runtime/connection-budget.ts'));
  const num = (name) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(ts)?.[1]);
  assert.equal(v.BUDGET.workerDirect, num('WORKER_DIRECT_POOL_MAX_BUDGET'));
  assert.equal(v.BUDGET.workerLocks, num('WORKER_SCAN_LOCK_CONNECTIONS') + num('WORKER_STORAGE_LOCK_CONNECTIONS'));
  assert.equal(v.BUDGET.workerProvisioner, num('WORKER_PROVISIONER_CONNECTIONS'));
  assert.equal(v.BUDGET.apiHealthProbe, num('API_HEALTH_LOGIN_PROBE_CONNECTIONS'));
  assert.equal(v.BUDGET.bootProbes, num('BOOT_PROBE_ALLOWANCE'));
  assert.equal(v.BUDGET.apiPoolDefault, num('DEFAULT_API_POOL_MAX'));
  assert.equal(v.BUDGET.workerPoolDefault, num('DEFAULT_WORKER_POOL_MAX'));
  assert.equal(v.BUDGET.migrateDefault, num('DEFAULT_MIGRATE_CONNECTIONS'));
});

test('the DigitalOcean runtime template fits the 2 GiB plan: 40 of 47 connections', () => {
  const b = v.connectionBudget(v.digitalOceanRuntimeText());
  assert.equal(b.total, 40);
  assert.ok(b.total <= v.DO_PLAN_CONNECTIONS);
});

// --------------------------------------------------------------------------------------------------------- compose.env

test('compose.env: the pool port 25061 is refused, in the admin URL and in PG_DATABASE_PORT', () => {
  const t = composeTemplate();
  assertRefused(v.lintComposeEnv(t.replace(':25060/', ':25061/')), /PG_ADMIN_URL: port 25061 is the connection POOL/);
  assertRefused(v.lintComposeEnv(withKey(t, 'PG_DATABASE_PORT', '25061')), /PG_DATABASE_PORT: must be the direct port 25060 \(25061 is the connection pool\)/);
});

test('compose.env: sslmode other than verify-full is refused (the generic gate would accept require / verify-ca)', () => {
  for (const mode of ['require', 'verify-ca', 'prefer', 'disable']) {
    assertRefused(v.lintComposeEnv(adminLine(composeTemplate(), (l) => l.replace('sslmode=verify-full', `sslmode=${mode}`))), /PG_ADMIN_URL: sslmode must be verify-full/);
  }
  assertRefused(v.lintComposeEnv(adminLine(composeTemplate(), (l) => l.replace('?sslmode=verify-full', ''))), /sslmode must be verify-full/);
});

test('compose.env: a host that is not DigitalOcean Managed PostgreSQL is refused', () => {
  assertRefused(v.lintComposeEnv(composeTemplate().replace(/@[^:]+:25060/, '@db.neon.example:25060')), /PG_ADMIN_URL: the host is not a DigitalOcean/);
  assertRefused(v.lintComposeEnv(withKey(composeTemplate(), 'PG_DATABASE_HOST', 'other-host.db.ondigitalocean.com')), /PG_DATABASE_HOST: must be the same host as PG_ADMIN_URL/);
});

test('compose.env: the bundled db, a bundled password, defaultdb and a missing CA are refused', () => {
  assertRefused(v.lintComposeEnv(withKey(composeTemplate(), 'CREWFLOW_BUNDLED_DB', '1')), /CREWFLOW_BUNDLED_DB: must be 0/);
  assertRefused(v.lintComposeEnv(withKey(composeTemplate(), 'CREWFLOW_BUNDLED_DB', null)), /CREWFLOW_BUNDLED_DB: must be 0/);
  assertRefused(v.lintComposeEnv(withKey(composeTemplate(), 'PG_DATABASE_PASSWORD', 'x'.repeat(64))), /PG_DATABASE_PASSWORD: must not be set/);
  assertRefused(v.lintComposeEnv(composeTemplate().replace('25060/crewflow?', '25060/defaultdb?')), /PG_ADMIN_URL: names defaultdb/);
  assertRefused(v.lintComposeEnv(withKey(composeTemplate(), 'CREWFLOW_PG_CA_FILE', null)), /CREWFLOW_PG_CA_FILE/);
  assertRefused(v.lintComposeEnv(withKey(composeTemplate(), 'PG_ADMIN_URL', null)), /PG_ADMIN_URL: missing/);
});

test('compose.env: the owner URL must be crewflow_owner on the same database; never both forms', () => {
  const t = composeTemplate();
  const owner = `postgresql://crewflow_owner:${'a'.repeat(64)}@${v.SENTINEL_HOST}:25060/crewflow?sslmode=verify-full`;
  assertRefused(v.lintComposeEnv(withKey(t, 'PG_DATABASE_URL', owner)), /set the whole URL or its parts, never both/);
  const urlOnly = ['PG_DATABASE_APP_PASSWORD', 'PG_DATABASE_HOST', 'PG_DATABASE_PORT', 'PG_DATABASE_NAME'].reduce((s, k) => withKey(s, k, null), t);
  assert.deepEqual(v.lintComposeEnv(withKey(urlOnly, 'PG_DATABASE_URL', owner)), []);
  assertRefused(v.lintComposeEnv(withKey(urlOnly, 'PG_DATABASE_URL', owner.replace('crewflow_owner', 'doadmin'))), /must log in as crewflow_owner/);
  assertRefused(v.lintComposeEnv(withKey(urlOnly, 'PG_DATABASE_URL', owner.replace('/crewflow?', '/other?'))), /same host, port and database as PG_ADMIN_URL/);
  assertRefused(v.lintComposeEnv(t.replace('postgresql://doadmin:', 'postgresql://crewflow_owner:')), /PG_ADMIN_URL: must be the admin login/);
});

test('compose.env: AI on and an open API bind are refused', () => {
  assertRefused(v.lintComposeEnv(withKey(composeTemplate(), 'AI_ENABLED', 'true')), /AI_ENABLED: AI stays off/);
  assertRefused(v.lintComposeEnv(withKey(composeTemplate(), 'CREWFLOW_API_BIND', '0.0.0.0')), /CREWFLOW_API_BIND: must be 127\.0\.0\.1/);
});

test('the CLI prints names and reasons, never a value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'do-lint-'));
  try {
    const f = path.join(dir, 'compose.env');
    fs.writeFileSync(f, adminLine(composeTemplate(), (l) => l.replace('sslmode=verify-full', 'sslmode=require').replace(':25060/', ':25061/')));
    let out = '';
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'verify-digitalocean.cjs'), '--lint-env-file', 'compose', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.fail('the lint accepted a pool port and sslmode=require');
    } catch (e) {
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      assert.equal(e.status, 1);
    }
    assert.match(out, /FAIL/);
    assert.ok(!out.includes(v.SENTINEL_ADMIN_PW), 'the admin password was printed');
    assert.ok(!out.includes(v.SENTINEL_HOST), 'the database host was printed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ database / runtime

test('database.env: the mounted cluster CA is required; inline PEM, self-signed and defaultdb are refused', () => {
  assert.deepEqual(v.lintDatabaseEnv(databaseTemplate()), []);
  assertRefused(v.lintDatabaseEnv(withKey(databaseTemplate(), 'PG_SSL_CA_CERT_PATH', null)), /PG_SSL_CA_CERT_PATH: must be \/run\/crewflow\/pg-ca\.crt/);
  assertRefused(v.lintDatabaseEnv(withKey(databaseTemplate(), 'PG_SSL_CA_CERT', '-----BEGIN CERTIFICATE-----')), /PG_SSL_CA_CERT: use the mounted file/);
  assertRefused(v.lintDatabaseEnv(withKey(databaseTemplate(), 'PG_SSL_ALLOW_SELF_SIGNED', 'true')), /never in production/);
  assertRefused(v.lintDatabaseEnv(withKey(databaseTemplate(), 'PG_EXPECTED_DATABASE_NAME', 'defaultdb')), /defaultdb/);
});

test('runtime.env: TRUSTED_PROXY_CIDRS must be exactly the fixed gateway', () => {
  const r = v.digitalOceanRuntimeText();
  assert.deepEqual(v.lintRuntimeEnv(r), []);
  for (const bad of ['127.0.0.1/32', '172.16.30.0/24', '0.0.0.0/0', '172.16.30.1/32,10.0.0.1/32']) {
    assertRefused(v.lintRuntimeEnv(withKey(r, 'TRUSTED_PROXY_CIDRS', bad)), /TRUSTED_PROXY_CIDRS: must be exactly 172\.16\.30\.1\/32/);
  }
});

test('runtime.env: Redis without a password, as the default user, or not the compose service is refused', () => {
  const r = v.digitalOceanRuntimeText();
  assertRefused(v.lintRuntimeEnv(withKey(r, 'REDIS_URL', 'redis://rab-redis:6379')), /REDIS_URL: has no password/);
  assertRefused(v.lintRuntimeEnv(withKey(r, 'REDIS_URL', 'redis://:pw@rab-redis:6379')), /REDIS_URL: must log in as the ACL app user/);
  assertRefused(v.lintRuntimeEnv(withKey(r, 'REDIS_URL', 'redis://default:pw@rab-redis:6379')), /REDIS_URL: must log in as the ACL app user/);
  assertRefused(v.lintRuntimeEnv(withKey(r, 'REDIS_URL', 'redis://crewflow:pw@redis.example.com:6379')), /REDIS_URL: must name the compose service rab-redis/);
});

test('runtime.env: a budget above the 2 GiB plan, a second API or Worker, or a pool above its budget is refused', () => {
  const r = v.digitalOceanRuntimeText();
  assertRefused(v.lintRuntimeEnv(withKey(withKey(r, 'PG_EXPECTED_API_POOL_MAX', '20'), 'PG_POOL_MAX_CONNECTIONS', '20')), /connection budget: up to 51 connections, more than the 2 GiB plan's 47/);
  assertRefused(v.lintRuntimeEnv(withKey(r, 'PG_EXPECTED_API_INSTANCES', '2')), /PG_EXPECTED_API_INSTANCES: must be 1/);
  assertRefused(v.lintRuntimeEnv(withKey(r, 'PG_EXPECTED_WORKER_INSTANCES', '2')), /PG_EXPECTED_WORKER_INSTANCES: must be 1/);
  assertRefused(v.lintRuntimeEnv(withKey(r, 'PG_POOL_MAX_CONNECTIONS', '10')), /PG_POOL_MAX_CONNECTIONS: larger than PG_EXPECTED_API_POOL_MAX/);
  assertRefused(v.lintRuntimeEnv(withKey(r, 'PG_EXPECTED_WORKER_POOL_MAX', '8')), /must be 12/);
  assertRefused(v.lintRuntimeEnv(withKey(r, 'APP_URL', 'http://console.example.com')), /APP_URL: must be an https/);
});

// ---------------------------------------------------------------------------------------------------------- Redis ACL

test('ACL: the template passes; the default user must be ON with its own SHA-256 password', () => {
  assert.deepEqual(v.lintRedisAcl(aclTemplate()), []);
  const acl = aclTemplate();
  const def = (fn) => acl.split('\n').map((l) => (l.startsWith('user default ') ? fn(l) : l)).join('\n');
  assertRefused(v.lintRedisAcl(def((l) => l.replace(' on ', ' off '))), /user default: must be ON with a password/);
  assertRefused(v.lintRedisAcl(def((l) => l.replace(/#b{64}/, 'nopass'))), /user default: enabled without a password/);
  assertRefused(v.lintRedisAcl(def((l) => l.replace(/#b{64}/, '>plaintext'))), /a clear-text password/);
  assertRefused(v.lintRedisAcl(def((l) => l.replace(/#b{64}/, `#${'a'.repeat(64)}`))), /must not share the crewflow user's password/);
  assertRefused(v.lintRedisAcl(def((l) => l.replace(' -@dangerous', ''))), /exactly the crewflow user's command and key permissions/);
  assertRefused(v.lintRedisAcl(def((l) => l.replace(/ \+@all.*$/, ' -@all'))), /exactly the crewflow user's command and key permissions/);
  assertRefused(v.lintRedisAcl(acl.split('\n').filter((l) => !l.startsWith('user default ')).join('\n')), /user default: missing/);
  assertRefused(v.lintRedisAcl(def((l) => l.replace(/#b{64}/, '#BADHASH'))), /not 64 lower-case hex/);
});

test('ACL: the app user needs its password; only the PING-only health-check user may have none', () => {
  const acl = aclTemplate();
  assertRefused(v.lintRedisAcl(acl.replace(/user crewflow on #a{64}/, 'user crewflow on nopass')), /user crewflow: enabled without a password/);
  assertRefused(v.lintRedisAcl(acl.replace('user healthcheck on nopass resetkeys resetchannels -@all +ping', 'user healthcheck on nopass resetkeys resetchannels +@all')), /user healthcheck: must be PING-only/);
  assertRefused(v.lintRedisAcl(`${acl}\nuser extra on nopass ~* +@all\n`), /user extra: enabled without a password/);
  assertRefused(v.lintRedisAcl(`${acl}\nnot an acl line\n`), /not a "user <name> <rules>" line/);
});

// ------------------------------------------------------------------------------------------------- the rendered shape

test('the committed shape (image.yml + the DigitalOcean override) passes every check', { skip }, () => {
  assert.deepEqual(v.checkModel(fresh()), []);
});

test('the rendered shape: the bundled db off, isolation enforce, the fixed edge subnet, loopback-only API', { skip }, () => {
  const m = fresh();
  assert.equal(m.services.db.deploy.replicas, 0);
  for (const s of ['rab-api', 'rab-worker']) assert.equal(m.services[s].environment.CREWFLOW_RUNTIME_ISOLATION, 'enforce');
  assert.deepEqual(m.networks.default.ipam.config, [{ subnet: v.EDGE_SUBNET, gateway: v.EDGE_GATEWAY }]);
  assert.equal(m.services['rab-api'].ports[0].host_ip, '127.0.0.1');
  assert.equal(m.services['db-setup'].environment.CREWFLOW_BUNDLED_DB, '0');
});

const WEAKENINGS = [
  ['the bundled db back on', (m) => { m.services.db.deploy.replicas = 1; }, /db: the bundled database must have 0 replicas/],
  ['isolation warn on rab-api', (m) => { m.services['rab-api'].environment.CREWFLOW_RUNTIME_ISOLATION = 'warn'; }, /rab-api: CREWFLOW_RUNTIME_ISOLATION must be enforce/],
  ['isolation removed on rab-worker', (m) => { delete m.services['rab-worker'].environment.CREWFLOW_RUNTIME_ISOLATION; }, /rab-worker: CREWFLOW_RUNTIME_ISOLATION must be enforce/],
  ['read_only dropped (OpenShip)', (m) => { delete m.services['rab-worker'].read_only; }, /rab-worker: read_only must be true/],
  ['user dropped (OpenShip)', (m) => { delete m.services['rab-api'].user; }, /rab-api: user must be a non-root numeric uid/],
  ['root user', (m) => { m.services['db-setup'].user = '0:0'; }, /db-setup: user must be a non-root numeric uid/],
  ['cap_drop dropped (OpenShip)', (m) => { delete m.services['rab-redis'].cap_drop; }, /rab-redis: cap_drop must include ALL/],
  ['cap_add', (m) => { m.services['rab-api'].cap_add = ['NET_RAW']; }, /rab-api: cap_add must be empty/],
  ['no-new-privileges dropped (OpenShip)', (m) => { delete m.services['db-harden'].security_opt; }, /db-harden: security_opt no-new-privileges is missing/],
  ['pids_limit dropped (OpenShip)', (m) => { delete m.services['rab-worker'].pids_limit; }, /rab-worker: pids_limit is missing/],
  ['mem_limit dropped', (m) => { delete m.services['rab-api'].mem_limit; }, /rab-api: mem_limit is missing/],
  ['worker tmpfs dropped (OpenShip)', (m) => { delete m.services['rab-worker'].tmpfs; }, /rab-worker: tmpfs \/tmp\/crewflow-jobs is missing/],
  ['env_file dropped (OpenShip)', (m) => { delete m.services['rab-api'].env_file; }, /rab-api: env_file database\.env is missing/],
  ['runtime.env reaches db-setup', (m) => { m.services['db-setup'].env_file.push({ path: '/etc/crewflow/secrets/runtime.env' }); }, /db-setup: env_file must be database\.env only/],
  ['depends_on condition dropped (OpenShip)', (m) => { m.services['rab-api'].depends_on['db-setup'] = {}; }, /rab-api: must wait for db-setup/],
  ['Worker beside a new API', (m) => { m.services['rab-worker'].depends_on['rab-api'].restart = false; }, /rab-worker: must wait for a healthy rab-api with restart: true/],
  ['privileged', (m) => { m.services['rab-api'].privileged = true; }, /rab-api: privileged/],
  ['host network', (m) => { m.services['rab-worker'].network_mode = 'host'; }, /rab-worker: network_mode host/],
  ['Docker socket', (m) => { m.services['rab-worker'].volumes.push({ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock', read_only: true }); }, /rab-worker: mounts the Docker socket/],
  ['unbounded logs', (m) => { m.services['rab-api'].logging = { driver: 'json-file' }; }, /rab-api: logs are not bounded/],
  ['API on every interface', (m) => { m.services['rab-api'].ports[0].host_ip = '0.0.0.0'; }, /rab-api: must publish exactly one port, on 127\.0\.0\.1/],
  ['Redis published', (m) => { m.services['rab-redis'].ports = [{ host_ip: '127.0.0.1', target: 6379, published: '6379' }]; }, /rab-redis: publishes a port/],
  ['OpenShip import guard removed', (m) => { m.services['rab-api'].volumes = m.services['rab-api'].volumes.filter((x) => x.type !== 'tmpfs'); }, /the OpenShip import guard\) is missing/],
  ['Redis without its ACL', (m) => { const c = m.services['rab-redis'].command; c.splice(c.indexOf('--aclfile'), 2); }, /rab-redis: --aclfile/],
  ['Redis ACL writable', (m) => { m.services['rab-redis'].volumes.find((x) => /acl/.test(x.target)).read_only = false; }, /rab-redis: the ACL file is not mounted read-only/],
  ['edge subnet removed', (m) => { delete m.networks.default.ipam; }, /network default: must have exactly subnet 172\.16\.30\.0\/24/],
  ['edge subnet changed', (m) => { m.networks.default.ipam.config[0].gateway = '172.16.30.254'; }, /network default: must have exactly subnet/],
  ['db network not internal', (m) => { m.networks['crewflow-db'].internal = false; }, /network crewflow-db is not internal/],
  ['admin URL on rab-api', (m) => { m.services['rab-api'].environment.PG_ADMIN_URL = 'postgresql://doadmin:x@h:25060/crewflow'; }, /rab-api: receives the database admin URL/],
  ['cluster CA not mounted', (m) => { m.services['rab-worker'].volumes.find((x) => x.target === '/run/crewflow/pg-ca.crt').source = '/dev/null'; }, /rab-worker: the cluster CA/],
  ['owner URL on the pool port', (m) => { for (const s of ['rab-api', 'rab-worker', 'db-setup', 'db-harden']) m.services[s].environment.PG_DATABASE_URL = m.services[s].environment.PG_DATABASE_URL.replace(':25060/', ':25061/'); }, /port 25061 is the connection POOL/],
  ['owner URL differs between services', (m) => { m.services['rab-worker'].environment.PG_DATABASE_URL += '&x=1'; }, /PG_DATABASE_URL differs/],
  ['AI on', (m) => { m.services['rab-api'].environment.AI_ENABLED = 'true'; }, /rab-api: AI_ENABLED must stay false/],
  ['an extra service', (m) => { m.services.edge = structuredClone(m.services['rab-redis']); }, /services are \[/],
];

for (const [name, mutate, pattern] of WEAKENINGS) {
  test(`the rendered shape refuses: ${name}`, { skip }, () => assertRefused(problemsAfter(mutate), pattern));
}

/** Renders image.yml + the committed override + one more override file (a weakening a later edit could introduce). */
function renderWith(extraYaml, composeEnvText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'do-weak-'));
  try {
    const f = path.join(dir, 'docker-compose.weak.yml');
    fs.writeFileSync(f, extraYaml);
    return v.render({ files: [v.IMAGE_FILE, v.DO_FILE, f], composeEnvText });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a later override that weakens isolation through Compose merging is refused', { skip }, () => {
  assertRefused(v.checkModel(renderWith('services:\n  rab-api:\n    environment:\n      CREWFLOW_RUNTIME_ISOLATION: warn\n')), /rab-api: CREWFLOW_RUNTIME_ISOLATION must be enforce/);
  assertRefused(v.checkModel(renderWith('services:\n  rab-worker:\n    read_only: false\n    cap_add: [SYS_ADMIN]\n')), /rab-worker: (read_only must be true|cap_add must be empty)/);
  assertRefused(v.checkModel(renderWith('services:\n  db:\n    deploy:\n      replicas: 1\n')), /db: the bundled database must have 0 replicas/);
});

test('a compose.env that forgets CREWFLOW_BUNDLED_DB=0 is refused by the rendered check too', { skip }, () => {
  const text = withKey(composeTemplate(), 'CREWFLOW_BUNDLED_DB', null);
  assertRefused(v.checkModel(v.render({ composeEnvText: text })), /db-setup: CREWFLOW_BUNDLED_DB must render 0/);
});

// ------------------------------------------------------------------------------- security review of #332 (fix round 1)

test('ACL (review LOW): both users at +@all, or anything re-added beyond info and the five client subcommands, is refused', () => {
  const acl = aclTemplate();
  const both = (fn) => acl.split('\n').map((l) => (/^user (default|crewflow) /.test(l) ? fn(l) : l)).join('\n');
  const allOnly = both((l) => l.replace(/ \+@all .*$/, ' +@all'));
  assertRefused(v.lintRedisAcl(allOnly), /user default: -@admin is missing/);
  assertRefused(v.lintRedisAcl(allOnly), /user crewflow: -@dangerous is missing/);
  assertRefused(v.lintRedisAcl(allOnly), /user crewflow: -flushall is missing/);
  assertRefused(v.lintRedisAcl(both((l) => `${l} +flushall`)), /permission \+flushall is not allowed/);
  assertRefused(v.lintRedisAcl(both((l) => `${l} +@admin`)), /permission \+@admin is not allowed/);
  assertRefused(v.lintRedisAcl(both((l) => `${l} +config|get`)), /permission \+config\|get is not allowed/);
  assertRefused(v.lintRedisAcl(both((l) => `${l} allcommands`)), /permission allcommands is not allowed/);
  assertRefused(v.lintRedisAcl(both((l) => `${l} %RW~*`)), /permission %RW~\* is not allowed/);
  // A denial placed before +@all is undone by it (rules apply left to right).
  assertRefused(v.lintRedisAcl(both((l) => l.replace(' -keys', '').replace(' +@all', ' -keys +@all'))), /-keys must come after \+@all/);
});

test('URLs (review LOW): a query key given twice is refused (sslmode=verify-full&sslmode=disable)', () => {
  const t = composeTemplate();
  assertRefused(v.lintComposeEnv(adminLine(t, (l) => `${l}&sslmode=disable`)), /PG_ADMIN_URL: the sslmode parameter appears more than once/);
  const urlOnly = ['PG_DATABASE_APP_PASSWORD', 'PG_DATABASE_HOST', 'PG_DATABASE_PORT', 'PG_DATABASE_NAME'].reduce((s, k) => withKey(s, k, null), t);
  const owner = `postgresql://crewflow_owner:${'a'.repeat(64)}@${v.SENTINEL_HOST}:25060/crewflow?sslmode=verify-full&sslmode=disable`;
  assertRefused(v.lintComposeEnv(withKey(urlOnly, 'PG_DATABASE_URL', owner)), /PG_DATABASE_URL: the sslmode parameter appears more than once/);
});

test('the rendered shape refuses a duplicated sslmode in the owner URL', { skip }, () => {
  const dup = (m) => {
    for (const s of ['rab-api', 'rab-worker', 'db-setup', 'db-harden']) m.services[s].environment.PG_DATABASE_URL += '&sslmode=disable';
  };
  assertRefused(problemsAfter(dup), /the sslmode parameter appears more than once/);
});

const caddyTemplate = () => read(v.TEMPLATES.caddyfile).replace(/<api-host>/g, 'api.example.com');

test('Caddyfile (review MEDIUM): the template passes; per-hostname AOP, require_and_verify and strict_sni_host are required', () => {
  assert.deepEqual(v.lintCaddyfile(caddyTemplate()), []);
  const c = caddyTemplate();
  // Directive lines only (the header comments mention the same words; comments are ignored by the lint).
  const pool = 'trust_pool file /etc/caddy/tls/crewflow-aop-ca.pem';
  assertRefused(v.lintCaddyfile(c.replace('\t\tstrict_sni_host on\n', '')), /strict_sni_host on is missing/);
  assertRefused(v.lintCaddyfile(c.replace('\t\tstrict_sni_host on', '\t\tstrict_sni_host insecure_off')), /strict_sni_host/);
  for (const mode of ['request', 'require', 'verify_if_given']) assertRefused(v.lintCaddyfile(c.replace('\t\t\tmode require_and_verify', `\t\t\tmode ${mode}`)), /mode must be exactly require_and_verify/);
  assertRefused(v.lintCaddyfile(c.replace(/\t\tclient_auth \{[\s\S]*?\n\t\t\}\n/, '')), /no client_auth/);
  assertRefused(v.lintCaddyfile(c.replace(pool, 'trust_pool file /etc/caddy/tls/cloudflare-origin-pull-ca.pem')), /named like Cloudflare's SHARED origin-pull CA/);
  assertRefused(v.lintCaddyfile(c.replace(pool, 'trust_pool file /etc/caddy/tls/origin_pull_ca.pem')), /SHARED origin-pull CA/);
  assertRefused(v.lintCaddyfile(c.replace(/trust_pool file \S+/, 'trust_pool inline {\n\t\t\t\ttrust_der x\n\t\t\t}')), /exactly one "trust_pool file <our CA>"/);
  assertRefused(v.lintCaddyfile(c.replace('reverse_proxy 127.0.0.1:3000', 'reverse_proxy 10.0.0.5:3000')), /reverse_proxy must target rab-api on loopback only/);
  assertRefused(v.lintCaddyfile(c.replace('redir https://{host}{uri} permanent', 'reverse_proxy 127.0.0.1:3000')), /proxies over plain HTTP/);
  assertRefused(v.lintCaddyfile(`${c}\n}`), /braces do not balance/);
});

test('Caddyfile (re-review LOW): only one https://<host> and one http://<host> site; reverse_proxy only in the mTLS block', () => {
  const c = caddyTemplate();
  const port80 = `${c}\n:80 {\n\treverse_proxy 127.0.0.1:3000\n}\n`;
  const bareHost = `${c}\nother.example.com {\n\treverse_proxy 127.0.0.1:3000\n}\n`;
  for (const text of [port80, bareHost]) {
    assertRefused(v.lintCaddyfile(text), /not exactly one https:\/\/<host> or http:\/\/<host>/);
    assertRefused(v.lintCaddyfile(text), /reverse_proxy outside the mTLS https:\/\/ site block/);
  }
  assertRefused(v.lintCaddyfile(c.replace('https://api.example.com {', 'https://api.example.com, https://other.example.com {')), /not exactly one https:\/\/<host>/);
  assertRefused(v.lintCaddyfile(`${c}\nhttps://second.example.com {\n\trespond 200\n}\n`), /more than one https:\/\/ or http:\/\/ site block/);
  assertRefused(v.lintCaddyfile(c.replace('\tabort @not_cloudflare\n', '\tabort @not_cloudflare\n\treverse_proxy 127.0.0.1:3000\n')), /reverse_proxy outside the mTLS https:\/\/ site block/);
});

test('ACL (re-review LOW): an extra enabled user, or ops switched on with more than -@all +ping +info, is refused', () => {
  const acl = aclTemplate();
  assertRefused(v.lintRedisAcl(`${acl}\nuser extra on #${'c'.repeat(64)} ~* +@all\n`), /user extra: an enabled user that is not one of default, crewflow, healthcheck, ops/);
  assertRefused(v.lintRedisAcl(acl.replace(/^user ops .*$/m, `user ops on #${'d'.repeat(64)} resetkeys ~* resetchannels +@all`)), /user ops: must be limited to -@all \+ping \+info/);
  assert.deepEqual(v.lintRedisAcl(acl.replace(/^user ops off resetpass/m, `user ops on #${'d'.repeat(64)}`)), []);
  assert.deepEqual(v.lintRedisAcl(`${acl}\nuser retired off resetpass resetkeys -@all\n`), []);
});

let opensslAvailable = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  opensslAvailable = false;
}

test('Caddyfile trust pool: our CA passes; a Cloudflare-issued CA or a non-CA certificate is refused', { skip: opensslAvailable ? false : 'openssl is not available' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'do-aop-'));
  const cert = (name, subj, ca) => {
    const key = path.join(dir, `${name}.key`);
    const crt = path.join(dir, `${name}.crt`);
    const args = ['req', '-x509', '-new', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-keyout', key, '-out', crt, '-days', '2', '-subj', subj,
      '-addext', `basicConstraints=critical,CA:${ca ? 'TRUE' : 'FALSE'}`];
    execFileSync('openssl', args, { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    return fs.readFileSync(crt, 'utf8');
  };
  const unreadable = () => {
    throw new Error('ENOENT');
  };
  try {
    assert.deepEqual(v.trustPoolPemProblems(cert('ours', '/CN=Crewflow AOP CA', true), 'site'), []);
    assertRefused(v.trustPoolPemProblems(cert('cf', '/O=Cloudflare, Inc./OU=Origin Pull/CN=origin-pull.cloudflare.net', true), 'site'), /Cloudflare-issued certificate/);
    assertRefused(v.trustPoolPemProblems(cert('leaf', '/CN=Crewflow AOP client', false), 'site'), /not a CA certificate/);
    assertRefused(v.trustPoolPemProblems('no certificate here', 'site'), /holds no certificate/);
    // Through the Caddyfile lint with a reader (what --lint-caddyfile does on the server).
    const ours = cert('ours2', '/CN=Crewflow AOP CA', true);
    assert.deepEqual(v.lintCaddyfile(caddyTemplate(), { readFile: () => ours }), []);
    assertRefused(v.lintCaddyfile(caddyTemplate(), { readFile: unreadable }), /trust pool file cannot be read/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A server-shaped /etc/crewflow in a temp dir: compose.env + secrets, from the templates; `runtimeEdit` changes runtime.env. */
function serverDir(runtimeEdit = (r) => r) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'do-env-'));
  const secrets = path.join(dir, 'secrets');
  fs.mkdirSync(secrets);
  fs.writeFileSync(path.join(secrets, 'database.env'), databaseTemplate());
  fs.writeFileSync(path.join(secrets, 'runtime.env'), runtimeEdit(v.digitalOceanRuntimeText()));
  fs.writeFileSync(path.join(secrets, 'redis-users.acl'), aclTemplate());
  const compose = withKey(composeTemplate(), 'CREWFLOW_SECRETS_DIR', secrets.split(path.sep).join('/'));
  fs.writeFileSync(path.join(dir, 'compose.env'), compose);
  return { dir, compose, composeFile: path.join(dir, 'compose.env') };
}

test('--environment (review LOW) lints database.env, runtime.env and the ACL under CREWFLOW_SECRETS_DIR', () => {
  const good = serverDir();
  const bad = serverDir((r) => withKey(r, 'TRUSTED_PROXY_CIDRS', '0.0.0.0/0'));
  try {
    for (const [, problems] of v.environmentFileProblems(good.compose)) assert.deepEqual(problems, []);
    assertRefused(v.environmentFileProblems(bad.compose).flatMap(([, p]) => p), /TRUSTED_PROXY_CIDRS: must be exactly 172\.16\.30\.1\/32/);
    fs.rmSync(path.join(good.dir, 'secrets', 'redis-users.acl'));
    assertRefused(v.environmentFileProblems(good.compose).flatMap(([, p]) => p), /redis-users\.acl: cannot read it/);
    assertRefused(v.environmentFileProblems(withKey(good.compose, 'CREWFLOW_SECRETS_DIR', 'relative/dir')).flatMap(([, p]) => p), /CREWFLOW_SECRETS_DIR: missing or not an absolute path/);
  } finally {
    fs.rmSync(good.dir, { recursive: true, force: true });
    fs.rmSync(bad.dir, { recursive: true, force: true });
  }
});

test('--environment fails (exit 1) on a bad TRUSTED_PROXY_CIDRS and passes on the templates', { skip }, () => {
  const run = (composeFile) => {
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'verify-digitalocean.cjs'), '--environment', '--env-file', composeFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, out: '' };
    } catch (e) {
      return { status: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };
  const good = serverDir();
  const bad = serverDir((r) => withKey(r, 'TRUSTED_PROXY_CIDRS', '172.16.30.0/24'));
  try {
    assert.equal(run(good.composeFile).status, 0);
    const r = run(bad.composeFile);
    assert.equal(r.status, 1);
    assert.match(r.out, /FAIL runtime\.env .*TRUSTED_PROXY_CIDRS/);
    assert.ok(!r.out.includes(v.SENTINEL_ADMIN_PW), 'a value was printed');
  } finally {
    fs.rmSync(good.dir, { recursive: true, force: true });
    fs.rmSync(bad.dir, { recursive: true, force: true });
  }
});
