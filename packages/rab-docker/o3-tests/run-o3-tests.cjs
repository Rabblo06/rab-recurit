'use strict';
/**
 * O3 REAL-CONTAINER TESTS (Agent 5): "image and start-up exactly like Twenty" (owner decisions C1-C5, 2026-11-05) on the
 * production compose files (docker-compose.image.yml + docker-compose.local-db.yml) plus the test-only infrastructure overlay
 * o3-tests/docker-compose.o3t.yml, against ONE locally built image (never pushed) and two test-only variants of it that add
 * ONE extra migration (o3-tests/migration: broken / fixed). No real migration file is edited.
 *
 *   O3T_IMAGE=o3t-adolphus@sha256:<base> O3T_IMAGE_BROKEN=o3t-adolphus@sha256:<broken> O3T_IMAGE_FIXED=o3t-adolphus@sha256:<fixed> \
 *   O3T_PG_IMAGE=postgres@sha256:<16 or 18> O3T_REDIS_IMAGE=redis@sha256:<..> O3T_NODE_IMAGE=node@sha256:<..> \
 *     node packages/rab-docker/o3-tests/run-o3-tests.cjs <16|18> <out-dir> [--keep]
 *
 * Project `o3t-pg<major>` (containers o3t-pg<major>-*), five containers (rab-postgres, rab-redis, rab-api, rab-worker,
 * sinks), every data directory a tmpfs, no host port, no Docker volume. Cleanup removes this project's containers by exact
 * name (never a prune, never `down -v`). Results: <out-dir>/RESULTS.json and SUMMARY.md; raw evidence under <out-dir>/evidence.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Ctx, RD, API_TMP_WORKAROUND, hex, b64, sleep } = require('./lib.cjs');

const argv = process.argv.slice(2);
const MAJOR = argv[0];
const OUT = argv[1] ? path.resolve(argv[1]) : '';
const KEEP = argv.includes('--keep');
// --marker: the PRE-HOTFIX test-only workaround (crewflow.disposable_test_database=true on the disposable database).
const MARKER = argv.includes('--marker');
// --observe-skip-stop: ONCE (PG16) record what happens when an operator skips the documented stop (T8d).
const OBSERVE_SKIP_STOP = argv.includes('--observe-skip-stop');
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
if (!['16', '18'].includes(MAJOR) || !OUT) {
  console.error('usage: run-o3-tests.cjs <16|18> <out-dir> [--keep] [--marker] [--only=T1,T7,...]');
  process.exit(2);
}
for (const k of ['O3T_IMAGE', 'O3T_IMAGE_BROKEN', 'O3T_IMAGE_FIXED', 'O3T_PG_IMAGE', 'O3T_REDIS_IMAGE', 'O3T_NODE_IMAGE']) {
  if (!/^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/.test(process.env[k] ?? '')) {
    console.error(`${k} must be <repository>@sha256:<64 hex>`);
    process.exit(2);
  }
}
fs.mkdirSync(OUT, { recursive: true });
const ctx = new Ctx(MAJOR, OUT);
const results = [];
const PROBE = 'O3tUpgradeProbe1786721999001';
const GATED = '1786721330000';

function digestOf(ref) {
  return ref.split('@')[1];
}

// ------------------------------------------------------------------------------------------------------------ set-up
function writeSecrets() {
  const S = ctx.secretsDir;
  fs.mkdirSync(path.join(S, 'pg-tls'), { recursive: true });
  ctx.secrets = {
    superuser: hex(24),
    owner: hex(32),
    redis: hex(24),
    appSecret: b64(48),
    s3key: `o3t${hex(8)}`,
    s3secret: hex(24),
  };
  fs.writeFileSync(path.join(S, 'postgres-superuser-password'), ctx.secrets.superuser);
  fs.writeFileSync(path.join(S, 'crewflow-owner-password'), ctx.secrets.owner);
  // Redis ACL from the reviewed template (env/redis-users.acl.example), the app user's password by SHA-256 only.
  const acl = fs
    .readFileSync(path.join(RD, 'env/redis-users.acl.example'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.replace('<sha256-hex-of-the-redis-app-password>', crypto.createHash('sha256').update(ctx.secrets.redis).digest('hex')))
    .join('\n');
  fs.writeFileSync(path.join(S, 'redis-users.acl'), `${acl}\n`);
  // A throwaway CA and a server certificate for rab-postgres (verify-full).
  const tls = path.join(S, 'pg-tls');
  const ossl = (args) => {
    const r = ctx.run('openssl', args, { cwd: tls, env: { MSYS_NO_PATHCONV: '1' } });
    if (r.code !== 0) throw new Error(`openssl ${args[0]} failed: ${r.out.slice(0, 400)}`);
  };
  ossl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=o3t test CA', '-keyout', 'ca.key', '-out', 'ca.crt']);
  ossl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=rab-postgres', '-keyout', 'server.key', '-out', 'server.csr']);
  fs.writeFileSync(path.join(tls, 'ext.cnf'), 'subjectAltName=DNS:rab-postgres\nextendedKeyUsage=serverAuth\n');
  ossl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'ext.cnf', '-out', 'server.crt']);
  fs.copyFileSync(path.join(tls, 'ca.crt'), path.join(S, 'pg-ca.crt'));
  for (const f of ['ca.key', 'server.csr', 'ext.cnf', 'ca.srl']) fs.rmSync(path.join(tls, f), { force: true });
  // database.env and runtime.env come from the SHIPPED templates (env/*.env.example) with ONLY the documented operator
  // values filled in; every other line, including whatever a template requires (e.g. CREWFLOW_AUDIT_SINK), is kept as shipped.
  const host = 'o3t.example.com';
  const values = {
    '<crewflow_owner-password>': ctx.secrets.owner,
    '<db-direct-host>': 'rab-postgres',
    '<db-name>': 'crewflow',
    '<redis-app-password>': ctx.secrets.redis,
    '<app-secret>': ctx.secrets.appSecret,
    '<app-host>': host,
    '<edge-proxy-cidr>': '10.255.255.1/32',
    '<smtp-host>': 'sinks',
    '<smtp-user>': 'o3t',
    '<smtp-password>': ctx.secrets.s3secret,
    '<sender-address>': `Crewflow o3t <no-reply@${host}>`,
    '<bucket>': 'o3t',
    '<region-or-auto>': 'eu-west-2',
    'https://<s3-compatible-endpoint>': 'http://sinks:9000',
    '<bucket-scoped-key-id>': ctx.secrets.s3key,
    '<bucket-scoped-secret>': ctx.secrets.s3secret,
  };
  // The test sinks listen on 2525 (SMTP) and 9000 (S3, plain HTTP): operator values, like any SMTP port / endpoint.
  const lineOverrides = { EMAIL_SMTP_PORT: '2525' };
  const fromTemplate = (name) => {
    const lines = fs.readFileSync(path.join(RD, 'env', `${name}.example`), 'utf8').split(/\r?\n/);
    const out = [];
    for (const raw of lines) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      let line = raw;
      for (const [k, v] of Object.entries(values)) line = line.split(k).join(v);
      const key = line.split('=')[0];
      if (lineOverrides[key] !== undefined) line = `${key}=${lineOverrides[key]}`;
      if (/<[a-z0-9_-]+>/i.test(line)) throw new Error(`template ${name}: unfilled placeholder in ${key}`);
      out.push(line);
    }
    fs.writeFileSync(path.join(S, name), `${out.join('\n')}\n`);
    return out.map((l) => l.split('=')[0]);
  };
  const dbKeys = fromTemplate('database.env');
  const rtKeys = fromTemplate('runtime.env');
  ctx.note(`database.env keys (shipped template): ${dbKeys.join(' ')}`);
  ctx.note(`runtime.env keys (shipped template): ${rtKeys.join(' ')}`);
  writeComposeEnv(process.env.O3T_IMAGE);
}

function writeComposeEnv(imageRef, extra = {}) {
  const S = ctx.secretsDir.replace(/\\/g, '/');
  const lines = {
    CREWFLOW_IMAGE_REPOSITORY: imageRef.split('@')[0],
    CREWFLOW_IMAGE_DIGEST: digestOf(imageRef),
    CREWFLOW_REDIS_IMAGE: process.env.O3T_REDIS_IMAGE,
    CREWFLOW_POSTGRES_IMAGE: process.env.O3T_PG_IMAGE,
    O3T_POSTGRES_IMAGE: process.env.O3T_PG_IMAGE,
    O3T_NODE_IMAGE: process.env.O3T_NODE_IMAGE,
    CREWFLOW_SECRETS_DIR: S,
    CREWFLOW_PG_CA_FILE: `${S}/pg-ca.crt`,
    CREWFLOW_API_MEM_LIMIT: '1024m',
    CREWFLOW_API_CPUS: '2',
    CREWFLOW_WORKER_MEM_LIMIT: '1024m',
    CREWFLOW_WORKER_CPUS: '2',
    CREWFLOW_REDIS_MAXMEMORY: '128mb',
    CREWFLOW_POSTGRES_MEM_LIMIT: '768m',
    CREWFLOW_POSTGRES_CPUS: '2',
    ...extra,
  };
  fs.writeFileSync(ctx.composeEnvFile(), `${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  ctx.currentImage = imageRef;
}

// ----------------------------------------------------------------------------------------------------- the test cases
async function step(id, title, fn) {
  if (ONLY.length && !ONLY.includes(id)) return;
  const r = { id, title, status: 'NOT RUN', checks: [], notes: [] };
  results.push(r);
  ctx.note(`=== ${id} ${title}`);
  const check = (ok, what) => {
    r.checks.push({ ok: Boolean(ok), what: ctx.redact(what) });
    ctx.note(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    return Boolean(ok);
  };
  try {
    await fn(check, (n) => {
      r.notes.push(ctx.redact(n));
      ctx.note(`  note: ${n}`);
    });
    r.status = r.checks.length && r.checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
  } catch (e) {
    r.status = 'FAIL';
    r.checks.push({ ok: false, what: `threw: ${ctx.redact(e && e.message ? e.message : String(e))}` });
    ctx.note(`  FAIL threw: ${e && e.message ? e.message : e}`);
    // Failure evidence: the last container logs of both processes (redacted), so a failed step can be diagnosed afterwards.
    for (const svc of ['rab-api', 'rab-worker']) {
      try {
        ctx.evidence(`${id}-failure-${svc}.log`, ctx.run('docker', ['logs', '--tail', '400', ctx.container(svc)]).out);
      } catch {
        /* the container may not exist */
      }
    }
  }
  ctx.note(`=== ${id} ${r.status}`);
  fs.writeFileSync(path.join(OUT, 'RESULTS.json'), JSON.stringify(results, null, 2));
}

function distMigrations(imageRef) {
  const r = ctx.run('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', 'ls', imageRef, 'packages/rab-server/dist/database/typeorm/core/migrations']);
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d{13}-.+\.js$/.test(l))
    .map((l) => {
      const [, ts, name] = /^(\d{13})-(.+)\.js$/.exec(l);
      return `${name}${ts}`;
    });
}

function up(services, extraArgs = []) {
  const r = ctx.compose(['up', '-d', '--pull', 'never', ...extraArgs, ...services], { timeout: 300_000 });
  if (r.code !== 0) throw new Error(`compose up ${services.join(' ')} failed: ${ctx.redact(r.out).slice(-800)}`);
  return r;
}

function inspect(service, fmt) {
  return ctx.run('docker', ['inspect', '-f', fmt, ctx.container(service)]).stdout.trim();
}

function exec(service, args, opts = {}) {
  return ctx.run('docker', ['exec', ...(opts.user ? ['-u', opts.user] : []), ctx.container(service), ...args], { timeout: opts.timeout ?? 60_000 });
}

function countMatches(text, re) {
  return (String(text).match(re) || []).length;
}

const state = {};
const ADMIN_EMAIL = 'platform-admin@o3t.example.com';

/** A CLI command on the API service's own configuration (env files, CA, networks, hardening), production opt-in set. */
function cli(args, env = {}) {
  const all = { ALLOW_PRODUCTION_DB_COMMANDS: 'true', DB_TARGET: 'production', ...env };
  const r = ctx.compose(['run', '--rm', '--no-deps', ...Object.keys(all).flatMap((k) => ['-e', k]), 'rab-api', 'node', 'packages/rab-server/dist/command/main.js', ...args], { env: all, timeout: 600_000 });
  return r;
}

function ids() {
  const row = ctx.psql(`SELECT v.id || '|' || v.organisation_id || '|' || v.workspace_id || '|' || (SELECT id FROM core.job_role WHERE organisation_id = v.organisation_id LIMIT 1) || '|' || (SELECT id FROM core."user" WHERE email = 'manager.qa@example.test') FROM core.venue v WHERE v.name = 'ADOLPHUS QA Venue' LIMIT 1`);
  const [venue, org, ws, jobRole, manager] = row.split('|');
  return { venue, org, ws, jobRole, manager };
}

function newShift(f, startsInMinutes) {
  const out = ctx.psql(`SELECT set_config('rab.organisation_id', '${f.org}', false);
    INSERT INTO core.shift(organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, status, created_by, published_at)
    VALUES ('${f.org}', '${f.ws}', '${f.venue}', '${f.jobRole}', now() + interval '${startsInMinutes} minutes', now() + interval '${startsInMinutes + 240} minutes', 1, 1200, 'open', '${f.manager}', now()) RETURNING id;`);
  return out.split('\n').pop().trim();
}

function reportReady(shiftId, table = 'shift_report') {
  return ctx.psql(`SELECT coalesce((SELECT status || '|' || (pre_shift_pdf_generated_at IS NOT NULL) FROM core.${table} WHERE shift_id = '${shiftId}'), 'none')`);
}

function pdfInSink(shiftId) {
  const key = ctx.psql(`SELECT object_key FROM core.stored_file WHERE mime_type = 'application/pdf' AND object_key LIKE '%/reports/${shiftId}/%' AND status = 'AVAILABLE' LIMIT 1`);
  if (!key) return null;
  const file = key.replace(/[^A-Za-z0-9._-]/g, '_');
  const head = exec('sinks', ['sh', '-c', `head -c 5 '/out/s3/${file}'`]).stdout;
  return head === '%PDF-' ? key : null;
}

function mailCount() {
  return Number(exec('sinks', ['sh', '-c', 'ls /out/mail | wc -l']).stdout.trim() || '0');
}

function setImage(ref, extra = {}) {
  writeComposeEnv(ref, extra);
}

/**
 * The DOCUMENTED deployment (OWNER-LOGIN-DEPLOYMENT.md section 3.4, C5 stop-then-start), exactly:
 *   $P stop rab-worker rab-api
 *   $P up -d --wait --wait-timeout 1200
 * Returns the compose exit code (non-zero when a service does not become healthy).
 */
function deploy() {
  const stop = ctx.compose(['stop', 'rab-worker', 'rab-api'], { timeout: 180_000 });
  if (stop.code !== 0) throw new Error(`stop rab-worker rab-api failed: ${ctx.redact(stop.out).slice(-400)}`);
  const r = ctx.compose(['up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '1200'], { timeout: 1_300_000 });
  return r;
}

async function deployHealthy() {
  const r = deploy();
  if (r.code !== 0) throw new Error(`the documented deploy did not become healthy: ${ctx.redact(r.out).slice(-600)}`);
  await ctx.waitHealthy('rab-api', 60_000);
  await ctx.waitHealthy('rab-worker', 60_000);
}

/** A deploy that is EXPECTED to be refused: the documented stop, then the API alone (the Worker waits for a healthy API). */
function deployExpectingRefusal() {
  const stop = ctx.compose(['stop', 'rab-worker', 'rab-api'], { timeout: 180_000 });
  if (stop.code !== 0) throw new Error(`stop rab-worker rab-api failed: ${ctx.redact(stop.out).slice(-400)}`);
  up(['rab-api'], ['--force-recreate', '--no-deps']);
}

/** Runs the Worker once on another database (compose run: the Worker service's own hardening and env files). */
async function workerOn(db, timeoutMs = 240_000) {
  const url = `postgresql://crewflow_owner:${ctx.secrets.owner}@rab-postgres:5432/${db}?sslmode=verify-full`;
  const env = { PG_DATABASE_URL: url, PG_EXPECTED_DATABASE_NAME: db };
  const name = `${ctx.project}-worker-probe-${db}`;
  const r = ctx.compose(['run', '--rm', '--no-deps', '--name', name, '-e', 'PG_DATABASE_URL', '-e', 'PG_EXPECTED_DATABASE_NAME', 'rab-worker'], { env, timeout: timeoutMs });
  // A Worker that did NOT exit (it started on the wrong database) is a failure, not a refusal: stop and record it.
  if (r.error) {
    ctx.run('docker', ['rm', '-f', '-v', name]);
    return { ...r, code: 'did-not-exit' };
  }
  return r;
}

async function main() {
  ctx.note(`project ${ctx.project}; PostgreSQL image ${process.env.O3T_PG_IMAGE}; image ${process.env.O3T_IMAGE}; marker workaround: ${MARKER ? 'ON' : 'off'}; rab-api /tmp workaround: ${API_TMP_WORKAROUND ? 'ON (TEST-ONLY, defect T8a-TMP)' : 'off (shipped files only)'}`);
  writeSecrets();

  // ---------------------------------------------------------------------------------------------------------- 1
  await step('T1', 'fresh install with the shipped templates only: the API migrates on start (approval none), registers the schedulers and serves; the Worker starts after it', async (check, note) => {
    const t0 = Date.now();
    up(['rab-postgres', 'rab-redis', 'sinks']);
    await ctx.waitHealthy('rab-postgres', 180_000);
    await ctx.waitHealthy('rab-redis', 120_000);
    const pgVersion = ctx.psql('SHOW server_version_num');
    check(pgVersion.startsWith(MAJOR), `PostgreSQL major ${MAJOR} (server_version_num ${pgVersion})`);
    if (MARKER) {
      ctx.psql("ALTER DATABASE crewflow SET crewflow.disposable_test_database = 'true'");
      note('TEST-ONLY WORKAROUND: crewflow.disposable_test_database=true set on this disposable database (pre-hotfix semantic golden)');
    }
    up(['rab-api']);
    const apiMs = await ctx.waitHealthy('rab-api', 900_000);
    note(`rab-api healthy ${Math.round(apiMs / 1000)} s after it started (fresh install: whole chain + scheduler registration)`);
    up(['rab-worker']);
    await ctx.waitHealthy('rab-worker', 300_000);
    note(`whole stack healthy after ${Math.round((Date.now() - t0) / 1000)} s`);
    const expected = distMigrations(process.env.O3T_IMAGE);
    state.expected = expected;
    const ledger = ctx.ledger();
    state.baselineLedger = ledger;
    check(expected.length > 200, `the image ships ${expected.length} migrations`);
    check(JSON.stringify([...ledger].sort()) === JSON.stringify([...expected].sort()), `ledger == the image's migrations (${ledger.length}/${expected.length})`);
    check(!ledger.some((n) => n.endsWith(GATED)), `${GATED} is NOT in the ledger`);
    const hz = ctx.healthz();
    check(hz.code === 0 && /"upgradeFailed"\s*:\s*false/.test(hz.body), `/healthz serves with upgradeFailed:false (${hz.body.slice(0, 200)})`);
    const apiLogs = ctx.logs('rab-api');
    ctx.evidence('T1-api.log', apiLogs);
    ctx.evidence('T1-worker.log', ctx.logs('rab-worker'));
    check(/"outcome":"ok"/.test(apiLogs) && /"state":"EMPTY"|"state":"BOOTSTRAP-PARTIAL"/.test(apiLogs), 'the migrate child reported a fresh install (EMPTY) with outcome ok');
    check(/register-schedulers: 17 Crewflow job scheduler\(s\) registered/.test(apiLogs) && /6 disabled/.test(apiLogs), 'api-prestart registered 17 job schedulers (6 disabled: 23 fixed ids)');
    const wl = ctx.logs('rab-worker');
    check(!/partly-upgraded/.test(wl), 'the Worker logs no partly-upgraded warning');
    check(/consume only/.test(wl) && /all 17 enabled Crewflow schedulers present/.test(wl), 'the Worker is consume-only and found all 17 schedulers');
    const env = inspect('rab-api', '{{range .Config.Env}}{{println .}}{{end}}');
    check(/^CREWFLOW_MIGRATE_ON_START=true$/m.test(env) && /^CREWFLOW_MIGRATION_APPROVAL_MODE=none$/m.test(env), 'API: CREWFLOW_MIGRATE_ON_START=true, CREWFLOW_MIGRATION_APPROVAL_MODE=none');
    check(!/semantic-posture" refused|security audit sink/.test(apiLogs), 'no semantic-posture or audit-sink refusal');
  });

  // --------------------------------------------------------------------------------------------------------- 1b
  await step('T1b', 'production plus the disposable-test-database marker is REFUSED at the identity gate', async (check, note) => {
    if (MARKER) {
      check(false, 'not applicable with the pre-hotfix marker workaround (the marker is set on purpose)');
      return;
    }
    ctx.psql("ALTER DATABASE crewflow SET crewflow.disposable_test_database = 'true'");
    try {
      const since = new Date().toISOString();
      deployExpectingRefusal();
      await ctx.waitFor('the API refusal', () => /disposable_test_database|disposable test database/i.test(ctx.logs('rab-api', since)) && /identity/i.test(ctx.logs('rab-api', since)), 300_000, 5000);
      const al = ctx.logs('rab-api', since);
      ctx.evidence('T1b-api.log', al);
      const line = (al.split('\n').find((l) => /refus/i.test(l) && /disposable/i.test(l)) || '').slice(0, 300);
      note(`refusal: ${line}`);
      check(/identity/i.test(line) || /gate "identity"|purpose=migrations.*identity/i.test(al), 'the refusal is at the identity gate');
      check(!ctx.healthStatus('rab-api').startsWith('healthy|'), 'the API does not serve');
    } finally {
      ctx.psql('ALTER DATABASE crewflow RESET crewflow.disposable_test_database');
    }
    await deployHealthy();
    check(true, 'marker removed: the documented deploy serves again');
  });

  // ---------------------------------------------------------------------------------------------------------- 7
  await step('T7', 'hardening holds: non-root, read-only root, no capability, no-new-privileges, no Chromium; owner login NOBYPASSRLS; FORCE RLS', async (check, note) => {
    for (const svc of ['rab-api', 'rab-worker']) {
      const cfg = inspect(svc, '{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.CapAdd}}|{{json .HostConfig.SecurityOpt}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.Memory}}');
      const [user, ro, capDrop, capAdd, secOpt, pids, mem] = cfg.split('|');
      check(user === '1000:1000', `${svc}: user ${user}`);
      check(ro === 'true', `${svc}: read-only root filesystem`);
      check(capDrop === '["ALL"]' && (capAdd === 'null' || capAdd === '[]'), `${svc}: cap_drop ALL, nothing added (${capDrop} / ${capAdd})`);
      check(/no-new-privileges:true/.test(secOpt), `${svc}: no-new-privileges`);
      check(Number(pids) > 0 && Number(mem) > 0, `${svc}: PID limit ${pids}, memory limit ${mem}`);
      const id = exec(svc, ['id', '-u']).stdout.trim();
      check(id === '1000', `${svc}: processes run as uid ${id}`);
      const w = exec(svc, ['sh', '-c', 'touch /o3t-probe 2>&1; echo rc=$?']);
      check(/Read-only file system/.test(w.out) && /rc=1/.test(w.out), `${svc}: writing / fails (read-only)`);
      const st = exec(svc, ['sh', '-c', "grep -E '^(CapEff|CapBnd|NoNewPrivs)' /proc/self/status"]).stdout;
      check(/CapEff:\s*0+\b/.test(st) && /CapBnd:\s*0+\b/.test(st) && /NoNewPrivs:\s*1/.test(st), `${svc}: CapEff=0, CapBnd=0, NoNewPrivs=1`);
      const chromium = exec(svc, ['sh', '-c', 'for p in /usr/lib/chromium /usr/bin/chromium /usr/bin/chromium-browser /app/node_modules/playwright /app/node_modules/playwright-core /app/node_modules/puppeteer; do test -e "$p" && echo "PRESENT $p"; done; ls /usr/lib | grep -i chrom; true']).stdout.trim();
      check(chromium === '', `${svc}: no Chromium / browser driver (${chromium || 'none found'})`);
    }
    // (boolean || text concatenates the boolean's text form: 'false'/'true')
    const role = ctx.psql("SELECT rolsuper::text || '|' || rolbypassrls::text || '|' || rolreplication::text || '|' || rolcanlogin::text FROM pg_roles WHERE rolname = 'crewflow_owner'");
    check(role === 'false|false|false|true', `crewflow_owner: NOSUPERUSER, NOBYPASSRLS, NOREPLICATION, LOGIN (${role})`);
    const notForced = ctx.psql(`SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'core' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organisation_id' AND NOT a.attisdropped)
         AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`);
    check(notForced === '', `every core table with organisation_id has ENABLE + FORCE RLS (not forced: ${notForced || 'none'})`);
    note(`${ctx.psql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relkind = 'r' AND c.relforcerowsecurity")} core tables are FORCE RLS`);
    const legacy = ctx.psql("SELECT coalesce(string_agg(rolname, ',' ORDER BY rolname), '') FROM pg_roles WHERE rolname IN ('crewflow', 'crewflow_app') AND rolcanlogin");
    check(legacy === '', `legacy roles crewflow / crewflow_app cannot log in (BC-17; LOGIN: ${legacy || 'none'})`);
    const runtimeLogin = ctx.psql("SELECT coalesce(string_agg(DISTINCT usename, ','), '') FROM pg_stat_activity WHERE datname = 'crewflow' AND usename <> 'postgres'");
    check(runtimeLogin === 'crewflow_owner', `every application session is crewflow_owner (${runtimeLogin})`);
  });

  // ---------------------------------------------------------------------------------------------------------- 2
  await step('T2', 'a second deploy (stop-then-start of rab-api) creates no duplicate job schedulers: same ids, same count', async (check, note) => {
    const before = ctx.schedulers();
    state.schedulers = before;
    ctx.evidence('T2-schedulers-before.txt', before.join('\n'));
    note(`${before.length} job schedulers after the first start`);
    check(before.length === 17, `17 job schedulers are registered by default (got ${before.length})`);
    check(new Set(before.map((x) => x.split('|')[1])).size === before.length, 'every scheduler id is unique');
    check(before.every((x) => /\|crewflow:[a-z-]+:[a-z-]+$/.test(x)), 'every id is a fixed crewflow:<queue>:<job> id');
    await deployHealthy(); // the documented stop-then-start: a second deploy of the same release
    const after = ctx.schedulers();
    ctx.evidence('T2-schedulers-after.txt', after.join('\n'));
    check(JSON.stringify(after) === JSON.stringify(before), `after the second deploy: the same ${after.length} scheduler ids, no duplicate`);
    const logs = ctx.logs('rab-api');
    ctx.evidence('T2-api.log', logs);
    check(/"state":"CURRENT"/.test(logs) && /"applied":\[\]/.test(logs), 'the second start found the schema CURRENT and applied nothing');
    check(JSON.stringify(ctx.ledger()) === JSON.stringify(state.baselineLedger), 'ledger unchanged');
  });

  // ---------------------------------------------------------------------------------------------------------- 4
  await step('T4', 'the Worker never migrates and never registers job schedulers', async (check, note) => {
    const env = inspect('rab-worker', '{{range .Config.Env}}{{println .}}{{end}}');
    check(/^DISABLE_DB_MIGRATIONS=true$/m.test(env) && /^DISABLE_CRON_JOBS_REGISTRATION=true$/m.test(env), 'Worker: DISABLE_DB_MIGRATIONS=true, DISABLE_CRON_JOBS_REGISTRATION=true');
    const cmd = inspect('rab-worker', '{{json .Config.Cmd}}');
    check(cmd === '["node","packages/rab-worker/dist/main.js"]', `Worker command ${cmd} (no prestart, no migrate child)`);
    check(!/TWENTY_MIGRATE_RESULT|MIGRATION_EVENT|register-schedulers:/.test(ctx.logs('rab-worker')), 'Worker logs show no migration run and no scheduler registration');
    // Lose every scheduler (Redis restart, data on a tmpfs) with the API stopped, then restart the Worker alone.
    check(ctx.compose(['stop', '-t', '35', 'rab-api']).code === 0, 'rab-api stopped');
    ctx.run('docker', ['restart', '-t', '30', ctx.container('rab-redis')]);
    await ctx.waitHealthy('rab-redis', 120_000);
    check(ctx.schedulers().length === 0, 'after the Redis restart: 0 schedulers');
    const ledgerBefore = ctx.ledger();
    const since = new Date().toISOString();
    ctx.run('docker', ['restart', '-t', '30', ctx.container('rab-worker')]);
    await sleep(60_000);
    check(ctx.schedulers().length === 0, 'the Worker, restarted alone, registered no scheduler');
    check(JSON.stringify(ctx.ledger()) === JSON.stringify(ledgerBefore), 'the Worker, restarted alone, applied no migration');
    const wl = ctx.logs('rab-worker', since);
    ctx.evidence('T4-worker-alone.log', wl);
    note(`Worker alone: ${ctx.healthStatus('rab-worker')}; it reports the missing schedulers: ${/missing|not present|ERROR/i.test(wl) ? 'yes' : 'no'}`);
  });

  // ---------------------------------------------------------------------------------------------------------- 6
  await step('T6', 'after a Redis restart, the next API start re-registers every job scheduler (same ids, no duplicate)', async (check) => {
    const since = new Date().toISOString();
    await deployHealthy(); // the next API start, by the documented procedure
    const after = ctx.schedulers();
    ctx.evidence('T6-schedulers.txt', after.join('\n'));
    check(JSON.stringify(after) === JSON.stringify(state.schedulers), `the API start re-registered the same ${after.length}/${state.schedulers?.length} scheduler ids`);
    check(/all 17 enabled Crewflow schedulers present/.test(ctx.logs('rab-worker', since)), 'the Worker (started after the API) finds all 17 schedulers');
  });

  // ---------------------------------------------------------------------------------------------------------- 5
  await step('T5', 'rollback: a database AHEAD of the image (a newer ledger row) warns and serves; the Worker starts', async (check) => {
    ctx.psql("INSERT INTO core.migrations (timestamp, name) VALUES (9786700000000, 'NewerReleaseOnly9786700000000')");
    try {
      const since = new Date().toISOString();
      await deployHealthy();
      const al = ctx.logs('rab-api', since);
      ctx.evidence('T5-api.log', al);
      check(/WARNING/.test(al) && /AHEAD|NewerReleaseOnly9786700000000/.test(al), 'the API logs a WARNING naming the newer ledger (AHEAD)');
      check(ctx.healthz().code === 0, 'the API serves /healthz');
      check(ctx.ledger().includes('NewerReleaseOnly9786700000000'), 'the newer row is kept (never rewound)');
      const wl = ctx.logs('rab-worker', since);
      ctx.evidence('T5-worker.log', wl);
      check(ctx.healthStatus('rab-worker').startsWith('healthy|'), 'the Worker starts on the AHEAD database');
    } finally {
      ctx.psql('DELETE FROM core.migrations WHERE timestamp = 9786700000000');
    }
    await deployHealthy();
  });

  // ---------------------------------------------------------------------------------------------------------- 8
  await step('T8a', 'Worker-starts-too: a deliberately broken NEW migration -> the API continues (ERROR naming it, /healthz upgradeFailed:true); the Worker warns once and processes an email and a PDF job', async (check, note) => {
    // Fixture data for the jobs (CLI on the API service's configuration; the Worker is stopped meanwhile: 5 containers).
    ctx.compose(['stop', '-t', '30', 'rab-worker']);
    const boot = cli(['bootstrap-admin'], { BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL, BOOTSTRAP_ADMIN_ORG_SLUG: 'o3t-platform' });
    check(/Platform Admin bootstrapped|already/i.test(boot.out), 'bootstrap-admin (fixture admin, queues an activation email)');
    const seed = cli(['seed-qa', '--admin-email', ADMIN_EMAIL], { SEED_QA_PASSWORD: hex(16) });
    check(/Seeded QA fixture/.test(seed.out), 'seed-qa fixture');
    ctx.evidence('T8a-fixture.log', `${boot.out}\n${seed.out}`);
    state.f = ids();
    const mailBefore = mailCount();
    setImage(process.env.O3T_IMAGE_BROKEN);
    const since = new Date().toISOString();
    const dep = deploy();
    const al = ctx.logs('rab-api', since);
    ctx.evidence('T8a-api.log', al);
    ctx.evidence('T8a-deploy.log', ctx.redact(dep.out));
    check(dep.code === 0, `the documented deploy of the broken release returns 0 (API healthy degraded, Worker started) (${dep.code})`);
    await ctx.waitHealthy('rab-api', 60_000);
    check(new RegExp(`ERROR[^\\n]*${PROBE}|${PROBE}[^\\n]*ERROR`).test(al), `the API logs an ERROR naming ${PROBE}`);
    // The failed migration's name must reach main.js (CREWFLOW_UPGRADE_INCOMPLETE): "unknown" makes gate 7 refuse.
    check(al.includes(`the upgrade FAILED at ${PROBE} and`), `api-prestart hands main.js the failed migration's name (not "unknown")`);
    check(/"outcome":"degradedContinue"/.test(al) && /"exitCode":70/.test(al), 'the migrate child: outcome degradedContinue, exit 70');
    const hz = ctx.healthz();
    check(hz.code === 0 && /"upgradeFailed"\s*:\s*true/.test(hz.body), `/healthz serves with upgradeFailed:true (${hz.body.slice(0, 200)})`);
    check(!hz.body.includes(PROBE), '/healthz never names the failed migration');
    check(!ctx.ledger().includes(PROBE), 'the failed migration is not recorded');
    const sinceW = since;
    await ctx.waitHealthy('rab-worker', 300_000);
    await sleep(15_000);
    const wl = ctx.logs('rab-worker', sinceW);
    const warnings = countMatches(wl, /running on a partly-upgraded schema/g);
    check(warnings === 1 && new RegExp(`partly-upgraded schema[^\\n]*${PROBE}`).test(wl), `the Worker logs ONE partly-upgraded warning naming ${PROBE} (${warnings})`);
    // The email job: the activation email bootstrap-admin queued; the PDF job: a pre-shift report.
    await ctx.waitFor('the activation email in the SMTP sink', () => mailCount() > mailBefore, 300_000, 5000);
    check(mailCount() > mailBefore, 'an email job was delivered (SMTP sink)');
    const shift = newShift(state.f, 20);
    await ctx.waitFor('the pre-shift PDF', () => pdfInSink(shift), 600_000, 10_000);
    check(Boolean(pdfInSink(shift)), 'a PDF job rendered a pre-shift report and stored it (S3 sink holds %PDF-)');
    ctx.evidence('T8a-worker.log', ctx.logs('rab-worker', sinceW));
    check(countMatches(ctx.logs('rab-worker', sinceW), /running on a partly-upgraded schema/g) === 1, 'still exactly one warning after the jobs ran');
    check(ctx.healthStatus('rab-worker').startsWith('healthy|'), 'the Worker stays healthy');
  });

  await step('T9', 'approval token mode (compose.env CREWFLOW_MIGRATION_APPROVAL_MODE=token): a non-fresh database with a pending migration and no token is refused (65)', async (check, note) => {
    setImage(process.env.O3T_IMAGE_BROKEN, { CREWFLOW_MIGRATION_APPROVAL_MODE: 'token' });
    const since = new Date().toISOString();
    deployExpectingRefusal();
    await ctx.waitFor('the token-mode refusal', () => /"exitCode":65|exit 65/.test(ctx.logs('rab-api', since)), 300_000, 5000);
    const al = ctx.logs('rab-api', since);
    ctx.evidence('T9-api.log', al);
    check(/"exitCode":65/.test(al) || /exit 65/.test(al), 'the migrate child refuses with exit 65');
    // The refusal must be the TOKEN rule, not the N1 production approval list (which runs first and also exits 65).
    check(/CREWFLOW_MIGRATION_APPROVAL_MODE=token needs CREWFLOW_MIGRATION_APPROVED/.test(al) && !/UnapprovedProductionMigrationError/.test(al), 'the refusal is the token rule (no CREWFLOW_MIGRATION_APPROVED), not the N1 approval list');
    check(!ctx.healthStatus('rab-api').startsWith('healthy|'), 'the API does not serve');
    check(!ctx.ledger().includes(PROBE), 'nothing applied');
    const env = inspect('rab-api', '{{range .Config.Env}}{{println .}}{{end}}');
    check(/^CREWFLOW_MIGRATION_APPROVAL_MODE=token$/m.test(env), 'the API container got CREWFLOW_MIGRATION_APPROVAL_MODE=token from compose.env');
    setImage(process.env.O3T_IMAGE_BROKEN);
    await deployHealthy();
    check(true, 'back to the default (none): the documented deploy serves degraded again');
    note('compose.env is the only place the token mode is set (Agent 4 c892babc)');
  });

  await step('T8c', 'Worker-starts-too: a FOREIGN database and an OUT-OF-ORDER database are still refused', async (check, note) => {
    ctx.compose(['stop', '-t', '30', 'rab-worker']);
    // Foreign: a database whose ledger is another application's.
    ctx.psql('DROP DATABASE IF EXISTS o3t_foreign', 'postgres');
    ctx.psql('CREATE DATABASE o3t_foreign', 'postgres');
    ctx.psql('GRANT CONNECT ON DATABASE o3t_foreign TO crewflow_owner', 'postgres');
    ctx.psql("CREATE SCHEMA core; CREATE TABLE core.migrations (id serial PRIMARY KEY, timestamp bigint NOT NULL, name text NOT NULL); INSERT INTO core.migrations (timestamp, name) VALUES (1700000000000, 'SomeOtherApplication1700000000000');", 'o3t_foreign');
    const f = await workerOn('o3t_foreign');
    ctx.evidence('T8c-foreign.log', f.out);
    check(typeof f.code === 'number' && f.code !== 0, `the Worker on the foreign database exits non-zero (${f.code})`);
    note(`foreign: ${(f.out.split('\n').find((l) => /refus/i.test(l)) || '').slice(0, 260)}`);
    // Out of order: a copy of this database with an UNKNOWN ledger row interleaved before its last migration.
    ctx.compose(['stop', '-t', '35', 'rab-api']);
    ctx.psql('DROP DATABASE IF EXISTS o3t_ooo', 'postgres');
    ctx.psql('CREATE DATABASE o3t_ooo TEMPLATE crewflow', 'postgres');
    ctx.psql('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE o3t_ooo TO crewflow_owner', 'postgres');
    const last = ctx.psql('SELECT max(timestamp) FROM core.migrations', 'o3t_ooo');
    ctx.psql(`INSERT INTO core.migrations (timestamp, name) VALUES (${Number(last) - 1}, 'InterleavedUnknown${Number(last) - 1}')`, 'o3t_ooo');
    const o = await workerOn('o3t_ooo');
    ctx.evidence('T8c-out-of-order.log', o.out);
    check(typeof o.code === 'number' && o.code !== 0, `the Worker on the out-of-order database exits non-zero (${o.code})`);
    note(`out-of-order: ${(o.out.split('\n').find((l) => /refus/i.test(l)) || '').slice(0, 260)}`);
    check(/InterleavedUnknown|interleaved|unknown/i.test(o.out), 'the refusal names the unknown / interleaved ledger');
    ctx.psql('DROP DATABASE IF EXISTS o3t_foreign', 'postgres');
    ctx.psql('DROP DATABASE IF EXISTS o3t_ooo', 'postgres');
    await deployHealthy();
  });

  await step('T8b', 'Worker-starts-too: a job hitting a MISSING table (the one the broken migration should restore) fails and retries without crashing the Worker', async (check, note) => {
    // (The jobs query it unqualified on the search_path: the error reads relation "shift_report" does not exist.)
    // The table goes missing BEFORE both processes start (their boot posture baseline includes it), as after a real failed
    // migration that should have created it.
    ctx.compose(['stop', 'rab-worker', 'rab-api']);
    ctx.psql('ALTER TABLE core.shift_report RENAME TO shift_report_o3t_hidden');
    const since = new Date().toISOString();
    await deployHealthy();
    const shift = newShift(state.f, 20);
    state.missingShift = shift;
    note(`shift ${shift} waits for its pre-shift report`);
    await ctx.waitFor('the report job failing on the missing table', () => countMatches(ctx.logs('rab-worker', since), /relation "(?:core\.)?shift_report" does not exist/g) >= 2, 600_000, 10_000);
    const wl = ctx.logs('rab-worker', since);
    ctx.evidence('T8b-worker.log', wl);
    const failures = countMatches(wl, /relation "(?:core\.)?shift_report" does not exist/g);
    check(failures >= 2, `the report job failed on the missing table and was retried (${failures} failures logged)`);
    const st = inspect('rab-worker', '{{.State.Status}}|{{.RestartCount}}');
    check(st === 'running|0', `the Worker did not crash (${st})`);
    check(ctx.healthStatus('rab-worker').startsWith('healthy|'), 'the Worker stays healthy');
    check(countMatches(wl, /running on a partly-upgraded schema/g) === 1, 'one partly-upgraded warning on this start');
  });

  await step('T8d', 'after the fix (the migration repaired, the API restarted): no warning, and the previously failed job succeeds', async (check, note) => {
    setImage(process.env.O3T_IMAGE_FIXED);
    if (OBSERVE_SKIP_STOP) {
      // OBSERVATION (not the documented procedure): an operator SKIPS the stop; the old Worker keeps running while the new
      // API migrates. Expected: the old Worker sees the posture change and shuts down with a SECURITY ALERT (fail-closed).
      const sinceObs = new Date().toISOString();
      up(['rab-api'], ['--force-recreate', '--no-deps']);
      await ctx.waitHealthy('rab-api', 900_000);
      await ctx.waitFor('the old Worker reacting', () => /SECURITY ALERT|shutting the Worker down/.test(ctx.logs('rab-worker', sinceObs)), 240_000, 5000).catch(() => undefined);
      const ol = ctx.logs('rab-worker', sinceObs);
      ctx.evidence('T8d-observation-old-worker.log', ol);
      note(`OBSERVATION skip-the-stop: old Worker ${/SECURITY ALERT/.test(ol) ? 'raised a SECURITY ALERT' : 'raised NO alert'}; ${/shutting the Worker down/.test(ol) ? 'it shut itself down' : 'it kept running'}; state ${inspect('rab-worker', '{{.State.Status}}|{{.RestartCount}}')}`);
    }
    const since = new Date().toISOString();
    await deployHealthy();
    const al = ctx.logs('rab-api', since);
    ctx.evidence('T8d-api.log', al);
    check(ctx.ledger().includes(PROBE), `the repaired ${PROBE} is applied`);
    if (!OBSERVE_SKIP_STOP) check(/"outcome":"ok"/.test(al) && al.includes(PROBE), `the documented deploy applied ${PROBE} (outcome ok)`);
    const hz = ctx.healthz();
    check(hz.code === 0 && /"upgradeFailed"\s*:\s*false/.test(hz.body), `/healthz upgradeFailed:false (${hz.body.slice(0, 160)})`);
    check(ctx.psql("SELECT to_regclass('core.shift_report') IS NOT NULL") === 't', 'core.shift_report exists again');
    const sinceW = since;
    await ctx.waitFor('the previously failed report', () => pdfInSink(state.missingShift), 600_000, 10_000);
    const wl = ctx.logs('rab-worker', sinceW);
    ctx.evidence('T8d-worker.log', wl);
    check(countMatches(wl, /partly-upgraded/g) === 0, 'the Worker logs no partly-upgraded warning');
    check(Boolean(pdfInSink(state.missingShift)), 'the previously failed report job succeeded (PDF stored)');
  });

  // --------------------------------------------------------------------------------------------------------- 10
  // Measured once (PG16) when O3T_IMAGE_SLOW is given: an interrupted migrate step leaves the ledger consistent.
  if (process.env.O3T_IMAGE_SLOW) {
    await step('T10', 'an interrupted migrate step (compose stop rab-api, then SIGKILL) rolls the in-flight migration back, releases the migration lock, and the next start completes', async (check, note) => {
      const SLOW = 'O3tSlowProbe1786721999002';
      // migration-lock.ts: pg_advisory_lock(0x637265776d696772) -> classid = high 32 bits, objid = low 32 bits, objsubid 1.
      const lockHolders = () => ctx.psql(`SELECT coalesce(string_agg(pid::text, ',' ORDER BY pid), '') FROM pg_locks WHERE locktype = 'advisory' AND classid = ${parseInt('63726577', 16)}::oid AND objid = ${parseInt('6d696772', 16)}::oid AND objsubid = 1 AND granted`);
      const comment = () => ctx.psql("SELECT coalesce(obj_description('core.shift_report'::regclass, 'pg_class'), '')");
      const alive = (pid) => ctx.psql(`SELECT count(*) FROM pg_stat_activity WHERE pid = ${Number(pid)}`) !== '0';
      const startMidMigration = async (label) => {
        const since = new Date().toISOString();
        up(['rab-api'], ['--force-recreate', '--no-deps']);
        await ctx.waitFor(`${label}: the migrate child inside ${SLOW}`, () => new RegExp(`"event":"start","name":"${SLOW}"`).test(ctx.logs('rab-api', since)), 600_000, 2000);
        await sleep(5000); // inside pg_sleep(90), after the COMMENT (uncommitted)
        const al = ctx.logs('rab-api', since);
        const pid = (/migration session pid (\d+)/.exec(al) || [])[1];
        check(Boolean(pid) && lockHolders().split(',').includes(pid), `${label}: the migration session (pid ${pid}) holds the migration lock mid-migration`);
        return { since, pid };
      };
      const consistentAfter = async (label, pid) => {
        await ctx.waitFor(`${label}: the killed migration session ends`, () => !alive(pid), 120_000, 2000).catch(() => undefined);
        check(!alive(pid), `${label}: the interrupted migration session (pid ${pid}) is gone`);
        check(!lockHolders().split(',').includes(pid), `${label}: the migration lock is not held by it (holders now: ${lockHolders() || 'none'})`);
        check(!ctx.ledger().includes(SLOW), `${label}: ${SLOW} is not recorded in the ledger`);
        check(comment() === '', `${label}: its in-flight effect (the comment) was rolled back`);
      };
      setImage(process.env.O3T_IMAGE_SLOW);
      ctx.compose(['stop', 'rab-worker', 'rab-api']);
      // (a) the documented stop arrives during the migrate step: SIGTERM, Docker's SIGKILL after the 35 s grace.
      const a = await startMidMigration('stop');
      const t0 = Date.now();
      const stop = ctx.compose(['stop', 'rab-api'], { timeout: 180_000 });
      const took = Math.round((Date.now() - t0) / 1000);
      const exitA = inspect('rab-api', '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}');
      ctx.evidence('T10-stop-api.log', ctx.logs('rab-api', a.since));
      note(`compose stop rab-api mid-migration: returned ${stop.code} after ${took} s; container ${exitA}`);
      check(stop.code === 0 && exitA.startsWith('exited|'), `stop: the API container stopped (${exitA}, ${took} s)`);
      await consistentAfter('stop', a.pid);
      // (b) SIGKILL mid-migration (no grace at all).
      const b = await startMidMigration('kill');
      ctx.run('docker', ['kill', '-s', 'KILL', ctx.container('rab-api')]);
      await sleep(2000);
      const exitB = inspect('rab-api', '{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}');
      ctx.evidence('T10-kill-api.log', ctx.logs('rab-api', b.since));
      note(`docker kill -s KILL mid-migration: container ${exitB} (restart policy unless-stopped)`);
      await consistentAfter('kill', b.pid);
      // (c) the next start, by the documented procedure, completes the interrupted migration.
      const since = new Date().toISOString();
      await deployHealthy();
      const al = ctx.logs('rab-api', since);
      ctx.evidence('T10-next-start-api.log', al);
      check(ctx.ledger().includes(SLOW) && comment() === 'o3t-slow-probe', `the next start applied ${SLOW} (ledger row and its effect)`);
      check(/"outcome":"ok"/.test(al), 'the next start: migrate child outcome ok');
      note(`the next start's migrate child applied ${al.includes(`"applied":["${SLOW}"]`) ? SLOW : 'nothing (a Docker restart after the SIGKILL had already applied it)'}`);
      check(lockHolders() === '', 'no migration lock held after the next start');
    });
  }

  // ---------------------------------------------------------------------------------------------------------- 3
  await step('T3', 'upgrade failure vs FIRST-INSTALL failure: the upgrade continues (T8a); the same broken migration on a fresh install exits non-zero and never serves', async (check, note) => {
    check(results.some((r) => r.id === 'T8a' && r.status === 'PASS'), 'upgrade failure: the API continued (T8a PASS)');
    ctx.compose(['stop', 'rab-worker', 'rab-api']);
    // A fresh database: recreate rab-postgres (its data is a tmpfs).
    up(['rab-postgres'], ['--force-recreate', '--no-deps']);
    await ctx.waitHealthy('rab-postgres', 180_000);
    check(ctx.psql("SELECT to_regclass('core.migrations') IS NULL") === 't', 'the database is empty again');
    setImage(process.env.O3T_IMAGE_BROKEN);
    const since = new Date().toISOString();
    up(['rab-api'], ['--force-recreate', '--no-deps']); // a first install of the broken release (both already stopped)
    await ctx.waitFor('the first-install refusal', () => /REFUSED|"exitCode":66|exit 66/.test(ctx.logs('rab-api', since)), 900_000, 10_000);
    await sleep(20_000);
    const al = ctx.logs('rab-api', since);
    ctx.evidence('T3-api.log', al);
    check(/"exitCode":66/.test(al), 'the migrate child: exit 66 (first install failed)');
    check(!/"outcome":"degradedContinue"/.test(al), 'no degraded continue on a first install');
    check(!ctx.healthStatus('rab-api').startsWith('healthy|'), `the API never serves (${ctx.healthStatus('rab-api')})`);
    note((al.split('\n').find((l) => /REFUSED/.test(l)) || '').slice(0, 260));
  });
}

async function cleanup() {
  if (KEEP) {
    ctx.note('--keep: containers left running');
    return;
  }
  const names = ctx.run('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${ctx.project}`, '--format', '{{.Names}}']).stdout.split('\n').filter((n) => n.startsWith('o3t-'));
  for (const n of names) ctx.run('docker', ['rm', '-f', '-v', n]);
  ctx.note(`removed ${names.length} container(s): ${names.join(' ')}`);
}

main()
  .catch((e) => {
    ctx.note(`driver error: ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    const lines = [`# O3 real-container tests, PostgreSQL ${MAJOR}`, '', `rab-api /tmp workaround: ${API_TMP_WORKAROUND ? 'ON (TEST-ONLY overlay o3-tests/docker-compose.o3t-api-tmp.yml, defect T8a-TMP)' : 'off (shipped compose files only)'}`, `images: base ${process.env.O3T_IMAGE}; broken ${process.env.O3T_IMAGE_BROKEN}; fixed ${process.env.O3T_IMAGE_FIXED}${process.env.O3T_IMAGE_LABEL ? ` (${process.env.O3T_IMAGE_LABEL})` : ''}`, '', '| test | status | checks |', '|---|---|---|'];
    for (const r of results) lines.push(`| ${r.id} ${r.title} | ${r.status} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} |`);
    fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), `${lines.join('\n')}\n`);
    fs.writeFileSync(path.join(OUT, 'RESULTS.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(OUT, 'driver.log'), ctx.log.join('\n'));
    if (results.some((r) => r.status !== 'PASS')) process.exitCode = 1;
  });
