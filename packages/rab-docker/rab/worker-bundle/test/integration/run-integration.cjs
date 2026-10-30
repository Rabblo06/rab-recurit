'use strict';
/**
 * Worker bundle integration harness — runs ONLY against its own disposable Docker Compose project
 * (`crewflow-bundle-test`, docker-compose.bundle-test.yml): a throwaway PostgreSQL migrated by the guarded runner, a
 * throwaway Redis, a local SMTP sink, the restricted API and one or two bundled Worker containers. It never reads a
 * .env file, never uses DATABASE_URL from the environment, publishes no host port, and touches no other container.
 *
 *   node packages/rab-docker/rab/worker-bundle/test/integration/run-integration.cjs <evidence-dir> [--keep]
 *
 * Images (build first): crewflow-app:bundle-test (shared image) and crewflow-worker-bundle:bundle-test.
 * Credentials are random per run and redacted from every evidence file. Each case is recorded PASS / FAIL / BLOCKED
 * with its raw command output in <evidence-dir>/NN-*.log and a summary in <evidence-dir>/SUMMARY.md.
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT = 'crewflow-bundle-test';
const FILE = path.join(__dirname, 'docker-compose.bundle-test.yml');
const OUT = path.resolve(process.argv[2] || '');
const KEEP = process.argv.includes('--keep');
if (!process.argv[2]) {
  console.error('usage: run-integration.cjs <evidence-dir> [--keep]');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const hex = (n) => crypto.randomBytes(n).toString('hex');
const SECRETS = {
  BT_SUPERUSER_PASSWORD: hex(24),
  BT_CREWFLOW_PASSWORD: hex(24),
  BT_APP_PASSWORD: hex(24),
  BT_APP_SECRET: hex(48),
  BT_FIXTURE_PASSWORD: `Fx${hex(16)}`,
};
// Never inherit a developer DATABASE_URL / TEST_* into compose interpolation or the docker CLI.
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DATABASE_|TEST_|CREWFLOW_|REDIS_URL|DB_TARGET)/.test(k)));
const ENV = { ...BASE_ENV, ...SECRETS, COMPOSE_PROJECT_NAME: PROJECT, MSYS_NO_PATHCONV: '1' };
const redact = (s) => Object.values(SECRETS).reduce((acc, v) => acc.split(v).join('<redacted>'), String(s ?? ''));

let currentLog = path.join(OUT, '00-setup.log');
const write = (text) => fs.appendFileSync(currentLog, `${redact(text)}\n`);

function docker(args, { input, timeout = 300_000, env = {}, quiet = false } = {}) {
  const res = spawnSync('docker', args, { env: { ...ENV, ...env }, encoding: 'utf8', input, timeout, maxBuffer: 64 * 1024 * 1024 });
  const raw = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const out = redact(raw);
  if (!quiet) write(`$ docker ${redact(args.join(' ')).slice(0, 400)}\n${out.trimEnd()}\n[exit ${res.status}]`);
  // Raw (unredacted) output is kept ONLY in memory, for the secret-leak check (case 32); it is never written anywhere.
  return { code: res.status, out, raw };
}
/** Raw outputs of every bundle/API start attempt, for the end-of-run leak check. Never persisted. */
const RAW_SERVICE_OUTPUTS = [];
const compose = (args, opts) => docker(['compose', '-p', PROJECT, '-f', FILE, ...args], opts);
const psql = (sql, opts = {}) => compose(['exec', '-T', 'pg', 'psql', '-U', opts.user || 'rab', '-d', 'rab', '-v', 'ON_ERROR_STOP=1', '-qAt', ...(opts.extra || [])], { input: sql, quiet: opts.quiet, timeout: opts.timeout ?? 60_000 });
const sql1 = (sql) => psql(sql, { quiet: true }).out.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, predicate, timeoutMs, everyMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await sleep(everyMs);
  }
}

const results = [];
async function step(id, title, fn) {
  currentLog = path.join(OUT, `${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}.log`);
  fs.writeFileSync(currentLog, `# ${id} ${title}\n# ${new Date().toISOString()}\n`);
  const started = Date.now();
  let status = 'PASS';
  let note = '';
  try {
    const r = await fn();
    if (r && r.status) ({ status, note = '' } = r);
    else if (typeof r === 'string') note = r;
  } catch (e) {
    status = 'FAIL';
    note = redact(e.message);
  }
  write(`\n# RESULT: ${status}${note ? ` — ${note}` : ''} (${Math.round((Date.now() - started) / 1000)}s)`);
  results.push({ id, title, status, note, log: path.basename(currentLog) });
  console.log(`${status.padEnd(7)} ${id} ${title}${note ? ` — ${note}` : ''}`);
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

// ------------------------------------------------------------------------------------------------ helpers (stack)

function containerId(service) {
  return compose(['ps', '-a', '-q', service], { quiet: true }).out.trim().split('\n')[0];
}
function inspect(service, format) {
  const id = containerId(service);
  return id ? docker(['inspect', '-f', format, id], { quiet: true }).out.trim() : '';
}
const healthOf = (service) => inspect(service, '{{if .State.Health}}{{.State.Health.Status}}{{end}}');
const restartsOf = (service) => Number(inspect(service, '{{.RestartCount}}') || 0);
const runningOf = (service) => inspect(service, '{{.State.Running}}') === 'true';
const logsOf = (service) => compose(['logs', '--no-color', service], { quiet: true }).out;

/** pid table inside a bundle container: [{pid, uid, cmd}] (read as root; /proc status/cmdline are world-readable). */
function procTable(service) {
  const script = 'for p in /proc/[0-9]*; do u=$(awk \'/^Uid:/{print $2}\' $p/status 2>/dev/null) || continue; c=$(tr "\\0" " " < $p/cmdline 2>/dev/null); [ -n "$u" ] && echo "${p#/proc/}|$u|$c"; done';
  const r = compose(['exec', '-T', '-u', '0:0', service, 'sh', '-c', script], { quiet: true });
  return r.out.split('\n').filter((l) => /^\d+\|/.test(l)).map((l) => {
    const [pid, uid, ...cmd] = l.split('|');
    return { pid: Number(pid), uid: Number(uid), cmd: cmd.join('|').trim() };
  });
}
function bundlePids(service) {
  const t = procTable(service);
  const find = (uid, re) => t.find((p) => p.uid === uid && re.test(p.cmd))?.pid;
  return {
    table: t,
    // node itself, not PID 1 (tini), whose command line also names the launcher script.
    launcher: find(0, /^\S*node \/opt\/crewflow-bundle\/start-worker-bundle\.cjs/),
    jobs: find(1000, /rab-worker\/dist\/main\.js/),
    provisioner: find(10001, /workspace-provisioner\.main\.js/),
  };
}
function execAs(service, user, script, env = {}) {
  // `env -i`: docker exec would otherwise hand the CONTAINER's configured environment (which, for the bundle, includes
  // the launcher's provisioning URL) to this shell — the real jobs child never has it. See the report.
  const pass = Object.keys(env).flatMap((k) => ['-e', k]);
  const keep = Object.keys(env).map((k) => `${k}="$${k}"`).join(' ');
  return compose(['exec', '-T', '-u', user, ...pass, service, 'sh', '-c', `exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp ${keep} sh -c '${script.replace(/'/g, `'"'"'`)}'`], { env });
}

function seedCreatingWorkspace(label, { blockSchema = false } = {}) {
  const r = psql(`
DO $$
DECLARE o uuid; u uuid; r uuid; w uuid := gen_random_uuid();
BEGIN
  INSERT INTO core.organisation(name, slug) VALUES ('${label}', '${label}') RETURNING id INTO o;
  PERFORM set_config('rab.organisation_id', o::text, true);
  INSERT INTO core.role(organisation_id, key, name, is_system) VALUES (o, 'manager', 'Manager', true) RETURNING id INTO r;
  INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES (o, '${label}@bundle-test.invalid', 'BT', 'Owner', 'active') RETURNING id INTO u;
  INSERT INTO core.user_role(user_id, role_id, organisation_id) VALUES (u, r, o);
  PERFORM set_config('rab.user_id', u::text, true);
  ${blockSchema ? "EXECUTE format('CREATE SCHEMA %I', 'workspace_' || replace(w::text, '-', '')); EXECUTE format('CREATE TABLE %I.blocker(i int)', 'workspace_' || replace(w::text, '-', ''));" : ''}
  INSERT INTO core.manager_workspace(id, organisation_id, owner_user_id, name, subdomain, status, schema_status) VALUES (w, o, u, '${label} Workspace', '${label}', 'active', 'CREATING');
  PERFORM set_config('rab.workspace_id', w::text, true);
  INSERT INTO core.manager_profile(organisation_id, user_id, type, workspace_id) VALUES (o, u, 'internal', w);
END $$;
SELECT id || '|' || organisation_id FROM core.manager_workspace WHERE subdomain = '${label}';`);
  assert(r.code === 0, `seeding ${label} failed`);
  const [id, organisationId] = r.out.trim().split('\n').pop().split('|');
  return { id, organisationId, schema: `workspace_${id.replace(/-/g, '')}` };
}
const wsStatus = (id) => sql1(`SELECT coalesce(mw.schema_status,'NULL') || '|' || coalesce(r.status,'-') FROM core.manager_workspace mw LEFT JOIN core.workspace_schema_registry r ON r.workspace_id = mw.id WHERE mw.id = '${id}'`);
function schemaFacts(schema) {
  return sql1(`SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${schema}' AND c.relkind = 'r') || '|' ||
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${schema}' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity) || '|' ||
  (SELECT count(*) FROM pg_policies WHERE schemaname = '${schema}') || '|' ||
  (SELECT count(*) FROM information_schema.table_privileges WHERE table_schema = '${schema}' AND grantee = 'crewflow_app') || '|' ||
  (SELECT coalesce(pg_get_userbyid(nspowner), '-') FROM pg_namespace WHERE nspname = '${schema}')`);
}

// ------------------------------------------------------------------------------------------------ the run

(async () => {
  write(`# Worker bundle integration — project ${PROJECT}, compose file ${path.relative(process.cwd(), FILE)}`);
  write(`# images: app=${docker(['image', 'inspect', '-f', '{{.Id}}', 'crewflow-app:bundle-test'], { quiet: true }).out.trim()} bundle=${docker(['image', 'inspect', '-f', '{{.Id}}', 'crewflow-worker-bundle:bundle-test'], { quiet: true }).out.trim()}`);
  compose(['--profile', '*', 'down', '-v', '--remove-orphans']);

  let fx = {};

  await step('10', 'Isolated stack and guarded migrations (throwaway database only)', async () => {
    assert(compose(['up', '-d', '--wait', 'pg', 'redis', 'smtp']).code === 0, 'infra did not start');
    const a = compose(['--profile', 'migrate', 'run', '--rm', 'migrate'], { env: { BT_MIGRATION_URL: 'postgres://rab_owner:rab_owner_dev_only@pg:5432/rab' } });
    assert(/refuses to run as 'rab_owner'/.test(a.out), 'phase A did not stop at the role split');
    const b = compose(['--profile', 'migrate', 'run', '--rm', 'migrate'], {
      env: { BT_MIGRATION_URL: `postgres://rab:${SECRETS.BT_SUPERUSER_PASSWORD}@pg:5432/rab`, BT_BOOTSTRAP_CREWFLOW: SECRETS.BT_CREWFLOW_PASSWORD, BT_BOOTSTRAP_APP: SECRETS.BT_APP_PASSWORD },
    });
    assert(b.code === 0 && /Migrations applied/.test(b.out), 'phase B failed');
    const roles = sql1(`SELECT string_agg(rolname || ':' || rolcanlogin || ':' || rolsuper || ':' || rolbypassrls, ' ' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('crewflow','crewflow_app','rab_secure_owner')`);
    write(`roles: ${roles}`);
    assert(roles === 'crewflow:true:false:false crewflow_app:true:false:false rab_secure_owner:false:false:false', 'unexpected role posture');
    const seed = compose(['--profile', 'cli', 'run', '--rm', '-e', `DATABASE_URL=postgres://rab:${SECRETS.BT_SUPERUSER_PASSWORD}@pg:5432/rab`, 'cli', 'seed-qa']);
    assert(/Seeded QA fixture/.test(seed.out), 'seed-qa fixture failed');
    fx.legacyWorkspace = sql1(`SELECT id FROM core.manager_workspace WHERE subdomain = 'adolphus-qa'`);
    fx.migrationsBefore = sql1('SELECT count(*) FROM core.migrations');
    write(`legacy (pre-existing) workspace ${fx.legacyWorkspace}; migrations applied ${fx.migrationsBefore}`);
    fx.probe = seedCreatingWorkspace('bt-first');
    write(`synthetic CREATING workspace ${fx.probe.id}`);
    return `migrations=${fx.migrationsBefore}`;
  });

  await step('11', 'Restricted API and bundled worker start; both children identified', async () => {
    assert(compose(['up', '-d', '--wait', '--wait-timeout', '180', 'api', 'worker-a']).code === 0, 'api/worker-a not healthy');
    const logs = logsOf('worker-a');
    write(logs.split('\n').filter((l) => /worker-bundle\]|runtime-db-guard|workspace-provisioner\] started|rab-worker ready/.test(l)).join('\n'));
    assert(/\[worker-bundle\] live identity probes agree: database=rab cluster=\d+ \(jobs=crewflow_app, provisioner=crewflow\)/.test(logs), 'no agreeing live identity line');
    assert(/\[jobs\] rab-worker ready/.test(logs), 'jobs not ready');
    // Phase A: HWS is passed through (this stack does not set it), provisioning is enabled by CREWFLOW_PROVISIONER_ENABLED.
    assert(/\[provisioner\] \[workspace-provisioner\] started, HWS_RUNTIME_ENABLED=\S+ \(provisioning enabled by CREWFLOW_PROVISIONER_ENABLED; interval 5s\)/.test(logs), 'provisioner not started');
    const p = bundlePids('worker-a');
    write(JSON.stringify({ launcher: p.launcher, jobs: p.jobs, provisioner: p.provisioner }));
    write(p.table.map((x) => `${x.pid} uid=${x.uid} ${x.cmd}`).join('\n'));
    assert(p.launcher && p.jobs && p.provisioner, 'missing a process');
    fx.pids = p;
  });

  await step('11b', 'API starts as the restricted runtime role and refuses any provisioning credential', async () => {
    const apiLogs = logsOf('api');
    assert(/\[runtime-db-guard\] process=api .* role=crewflow_app probe=read-only-ok/.test(apiLogs), 'API guard line missing or wrong role');
    write(apiLogs.split('\n').filter((l) => /runtime-db-guard/.test(l)).join('\n'));
    for (const name of ['DATABASE_URL_UNPOOLED', 'CREWFLOW_PROVISIONER_DATABASE_URL']) {
      const r = compose(['run', '--rm', '--no-deps', '-e', name, 'api'], { env: { [name]: `postgres://crewflow:${SECRETS.BT_CREWFLOW_PASSWORD}@pg:5432/rab` }, timeout: 120_000 });
      RAW_SERVICE_OUTPUTS.push(r.raw);
      write(`--- API with ${name}: exit=${r.code}`);
      assert(r.code === 1 && new RegExp(`\\[runtime-db-guard\\] refused: ${name} is present in the api process`).test(r.out), `API did not refuse ${name}`);
      assert(!r.raw.includes(SECRETS.BT_CREWFLOW_PASSWORD), `API refusal printed the ${name} value`);
    }
    return 'role=crewflow_app; refused DATABASE_URL_UNPOOLED and CREWFLOW_PROVISIONER_DATABASE_URL';
  });

  await step('12', 'Real process identities, supplementary groups and capabilities', async () => {
    const { launcher, jobs, provisioner } = fx.pids;
    const r = compose(['exec', '-T', '-u', '0:0', 'worker-a', 'sh', '-c',
      `for p in 1 ${launcher} ${jobs} ${provisioner}; do echo "--- pid $p: $(tr '\\0' ' ' < /proc/$p/cmdline)"; grep -E '^(Uid|Gid|Groups|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):' /proc/$p/status; done`]);
    const block = (pid) => r.out.split('--- pid ').find((b) => b.startsWith(`${pid}:`)) || '';
    const field = (pid, k) => (new RegExp(`^${k}:[ \\t]*(.*)$`, 'm').exec(block(pid)) || [])[1]?.trim();
    for (const [pid, uid] of [[jobs, '1000'], [provisioner, '10001']]) {
      assert(field(pid, 'Uid').split(/\s+/).every((x) => x === uid), `pid ${pid} uid`);
      assert(field(pid, 'Gid').split(/\s+/).every((x) => x === uid), `pid ${pid} gid`);
      assert((field(pid, 'Groups') ?? '') === '', `pid ${pid} has supplementary groups`);
      for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) assert(field(pid, k) === '0000000000000000', `pid ${pid} ${k}=${field(pid, k)}`);
      assert(field(pid, 'NoNewPrivs') === '1', `pid ${pid} NoNewPrivs`);
    }
    // Launcher: root, but only CAP_KILL|CAP_SETGID|CAP_SETUID (0x20 | 0x40 | 0x80 = 0xe0).
    assert(field(launcher, 'CapEff') === '00000000000000e0', `launcher CapEff=${field(launcher, 'CapEff')}`);
    assert(field(launcher, 'CapBnd') === '00000000000000e0', `launcher CapBnd=${field(launcher, 'CapBnd')}`);
    const hc = inspect('worker-a', '{{json .HostConfig.ReadonlyRootfs}} {{json .HostConfig.Privileged}} {{json .HostConfig.PidMode}} {{json .HostConfig.CapDrop}} {{json .HostConfig.CapAdd}} {{json .HostConfig.SecurityOpt}} {{json .HostConfig.Binds}} {{json .Config.ExposedPorts}}');
    write(`HostConfig: ${hc}`);
    assert(/^true false "" \["ALL"\]/.test(hc) && !/docker\.sock/.test(hc), 'unexpected host config');
  });

  await step('13', 'Child environments match the reviewed manifests (real /proc/<pid>/environ, key names only)', async () => {
    const { jobs, provisioner } = fx.pids;
    const j = execAs('worker-a', '1000:1000', `tr '\\0' '\\n' < /proc/${jobs}/environ | cut -d= -f1 | sort | tr '\\n' ' '`);
    const p = execAs('worker-a', '10001:10001', `tr '\\0' '\\n' < /proc/${provisioner}/environ | cut -d= -f1 | sort | tr '\\n' ' '; echo; tr '\\0' '\\n' < /proc/${provisioner}/environ | sed -n 's#^DATABASE_URL=postgres://\\([^:]*\\):.*@\\([^/]*\\)/\\(.*\\)#DATABASE_URL user=\\1 host=\\2 db=\\3#p'`);
    const jobsKeys = j.out.trim().split(/\s+/);
    const provKeys = p.out.trim().split('\n')[0].trim().split(/\s+/);
    for (const forbidden of ['DATABASE_URL_UNPOOLED', 'CREWFLOW_PROVISIONER_DATABASE_URL', 'NODE_OPTIONS', 'DB_TARGET']) assert(!jobsKeys.includes(forbidden), `jobs has ${forbidden}`);
    assert(jobsKeys.includes('DATABASE_DIRECT_URL') && jobsKeys.includes('APP_SECRET'), 'jobs missing required keys');
    // Phase A: HWS_RUNTIME_ENABLED is passed through only when the service sets it (this stack does not); the launcher sets the
    // explicit opt-in and the validated interval.
    assert(provKeys.join(' ') === 'CREWFLOW_INSTANCE_HEALTH_FILE CREWFLOW_PROVISIONER_ENABLED DATABASE_URL DATABASE_URL_UNPOOLED HOME NODE_ENV PATH RAB_RUNTIME_ENV REDIS_URL TMPDIR WORKSPACE_PROVISIONER_INTERVAL_SECONDS', `provisioner keys: ${provKeys.join(' ')}`);
    for (const key of ['CREWFLOW_PROVISIONER_ENABLED', 'WORKSPACE_PROVISIONER_INTERVAL_SECONDS']) assert(!jobsKeys.includes(key), `jobs has ${key}`);
    assert(/DATABASE_URL user=crewflow host=pg:5432 db=rab/.test(p.out), 'provisioner DB identity');
  });

  await step('14', 'Jobs identity cannot read, signal, rewrite or discover the provisioner (read-only root)', async () => isolationProbe('worker-a', /Read-only file system|Permission denied/, /Read-only file system/));

  await step('15', 'Database routes: pooled/direct/runtime identities, same physical cluster, restricted role posture', async () => {
    const ipA = inspect('worker-a', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}');
    const ipApi = inspect('api', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}');
    const act = sql1(`SELECT string_agg(src || ':' || usename || '=' || n, ' ' ORDER BY src, usename) FROM (SELECT CASE host(client_addr) WHEN '${ipA}' THEN 'worker-a' WHEN '${ipApi}' THEN 'api' ELSE coalesce(host(client_addr), 'local') END AS src, usename, count(*) n FROM pg_stat_activity WHERE datname = 'rab' AND usename IS NOT NULL AND pid <> pg_backend_pid() GROUP BY 1, 2) s`);
    write(`pg_stat_activity by source container: ${act}`);
    assert(/worker-a:crewflow=1\b/.test(act), 'worker-a must hold exactly one crewflow (provisioner) connection');
    assert(/worker-a:crewflow_app=\d+/.test(act), 'worker-a jobs must use crewflow_app');
    assert(!/api:crewflow=/.test(act), 'API must never connect as crewflow');
    const sid = sql1('SELECT system_identifier FROM pg_control_system()');
    assert(new RegExp(`live identity probes agree: database=rab cluster=${sid}`).test(logsOf('worker-a')), 'launcher-reported cluster differs from the server');
    write(`server system_identifier ${sid} == cluster reported by both children's live probes`);
    const posture = sql1(`SELECT r.rolname || ' super=' || r.rolsuper || ' bypassrls=' || r.rolbypassrls || ' owns=' || (SELECT count(*) FROM pg_class WHERE relowner = r.oid) || ' member_of=' || coalesce((SELECT string_agg(g.rolname, ',') FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid), '-') FROM pg_roles r WHERE r.rolname = 'crewflow_app'`);
    write(`crewflow_app posture: ${posture}`);
    assert(/super=false bypassrls=false owns=0 member_of=-/.test(posture), 'crewflow_app posture');
  });

  await step('16', 'Provisioner (bundled) brings a synthetic workspace from CREATING to READY with full V1 structure', async () => {
    await waitFor('bt-first READY', () => wsStatus(fx.probe.id) === 'READY|READY', 60_000);
    const facts = schemaFacts(fx.probe.schema).split('|').map((x) => x);
    write(`schema ${fx.probe.schema}: tables=${facts[0]} forced_rls=${facts[1]} policies=${facts[2]} crewflow_app_grants=${facts[3]} owner=${facts[4]}`);
    const reg = sql1(`SELECT status || ' v' || schema_version || ' ready_at=' || (ready_at IS NOT NULL) || ' error=' || coalesce(migration_error, '-') FROM core.workspace_schema_registry WHERE workspace_id = '${fx.probe.id}'`);
    write(`registry: ${reg}`);
    fx.v1 = { tables: Number(facts[0]), policies: Number(facts[2]) };
    assert(Number(facts[0]) >= 15 && facts[0] === facts[1], 'every table must have ENABLE+FORCE RLS');
    assert(Number(facts[2]) > 0 && Number(facts[3]) > 0, 'policies/grants missing');
    // Existing design: core.provision_workspace_schema (SECURITY DEFINER) creates the schema owned by rab_secure_owner (NOLOGIN).
    assert(facts[4] === 'rab_secure_owner', `schema owner ${facts[4]} (expected rab_secure_owner; never the runtime role)`);
    fx.v1.owner = facts[4];
    assert(/^READY v1 ready_at=true error=-$/.test(reg), 'registry lifecycle');
    return `tables=${facts[0]} policies=${facts[2]}`;
  });

  await step('17', 'Runtime credential (crewflow_app) cannot perform provisioning DDL; RLS isolates workspaces', async () => {
    const s = fx.probe.schema;
    const other = seedCreatingWorkspace('bt-second');
    await waitFor('bt-second READY', () => wsStatus(other.id) === 'READY|READY', 60_000);
    // Fixture rows (superuser): one job_role in each workspace.
    psql(`SELECT set_config('rab.organisation_id','${fx.probe.organisationId}',false), set_config('rab.workspace_id','${fx.probe.id}',false);
INSERT INTO ${s}.job_role(organisation_id, workspace_id, name) VALUES ('${fx.probe.organisationId}', '${fx.probe.id}', 'bt-role-A');
SELECT set_config('rab.organisation_id','${other.organisationId}',false), set_config('rab.workspace_id','${other.id}',false);
INSERT INTO ${other.schema}.job_role(organisation_id, workspace_id, name) VALUES ('${other.organisationId}', '${other.id}', 'bt-role-B');`);
    const attempts = [
      ['CREATE SCHEMA bt_ddl_probe', /permission denied/],
      [`CREATE TABLE ${s}.bt_ddl_probe(i int)`, /permission denied/],
      [`DROP TABLE ${s}.job_role`, /must be owner/],
      [`ALTER TABLE ${s}.job_role DISABLE ROW LEVEL SECURITY`, /must be owner/],
      ['CREATE TABLE core.bt_ddl_probe(i int)', /permission denied/],
      [`SELECT core.provision_workspace_schema('${other.id}')`, /permission denied/],
      ['SET ROLE crewflow', /permission denied/],
    ];
    for (const [stmt, expected] of attempts) {
      const r = psql(stmt, { user: 'crewflow_app' });
      assert(r.code !== 0 && expected.test(r.out), `crewflow_app was not refused: ${stmt}`);
    }
    const q = (org, ws, table) => psql(`${org ? `SELECT set_config('rab.organisation_id','${org}',false), set_config('rab.workspace_id','${ws}',false);` : ''} SELECT count(*) FROM ${table};`, { user: 'crewflow_app', quiet: false }).out.trim().split('\n').pop();
    const noCtx = q(null, null, `${s}.job_role`);
    const own = q(fx.probe.organisationId, fx.probe.id, `${s}.job_role`);
    const cross = q(other.organisationId, other.id, `${s}.job_role`);
    write(`crewflow_app reads ${s}.job_role: no context=${noCtx} own workspace=${own} other workspace's context=${cross}`);
    assert(noCtx === '0' && own === '1' && cross === '0', 'RLS isolation');
    fx.other = other;
  });

  await step('18', 'Existing workspaces keep operating; no startup migration; ordinary job loops run as crewflow_app', async () => {
    const legacy = wsStatus(fx.legacyWorkspace);
    const pending = sql1('SELECT count(*) FROM core.worker_list_pending_workspace_schemas(100)');
    const migrations = sql1('SELECT count(*) FROM core.migrations');
    const stats = compose(['exec', '-T', 'redis', 'redis-cli', 'HGETALL', 'rab:worker:stats'], { quiet: true }).out.trim().split('\n');
    const statKeys = stats.filter((_, i) => i % 2 === 0).filter((k) => /^last/.test(k)).sort();
    write(`legacy workspace (pre-existing, not HWS) status: ${legacy}; pending provisioning: ${pending}; migrations ${fx.migrationsBefore} -> ${migrations}`);
    write(`job loops that completed a cycle (rab:worker:stats keys): ${statKeys.join(' ')}`);
    const logs = logsOf('worker-a');
    assert(legacy === 'NULL|-', 'legacy workspace touched');
    assert(pending === '0', 'workspaces left pending');
    assert(migrations === fx.migrationsBefore, 'a migration ran at startup');
    assert(!/Running pending migrations|Migrations applied|setup-db/.test(logs), 'migration output in bundle logs');
    assert(!/cycle failed/.test(logs), 'a job cycle failed');
    assert(statKeys.length >= 8, 'too few job loops recorded a cycle');
    // The ordinary worker's OWN guard is still in the built code: give its entrypoint the privileged variable directly.
    const g = execAs('worker-a', '1000:1000', 'cd /app && NODE_ENV=development RAB_RUNTIME_ENV=development DATABASE_URL=postgres://crewflow_app:x@pg:5432/rab DATABASE_URL_UNPOOLED=postgres://crewflow:x@pg:5432/rab REDIS_URL=redis://redis:6379 node packages/rab-worker/dist/main.js; echo exit=$?');
    assert(/only the provisioner process may hold it/.test(g.out) && /exit=1/.test(g.out), 'jobs entrypoint guard not active');
    const g2 = execAs('worker-a', '1000:1000', 'cd /app && NODE_ENV=development RAB_RUNTIME_ENV=development DATABASE_URL=postgres://crewflow_app:x@pg:5432/rab CREWFLOW_PROVISIONER_DATABASE_URL=postgres://crewflow:x@pg:5432/rab REDIS_URL=redis://redis:6379 node packages/rab-worker/dist/main.js; echo exit=$?');
    assert(/CREWFLOW_PROVISIONER_DATABASE_URL is present in the worker process/.test(g2.out) && /exit=1/.test(g2.out), 'jobs entrypoint did not refuse the bundle provisioning variable');
    return `${statKeys.length} loops ran`;
  });

  await step('19', 'Real ordinary email job through the bundled jobs process to a local SMTP sink', async () => {
    const before = compose(['exec', '-T', 'smtp', 'sh', '-c', 'ls /out | wc -l'], { quiet: true }).out.trim();
    const r = compose(['exec', '-T', 'api', 'wget', '-qO-', '--header=Content-Type: application/json', '--post-data={"email":"manager.qa@example.test"}', 'http://localhost:3000/rest/v1/auth/forgot-password']);
    write(`forgot-password request exit=${r.code}`);
    await waitFor('email in sink', () => Number(compose(['exec', '-T', 'smtp', 'sh', '-c', 'ls /out | wc -l'], { quiet: true }).out.trim()) > Number(before), 60_000);
    const mail = compose(['exec', '-T', 'smtp', 'sh', '-c', 'f=$(ls -t /out | head -1); grep -E "^(X-Sink-Rcpt-To|Subject):" /out/$f; grep -c "reset-password?token=" /out/$f'], { quiet: true }).out;
    write(mail.replace(/token=[A-Za-z0-9_\-.%]+/g, 'token=<redacted>'));
    const outbox = sql1(`SELECT string_agg(status, ',') FROM core.email_outbox`);
    write(`email_outbox statuses: ${outbox}`);
    assert(/manager\.qa@example\.test/.test(mail), 'mail not addressed to the fixture user');
    assert(/[Ss]ent|SENT|delivered/i.test(outbox), 'outbox not marked sent');
    assert(/\[jobs\].*email/i.test(logsOf('worker-a')), 'jobs process did not log the email work');
  });

  await step('20', 'PDF rendering (system Chromium) as the jobs identity under the read-only root', async () => {
    const r = execAs('worker-a', '1000:1000', 'cd /app && HOME=/tmp/crewflow-jobs TMPDIR=/tmp/crewflow-jobs CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium CHROMIUM_NO_SANDBOX=true node -e "require(\\"/app/packages/rab-worker/dist/queues/rab-reports/render-pdf.util.js\\").renderHtmlToPdf(\\"<h1>bundle test</h1>\\").then(b=>console.log(\\"pdf bytes=\\"+b.length+\\" magic=\\"+b.subarray(0,5).toString()),e=>{console.error(\\"render failed: \\"+e.message);process.exit(1)})"');
    assert(/pdf bytes=\d+ magic=%PDF-/.test(r.out), 'render failed');
    const leftovers = procTable('worker-a').filter((p) => /chrom/i.test(p.cmd));
    write(`chromium processes left after render: ${leftovers.length}`);
    assert(leftovers.length === 0, 'chromium left running');
    return { status: 'PASS', note: 'renderer smoke only — a scheduled report-PDF job needs shift/attendance fixtures (see report)' };
  });

  await step('20b', 'Real scheduled pre-shift report job: PDF rendered, stored and emailed by the bundled jobs process', async () => {
    // Fixture (superuser): one open shift starting in 20 minutes at the seed-qa venue (legacy, non-HWS workspace).
    const ids = sql1(`SELECT v.id || '|' || v.organisation_id || '|' || v.workspace_id || '|' || (SELECT id FROM core.job_role WHERE organisation_id = v.organisation_id LIMIT 1) || '|' || (SELECT id FROM core."user" WHERE email = 'manager.qa@example.test') FROM core.venue v LIMIT 1`).split('|');
    const [venueId, orgId, wsId, jobRoleId, managerId] = ids;
    const shiftId = sql1(`SELECT set_config('rab.organisation_id','${orgId}',false); INSERT INTO core.shift(organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, status, created_by, published_at)
      VALUES ('${orgId}', '${wsId}', '${venueId}', '${jobRoleId}', now() + interval '20 minutes', now() + interval '4 hours', 1, 1200, 'open', '${managerId}', now()) RETURNING id;`).split('\n').pop();
    write(`fixture shift ${shiftId}`);
    const mailsBefore = Number(compose(['exec', '-T', 'smtp', 'sh', '-c', 'ls /out | wc -l'], { quiet: true }).out.trim());
    compose(['restart', '-t', '60', 'worker-a']); // the scheduler runs its first cycle at start (otherwise every 5 minutes)
    const report = await waitFor('report ready', () => {
      const v = sql1(`SELECT status || '|' || (pre_shift_pdf_generated_at IS NOT NULL) FROM core.shift_report WHERE shift_id = '${shiftId}'`);
      return /^ready\|true$/.test(v) ? v : null;
    }, 180_000, 3000);
    const file = sql1(`SELECT kind || '|' || coalesce(size_bytes::text, '?') || '|' || status FROM core.stored_file WHERE kind ILIKE '%roster%' OR kind ILIKE '%pdf%' ORDER BY created_at DESC LIMIT 1`);
    write(`shift_report: ${report}; stored_file: ${file}`);
    await waitFor('report email in sink', () => Number(compose(['exec', '-T', 'smtp', 'sh', '-c', 'ls /out | wc -l'], { quiet: true }).out.trim()) > mailsBefore, 120_000, 3000);
    const mail = compose(['exec', '-T', 'smtp', 'sh', '-c', 'f=$(ls -t /out | head -1); grep -E "^(X-Sink-Rcpt-To|Subject):" /out/$f; grep -ciE "filename=.*\\.pdf" /out/$f'], { quiet: true }).out;
    write(mail);
    const logs = logsOf('worker-a');
    write(logs.split('\n').filter((l) => /shift report scheduler/.test(l)).slice(-3).join('\n'));
    assert(/shift report scheduler: generated=1/.test(logs), 'scheduler did not log the generated report');
    assert(/venue\.qa@example\.test|manager\.qa@example\.test/.test(mail), 'report email not addressed to a fixture manager');
    return 'pre-shift PDF generated under the read-only root, stored, emailed via the sink';
  });

  await step('21', 'Two bundled Worker instances never provision the same workspace twice (advisory lock)', async () => {
    compose(['stop', '-t', '60', 'worker-a']);
    const many = Array.from({ length: 6 }, (_, i) => seedCreatingWorkspace(`bt-race-${i}`));
    compose(['--profile', 'second', 'up', '-d', 'worker-a', 'worker-b']);
    await waitFor('all race workspaces READY', () => many.every((w) => wsStatus(w.id) === 'READY|READY'), 120_000);
    await sleep(6000);
    for (const w of many) {
      const n = sql1(`SELECT (SELECT count(*) FROM core.workspace_schema_registry WHERE workspace_id = '${w.id}') || '|' || (SELECT count(*) FROM pg_namespace WHERE nspname = '${w.schema}')`);
      assert(n === '1|1', `${w.id}: registry/schema count ${n}`);
    }
    const ready = (svc) => [...logsOf(svc).matchAll(/workspace provisioning: attempted=(\d+) ready=(\d+) failed=(\d+)/g)].reduce((a, m) => a + Number(m[2]), 0);
    const a = ready('worker-a');
    const b = ready('worker-b');
    write(`READY transitions logged — worker-a: ${a} (includes earlier runs), worker-b: ${b}; failures: ${/failed=[1-9]/.test(logsOf('worker-a') + logsOf('worker-b'))}`);
    assert(!/failed=[1-9]/.test(logsOf('worker-b')), 'a racing instance recorded a failure');
    return `6 workspaces, 1 schema each; worker-b provisioned ${b}`;
  });

  await step('22', 'Health covers both roles per instance; a hung provisioner is not masked by a healthy replica', async () => {
    await waitFor('both healthy', () => healthOf('worker-a') === 'healthy' && healthOf('worker-b') === 'healthy', 120_000);
    const pb = bundlePids('worker-b');
    const restartsBefore = restartsOf('worker-b');
    compose(['exec', '-T', '-u', '0:0', 'worker-b', 'kill', '-STOP', String(pb.provisioner)]);
    write(`SIGSTOP worker-b provisioner pid ${pb.provisioner} (simulated hang)`);
    await waitFor('worker-b unhealthy', () => healthOf('worker-b') === 'unhealthy', 120_000, 3000);
    const hc = compose(['exec', '-T', 'worker-b', 'node', '/opt/crewflow-bundle/worker-bundle-health.cjs']).out;
    const ttl = compose(['exec', '-T', 'redis', 'redis-cli', 'TTL', 'rab:workspace-provisioner:heartbeat'], { quiet: true }).out.trim();
    const [sec, usec] = compose(['exec', '-T', 'redis', 'redis-cli', 'TIME'], { quiet: true }).out.trim().split(/\s+/).map(Number);
    const beatAt = Number(compose(['exec', '-T', 'redis', 'redis-cli', 'GET', 'rab:workspace-provisioner:heartbeat'], { quiet: true }).out.trim());
    const age = sec * 1000 + Math.floor(usec / 1000) - beatAt;
    write(`GLOBAL rab:workspace-provisioner:heartbeat: TTL=${ttl}s, age=${age}ms (kept fresh by worker-a) — while worker-b reports: ${hc.trim()}`);
    assert(/provisioner: UNHEALTHY - .*heartbeat stale/.test(hc), 'worker-b health did not name the provisioner');
    assert(Number(ttl) > 0 && Number(age) < 30_000, 'global key not fresh (masking not demonstrated)');
    assert(healthOf('worker-a') === 'healthy', 'worker-a should stay healthy');
    await waitFor('watchdog ends worker-b and the platform restarts it', () => restartsOf('worker-b') > restartsBefore, 180_000, 3000);
    write(logsOf('worker-b').split('\n').filter((l) => /worker-bundle\]/.test(l)).slice(-12).join('\n'));
    assert(/provisioner: no heartbeat for \d+s — process is hung/.test(logsOf('worker-b')), 'watchdog line missing');
    await waitFor('worker-b healthy again', () => healthOf('worker-b') === 'healthy', 180_000, 3000);
    compose(['stop', '-t', '60', 'worker-b']);
  });

  await step('23', 'Unexpected child exits (crash and zero exit) fail the whole service; survivor drains; no orphans', async () => {
    for (const [label, signal, which] of [['crash (SIGKILL jobs)', 'KILL', 'jobs'], ['zero exit (jobs drains and exits 0)', 'TERM', 'jobs'], ['crash (SIGKILL provisioner)', 'KILL', 'provisioner']]) {
      await waitFor('worker-a healthy', () => healthOf('worker-a') === 'healthy', 180_000, 3000);
      const before = restartsOf('worker-a');
      const p = bundlePids('worker-a');
      compose(['exec', '-T', '-u', '0:0', 'worker-a', 'kill', `-${signal}`, String(p[which])]);
      await waitFor(`restart after ${label}`, () => restartsOf('worker-a') > before, 120_000, 2000);
      const tail = logsOf('worker-a').split('\n').filter((l) => /worker-bundle\]|shut down cleanly/.test(l)).slice(-10).join('\n');
      write(`--- ${label}\n${tail}`);
      const other = which === 'jobs' ? 'provisioner' : 'jobs';
      assert(new RegExp(`${which} exited unexpectedly \\(${signal === 'KILL' ? 'SIGKILL' : '0'}\\)`).test(tail), `${label}: not treated as failure`);
      assert(other === 'jobs' ? /Worker shut down cleanly/.test(tail) : /\[workspace-provisioner\] shut down cleanly/.test(tail), `${label}: survivor did not drain cleanly`);
      assert(/exiting with code 1/.test(tail), `${label}: exit code`);
    }
    await waitFor('worker-a healthy', () => healthOf('worker-a') === 'healthy', 180_000, 3000);
    const t = procTable('worker-a');
    write(`process table after three restarts:\n${t.map((x) => `${x.pid} uid=${x.uid} ${x.cmd}`).join('\n')}`);
    assert(t.filter((x) => /rab-worker\/dist\/main\.js/.test(x.cmd)).length === 1 && t.filter((x) => /workspace-provisioner\.main\.js/.test(x.cmd)).length === 1, 'duplicate or orphaned children');
  });

  await step('24', 'Crash DURING provisioning, then recovery to READY after restart', async () => {
    await waitFor('worker-a healthy', () => healthOf('worker-a') === 'healthy', 180_000, 3000);
    const before = restartsOf('worker-a');
    // Hold a lock that only the provisioner's apply transaction needs — its late FKs (payroll-runs template) to
    // core.payroll_calendar_period; seeding does not touch that table (core.stored_file cannot be used: core."user" and
    // core.organisation reference it, so the seed itself would block) — so the provisioner is caught mid-provisioning.
    const releaseLock = () => psql(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(240)%' AND pid <> pg_backend_pid()`);
    let w;
    let afterCrash;
    try {
      compose(['exec', '-d', '-T', 'pg', 'psql', '-U', 'rab', '-d', 'rab', '-c', `BEGIN; LOCK TABLE core.payroll_calendar_period IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(240); COMMIT;`]);
      await sleep(1500);
      w = seedCreatingWorkspace('bt-crash');
      const waiting = await waitFor('provisioner blocked mid-provisioning', () => {
        const v = sql1(`SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 120) FROM pg_stat_activity WHERE usename = 'crewflow' AND wait_event_type = 'Lock'`);
        return v || null;
      }, 150_000);
      const mid = wsStatus(w.id);
      write(`provisioner waiting on lock in: ${waiting}\nworkspace mid-provisioning status: ${mid}`);
      const p = bundlePids('worker-a');
      compose(['exec', '-T', '-u', '0:0', 'worker-a', 'kill', '-KILL', String(p.provisioner)]);
      await sleep(2000);
    } finally {
      releaseLock();
    }
    afterCrash = wsStatus(w.id);
    const tables = schemaFacts(w.schema).split('|')[0];
    write(`after crash: status=${afterCrash} tables_in_schema=${tables} (the apply transaction rolled back)`);
    assert(!/READY/.test(afterCrash.split('|')[0]), 'workspace must not be READY after the crash');
    await waitFor('restart', () => restartsOf('worker-a') > before, 120_000);
    await waitFor('bt-crash READY after restart', () => wsStatus(w.id) === 'READY|READY', 120_000);
    const n = sql1(`SELECT (SELECT count(*) FROM core.workspace_schema_registry WHERE workspace_id = '${w.id}') || '|' || (SELECT count(*) FROM pg_namespace WHERE nspname = '${w.schema}')`);
    const facts = schemaFacts(w.schema);
    write(`after recovery: registry/schema rows ${n}; schema facts ${facts}`);
    assert(n === '1|1' && Number(facts.split('|')[0]) === fx.v1.tables, 'recovered workspace incomplete');
  });

  await step('25', 'Provisioning failure is recorded as FAILED and retried to READY once the cause is removed', async () => {
    const w = seedCreatingWorkspace('bt-fail', { blockSchema: true });
    await waitFor('FAILED', () => /FAILED/.test(wsStatus(w.id)), 60_000);
    const err = sql1(`SELECT coalesce(schema_last_error, '-') FROM core.manager_workspace WHERE id = '${w.id}'`);
    write(`status ${wsStatus(w.id)}; recorded error: ${err}`);
    psql(`DROP SCHEMA ${w.schema} CASCADE`);
    await waitFor('retried to READY', () => wsStatus(w.id) === 'READY|READY', 60_000);
    const facts = schemaFacts(w.schema);
    write(`after retry: ${wsStatus(w.id)} facts ${facts}`);
    assert(Number(facts.split('|')[0]) === fx.v1.tables && facts.endsWith(`|${fx.v1.owner}`), 'retried schema incomplete');
  });

  await step('26', 'Configuration refusals: missing secret, invalid URL, role mismatch, privileged variable (no value leaked)', async () => {
    const cases = [
      ['missing provisioner secret', { CREWFLOW_PROVISIONER_DATABASE_URL: '' }, /refused: Missing CREWFLOW_PROVISIONER_DATABASE_URL/],
      ['invalid provisioner URL', { CREWFLOW_PROVISIONER_DATABASE_URL: `not a url ${SECRETS.BT_CREWFLOW_PASSWORD}` }, /refused: Invalid CREWFLOW_PROVISIONER_DATABASE_URL/],
      ['provisioner configured with the runtime role', { CREWFLOW_PROVISIONER_DATABASE_URL: `postgres://crewflow_app:${SECRETS.BT_APP_PASSWORD}@pg:5432/rab` }, /refused: CREWFLOW_PROVISIONER_DATABASE_URL must log in as crewflow/],
      ['jobs configured with the privileged role', { DATABASE_URL: `postgres://crewflow:${SECRETS.BT_CREWFLOW_PASSWORD}@pg:5432/rab` }, /refused: DATABASE_URL and DATABASE_DIRECT_URL must log in as crewflow_app/],
      ['DATABASE_URL_UNPOOLED on the service', { DATABASE_URL_UNPOOLED: `postgres://crewflow:${SECRETS.BT_CREWFLOW_PASSWORD}@pg:5432/rab` }, /refused: DATABASE_URL_UNPOOLED must not be configured/],
      ['migration approval on the service', { CREWFLOW_MIGRATION_APPROVED: `pending-1-${'0'.repeat(64)}` }, /refused: CREWFLOW_MIGRATION_APPROVED must not be configured/],
      ['wrong provisioner password (live probe)', { CREWFLOW_PROVISIONER_DATABASE_URL: 'postgres://crewflow:wrong-password@pg:5432/rab' }, /\[provisioner\] \[runtime-db-guard\] refused: Cannot reach the DATABASE_URL database .*driver code 28P01/],
      // Phase A (pa-provisioner): the opt-in switch and the interval bounds.
      ['provisioner disabled but its URL still present', { CREWFLOW_PROVISIONER_ENABLED: 'false' }, /refused: CREWFLOW_PROVISIONER_DATABASE_URL is set but the workspace provisioner is disabled/],
      ['invalid provisioner switch', { CREWFLOW_PROVISIONER_ENABLED: 'yes' }, /refused: CREWFLOW_PROVISIONER_ENABLED must be "true" or "false"/],
      ['provisioner interval out of bounds', { WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '3600' }, /refused: WORKSPACE_PROVISIONER_INTERVAL_SECONDS must be a whole number of seconds from 5 to 120/],
    ];
    for (const [label, envOver, expected] of cases) {
      const args = ['run', '--rm', '--no-deps', '-e', 'CREWFLOW_BUNDLE_FAILURE_EXIT_DELAY_MS=0'];
      const env = {};
      for (const [k, v] of Object.entries(envOver)) {
        args.push('-e', k);
        env[k] = v;
      }
      const r = compose([...args, 'worker-a'], { env, timeout: 180_000 });
      RAW_SERVICE_OUTPUTS.push(r.raw);
      write(`--- ${label}: exit=${r.code}`);
      assert(r.code === 1 && expected.test(r.out), `${label}: not refused as expected`);
      for (const v of Object.values(envOver)) {
        const secretPart = String(v).match(/[0-9a-f]{48}/)?.[0];
        if (secretPart) assert(!r.raw.includes(secretPart), `${label}: value leaked`);
      }
    }
  });

  await step('26b', 'Provisioner disabled (Phase A): jobs child only, no crewflow connection, jobs-only health', async () => {
    assert(compose(['--profile', 'noprov', 'up', '-d', '--wait', '--wait-timeout', '180', 'worker-noprov']).code === 0, 'worker-noprov not healthy');
    try {
      const logs = logsOf('worker-noprov');
      write(logs.split('\n').filter((l) => /worker-bundle\]|runtime-db-guard|workspace-provisioner|rab-worker ready/.test(l)).join('\n'));
      assert(/\[worker-bundle\] starting jobs only — workspace provisioner disabled/.test(logs), 'launcher did not report jobs-only');
      assert(!/workspace-provisioner\]/.test(logs), 'a provisioner child logged');
      const t = procTable('worker-noprov');
      write(t.map((x) => `${x.pid} uid=${x.uid} ${x.cmd}`).join('\n'));
      assert(!t.some((x) => x.uid === 10001), 'a process runs as the provisioner identity');
      assert(t.filter((x) => x.uid === 1000 && /rab-worker\/dist\/main\.js/.test(x.cmd)).length === 1, 'jobs child missing');
      const ip = inspect('worker-noprov', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}');
      const act = sql1(`SELECT coalesce(string_agg(usename || '=' || n, ' ' ORDER BY usename), '-') FROM (SELECT usename, count(*) n FROM pg_stat_activity WHERE datname = 'rab' AND host(client_addr) = '${ip}' AND usename IS NOT NULL GROUP BY 1) s`);
      write(`worker-noprov connections: ${act}`);
      assert(!/(^|\s)crewflow=/.test(act), 'disabled bundle holds a crewflow connection');
      const hc = compose(['exec', '-T', 'worker-noprov', 'node', '/opt/crewflow-bundle/worker-bundle-health.cjs'], { quiet: true }).out;
      write(`health: ${hc.trim()}`);
      assert(/^jobs: healthy/m.test(hc) && !/provisioner:/.test(hc), 'health did not evaluate jobs only');
      return `connections ${act}`;
    } finally {
      compose(['--profile', 'noprov', 'rm', '-sf', 'worker-noprov']);
    }
  });

  await step('27', 'Live guards inside the bundle: different cluster, and a privileged role posing as crewflow_app', async () => {
    assert(compose(['--profile', 'mismatch', 'up', '-d', '--wait', 'pg-other']).code === 0, 'pg-other');
    compose(['exec', '-T', 'pg-other', 'psql', '-U', 'rab', '-d', 'rab', '-v', 'ON_ERROR_STOP=1'], { input: `CREATE ROLE crewflow LOGIN PASSWORD '${SECRETS.BT_CREWFLOW_PASSWORD}'; CREATE ROLE crewflow_app LOGIN SUPERUSER PASSWORD '${SECRETS.BT_APP_PASSWORD}';` });
    const r = compose(['--profile', 'mismatch', 'run', '--rm', '--no-deps', 'worker-mismatch'], { timeout: 180_000 });
    write(r.out.split('\n').filter((l) => /worker-bundle\]|runtime-db-guard/.test(l)).join('\n'));
    assert(r.code === 1 && /live identity probes disagree: .*cluster=\d+.*cluster=\d+/.test(r.out), 'cluster mismatch not refused');
    compose(['--profile', 'mismatch', 'rm', '-sf', 'pg-other']);
    // Live role guard: on the THROWAWAY database only, give crewflow_app BYPASSRLS for one start attempt. The launcher's
    // string checks pass (the login name is right); assert-runtime-db-role.ts inside the jobs child must refuse.
    psql('ALTER ROLE crewflow_app BYPASSRLS');
    let r2;
    try {
      const env = { DATABASE_URL: `postgres://crewflow_app:${SECRETS.BT_APP_PASSWORD}@pg:5432/rab`, DATABASE_DIRECT_URL: `postgres://crewflow_app:${SECRETS.BT_APP_PASSWORD}@pg:5432/rab`, CREWFLOW_PROVISIONER_DATABASE_URL: `postgres://crewflow:${SECRETS.BT_CREWFLOW_PASSWORD}@pg:5432/rab` };
      r2 = compose(['--profile', 'mismatch', 'run', '--rm', '--no-deps', '-e', 'DATABASE_URL', '-e', 'DATABASE_DIRECT_URL', '-e', 'CREWFLOW_PROVISIONER_DATABASE_URL', 'worker-mismatch'], { env, timeout: 180_000 });
    } finally {
      psql('ALTER ROLE crewflow_app NOBYPASSRLS');
    }
    write(r2.out.split('\n').filter((l) => /worker-bundle\]|Refusing|refused|Worker failed/.test(l)).slice(0, 12).join('\n'));
    write(`crewflow_app restored: ${sql1(`SELECT 'bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app'`)}`);
    assert(r2.code === 1 && /has BYPASSRLS\/SUPERUSER/.test(r2.out), 'BYPASSRLS crewflow_app not refused by the live role guard');
  });

  await step('28', 'Ownership alone protects shared code when the root filesystem is writable (platform without read_only)', async () => {
    compose(['stop', '-t', '60', 'worker-a']);
    assert(compose(['--profile', 'rw', 'up', '-d', '--wait', '--wait-timeout', '180', 'worker-rw']).code === 0, 'worker-rw not healthy');
    const r = await isolationProbe('worker-rw', /Permission denied/, null);
    compose(['--profile', 'rw', 'stop', '-t', '60', 'worker-rw']);
    compose(['up', '-d', 'worker-a']);
    return r;
  });

  await step('29', 'Redis outage: reported unhealthy, no restart storm, recovers; committed PostgreSQL state intact', async () => {
    await waitFor('worker-a healthy', () => healthOf('worker-a') === 'healthy', 180_000, 3000);
    const before = restartsOf('worker-a');
    const pgState = () => sql1(`SELECT concat_ws(' | ',
      'migrations=' || (SELECT count(*) FROM core.migrations),
      'workspaces=' || (SELECT string_agg(coalesce(schema_status,'NULL') || ':' || n, ',' ORDER BY 1) FROM (SELECT schema_status, count(*) n FROM core.manager_workspace GROUP BY 1) x),
      'registry=' || (SELECT string_agg(status || ':' || n, ',' ORDER BY 1) FROM (SELECT status, count(*) n FROM core.workspace_schema_registry GROUP BY 1) y),
      'ready_without_schema=' || (SELECT count(*) FROM core.workspace_schema_registry r WHERE r.status = 'READY' AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = r.schema_name)),
      'ws_registry_mismatch=' || (SELECT count(*) FROM core.manager_workspace mw JOIN core.workspace_schema_registry r ON r.workspace_id = mw.id WHERE mw.schema_status IS DISTINCT FROM r.status),
      'email_outbox=' || (SELECT coalesce(string_agg(status || ':' || n, ',' ORDER BY 1), '-') FROM (SELECT status, count(*) n FROM core.email_outbox GROUP BY 1) z),
      'shift_reports=' || (SELECT count(*) FROM core.shift_report),
      'users=' || (SELECT count(*) FROM core."user"))`);
    const stateBefore = pgState();
    compose(['stop', 'redis']);
    await waitFor('worker-a unhealthy (Redis)', () => healthOf('worker-a') === 'unhealthy', 240_000, 5000);
    const hc = compose(['exec', '-T', 'worker-a', 'node', '/opt/crewflow-bundle/worker-bundle-health.cjs']).out.trim();
    const during = restartsOf('worker-a');
    write(`during outage: ${hc}; restarts ${before} -> ${during}; running=${runningOf('worker-a')}`);
    compose(['start', 'redis']);
    await waitFor('worker-a healthy again', () => healthOf('worker-a') === 'healthy', 240_000, 5000);
    const after = restartsOf('worker-a');
    const stateAfter = pgState();
    write(`after recovery: healthy, restarts ${after}\nPostgreSQL state before outage: ${stateBefore}\nPostgreSQL state after recovery: ${stateAfter}`);
    assert(stateAfter === stateBefore, 'committed PostgreSQL state changed across the Redis outage');
    assert(/ready_without_schema=0 \| ws_registry_mismatch=0/.test(stateAfter), 'inconsistent lifecycle state');
    assert(/Redis/.test(hc), 'health did not name Redis');
    assert(during === before && after === before, 'the service restarted during a Redis outage');
  });

  await step('30', 'Database outage: behaviour and recovery', async () => {
    await waitFor('worker-a healthy', () => healthOf('worker-a') === 'healthy', 180_000, 3000);
    const before = restartsOf('worker-a');
    const since = new Date().toISOString();
    compose(['stop', 'pg']);
    const t0 = Date.now();
    await sleep(75_000);
    const during = { restarts: restartsOf('worker-a'), running: runningOf('worker-a'), health: healthOf('worker-a') };
    const hc = compose(['exec', '-T', 'worker-a', 'node', '/opt/crewflow-bundle/worker-bundle-health.cjs']).out.trim();
    write(`after ${Math.round((Date.now() - t0) / 1000)}s without PostgreSQL: ${JSON.stringify(during)}; health: ${hc}`);
    compose(['start', 'pg']);
    await waitFor('worker-a healthy after DB returns', () => healthOf('worker-a') === 'healthy', 300_000, 5000);
    const after = restartsOf('worker-a');
    write(`recovered: healthy; restarts ${before} -> ${after}`);
    const outageLogs = compose(['logs', '--no-color', '--since', since, 'worker-a'], { quiet: true }).out;
    write(outageLogs.split('\n').filter((l) => /worker-bundle\]|refused|terminat|ECONNREFUSED|ENOTFOUND|fatal|Error|failed/i.test(l)).slice(0, 40).join('\n'));
    return `restarts during outage: ${after - before} (see log for which process exited)`;
  });

  await step('31', 'Graceful stop: SIGTERM forwarded, both drains complete, exit 0 within the grace period; no orphans', async () => {
    await waitFor('worker-a healthy', () => healthOf('worker-a') === 'healthy', 180_000, 3000);
    // Judge the whole log of THIS stop, not a fixed-size tail: case 31 runs about a second after case 30 restarts
    // PostgreSQL, so an in-flight jobs cycle can print a multi-line connection error while draining and push the drain
    // lines out of any short tail. The window starts 10 s early (host/daemon clock skew); worker-a was last stopped in
    // case 28, minutes earlier, and exactly one stop must fall inside the window.
    const since = new Date(Date.now() - 10_000).toISOString();
    const t0 = Date.now();
    compose(['stop', '-t', '55', 'worker-a']);
    const elapsed = Date.now() - t0;
    const exit = inspect('worker-a', '{{.State.ExitCode}}');
    const stopLog = compose(['logs', '--no-color', '--since', since, 'worker-a'], { quiet: true }).out;
    const drainLines = stopLog.split('\n').filter((l) => /\[worker-bundle\]|received SIGTERM|shut down cleanly/.test(l));
    write(`stop took ${elapsed}ms, exit code ${exit}\n${drainLines.join('\n')}`);
    assert(exit === '0', 'non-zero exit on graceful stop');
    assert((stopLog.match(/\[worker-bundle\] stopping: received SIGTERM/g) || []).length === 1, 'expected exactly one bundle stop in the window');
    const required = [
      /\[jobs\] Worker received SIGTERM/,
      /\[jobs\] Worker shut down cleanly/,
      /\[workspace-provisioner\] shut down cleanly/,
      /\[worker-bundle\] jobs: exited \(0\)/,
      /\[worker-bundle\] provisioner: exited \(0\)/,
      /\[worker-bundle\] exiting with code 0/,
    ];
    assert(required.every((re) => re.test(stopLog)), 'drain lines missing');
    // The launcher's own lines share one stream, so their order is reliable: SIGTERM first, the bundle exit last.
    const at = (re) => drainLines.findIndex((l) => re.test(l));
    const sigterm = at(/\[worker-bundle\] stopping: received SIGTERM/);
    const bundleExit = at(/\[worker-bundle\] exiting with code 0/);
    assert(sigterm < at(/\[worker-bundle\] jobs: exited \(0\)/) && sigterm < at(/\[worker-bundle\] provisioner: exited \(0\)/), 'a child exited before SIGTERM was forwarded');
    assert(bundleExit > at(/\[worker-bundle\] jobs: exited \(0\)/) && bundleExit > at(/\[worker-bundle\] provisioner: exited \(0\)/), 'the bundle exited before both children');
    assert(elapsed < 55_000, 'stop exceeded the grace period');
    compose(['start', 'worker-a']);
    await waitFor('worker-a healthy after restart', () => healthOf('worker-a') === 'healthy', 180_000, 3000);
    const t = procTable('worker-a');
    write(`after restart:\n${t.map((x) => `${x.pid} uid=${x.uid} ${x.cmd}`).join('\n')}`);
    assert(t.filter((x) => x.uid === 1000 || x.uid === 10001).length === 2, 'unexpected child-identity processes after restart');
    const zombies = compose(['exec', '-T', '-u', '0:0', 'worker-a', 'sh', '-c', "for p in /proc/[0-9]*; do awk '{print $3}' $p/stat 2>/dev/null; done | grep -c Z || true"], { quiet: true }).out.trim();
    write(`zombie (state Z) processes in the container: ${zombies}; PID 1: ${t.find((x) => x.pid === 1)?.cmd}`);
    assert(zombies === '0', 'zombie processes present');
  });

  await step('32', 'No secret appears in any captured log or start-attempt output', async () => {
    const services = ['api', 'worker-a', 'worker-b', 'worker-rw', 'pg', 'redis', 'smtp'];
    const logs = services.map((svc) => compose(['--profile', '*', 'logs', '--no-color', svc], { quiet: true }).raw).join('\n');
    const corpus = `${logs}\n${RAW_SERVICE_OUTPUTS.join('\n')}`;
    const evidence = fs.readdirSync(OUT).filter((f) => f.endsWith('.log') || f.endsWith('.md')).map((f) => fs.readFileSync(path.join(OUT, f), 'utf8')).join('\n');
    const hits = Object.entries(SECRETS).map(([name, value]) => `${name}: service logs=${corpus.split(value).length - 1} evidence files=${evidence.split(value).length - 1}`);
    write(`scanned ${corpus.length} bytes of raw service logs/start-attempt output and ${evidence.length} bytes of evidence for ${Object.keys(SECRETS).length} synthetic secrets\n${hits.join('\n')}`);
    assert(hits.every((h) => /service logs=0 evidence files=0$/.test(h)), 'a synthetic secret was printed');
    return 'BT_* passwords/APP_SECRET: 0 occurrences (seed-qa CLI fixture output excluded: it is not a service)';
  });

  await step('33', 'Native PostgreSQL/Redis health checks in the compose files', async () => {
    const lines = [];
    for (const [label, file, extraEnv] of [['dev', path.join(__dirname, '../../../../docker-compose.yml'), { DEVDB_SUPERUSER_PASSWORD: 'x' }], ['production', path.join(__dirname, '../../../../docker-compose.production.yml'), {}], ['bundle-test', FILE, {}]]) {
      const r = docker(['compose', '-p', 'crewflow-config-check', '-f', file, '--profile', '*', 'config', '--format', 'json'], { quiet: true, env: extraEnv });
      const cfg = JSON.parse(r.raw.slice(r.raw.indexOf('{')));
      for (const [name, svc] of Object.entries(cfg.services)) {
        const img = String(svc.image || '');
        if (/postgres|redis/.test(img)) lines.push(`${label}: ${name} (${img}) healthcheck=${JSON.stringify(svc.healthcheck?.test ?? null)}`);
      }
    }
    write(lines.join('\n'));
    assert(lines.every((l) => /pg_isready|redis-cli","ping/.test(l)), 'a PostgreSQL/Redis service has no native health check');
    assert(lines.some((l) => /^dev: devdb .*pg_isready/.test(l)) && lines.some((l) => /^production: rab-redis .*redis-cli/.test(l)), 'expected health checks missing');
    return 'production has no PostgreSQL service (managed/external); every compose PostgreSQL/Redis service has pg_isready / redis-cli ping';
  });

  // ---------------------------------------------------------------------------------------------- summary
  currentLog = path.join(OUT, 'SUMMARY.md');
  fs.writeFileSync(currentLog, `# Worker bundle integration summary (${new Date().toISOString()})\n\n| # | Case | Result | Note | Evidence |\n|---|---|---|---|---|\n`);
  for (const r of results) fs.appendFileSync(currentLog, `| ${r.id} | ${r.title} | ${r.status} | ${redact(r.note).replace(/\|/g, '/')} | ${r.log} |\n`);
  if (!KEEP) {
    currentLog = path.join(OUT, '99-teardown.log');
    compose(['--profile', '*', 'down', '-v', '--remove-orphans']);
  }
  const failed = results.filter((r) => r.status !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} PASS — evidence in ${OUT}`);
  process.exit(failed ? 1 : 0);
})();

// ------------------------------------------------------------------------------------------------ isolation probe

async function isolationProbe(service, writeDenial, mustSee) {
  const p = bundlePids(service);
  assert(p.launcher && p.jobs && p.provisioner, 'missing processes');
  const half = Math.floor(SECRETS.BT_CREWFLOW_PASSWORD.length / 2);
  const env = { NA: SECRETS.BT_CREWFLOW_PASSWORD.slice(0, half), NB: SECRETS.BT_CREWFLOW_PASSWORD.slice(half) };
  const script = `
P=${p.provisioner}; L=${p.launcher}; J=${p.jobs}
N="$NA$NB"; unset NA NB
t(){ d="$1"; shift; if o=$("$@" 2>&1); then echo "ALLOWED | $d | $(printf %s "$o" | head -c 160 | tr '\\n\\0' '  ')"; else echo "DENIED  | $d | $(printf %s "$o" | head -c 160 | tr '\\n\\0' '  ')"; fi; }
echo "identity: $(id)"
if [ "$(id -u)" = 1000 ]; then
  t "read provisioner environ" cat /proc/$P/environ
  t "read provisioner memory" dd if=/proc/$P/mem of=/dev/null bs=1 count=1 skip=4194304
  t "list provisioner open fds" ls /proc/$P/fd
  t "list provisioner temp dir" ls -la /tmp/crewflow-provisioner
  t "signal provisioner (TERM)" kill -TERM $P
  t "signal provisioner (probe 0)" kill -0 $P
  t "forge provisioner heartbeat" sh -c "echo {} > /run/crewflow-health/provisioner/heartbeat.json"
else
  t "read jobs environ" cat /proc/$J/environ
  t "list jobs temp dir" ls -la /tmp/crewflow-jobs
  t "signal jobs (probe 0)" kill -0 $J
  t "forge jobs heartbeat" sh -c "echo {} > /run/crewflow-health/jobs/heartbeat.json"
fi
t "read launcher environ" cat /proc/$L/environ
t "read PID 1 (tini) environ" cat /proc/1/environ
t "signal launcher (STOP)" kill -STOP $L
t "rewrite provisioner entrypoint" sh -c "echo x >> /app/packages/rab-worker/dist/workspace-provisioner.main.js"
t "rewrite provisioning module" sh -c "echo x >> /app/packages/rab-server/dist/database/typeorm/workspace-schema/provision-workspace-schema.js"
t "rewrite pg driver" sh -c "echo x >> /app/node_modules/pg/lib/client.js"
t "add a module to worker dist" touch /app/packages/rab-worker/dist/evil.js
t "create dangling workspace-link target" mkdir /app/packages/rab-utils
t "rewrite the launcher" sh -c "echo x >> /opt/crewflow-bundle/start-worker-bundle.cjs"
t "plant /app/.env (dotenv)" sh -c "echo X=1 > /app/.env"
t "plant provisioner dotenv" sh -c "echo X=1 > /app/packages/rab-worker/.env.provisioner"
echo "dotenv files anywhere (outside node_modules): $(find / \\( -path /proc -o -path /sys -o -path /dev -o -path /app/node_modules \\) -prune -o -name '.env*' -print 2>/dev/null | wc -l)"
echo "/run/secrets present: $([ -e /run/secrets ] && echo yes || echo no)"
echo "readable files containing the provisioner password: $( { find / \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -type f -print0 2>/dev/null; find /dev/shm -type f -print0 2>/dev/null; } | xargs -0 grep -lsF -e "$N" 2>/dev/null | wc -l)"
echo "readable /proc/*/environ containing it: $(for f in /proc/[0-9]*/environ; do grep -lsF -e "$N" "$f"; done 2>/dev/null | wc -l)"
`;
  const lines = [];
  for (const user of ['1000:1000', '10001:10001']) {
    const r = execAs(service, user, script, env);
    lines.push(`=== as ${user}\n${r.out}`);
    const denied = (label) => new RegExp(`^DENIED  \\| ${label.replace(/[()]/g, '\\$&')} \\|`, 'm').test(r.out);
    const writeLabels = ['rewrite provisioner entrypoint', 'rewrite provisioning module', 'rewrite pg driver', 'add a module to worker dist', 'create dangling workspace-link target', 'rewrite the launcher', 'plant /app/.env (dotenv)', 'plant provisioner dotenv'];
    for (const l of writeLabels) {
      assert(denied(l), `${user}: ${l} was not denied`);
      assert(new RegExp(`^DENIED  \\| ${l.replace(/[()/.]/g, '\\$&')} \\| .*(${writeDenial.source})`, 'm').test(r.out), `${user}: ${l} not denied by ${writeDenial}`);
    }
    if (mustSee) assert(mustSee.test(r.out), `${user}: no write was refused by ${mustSee} (read-only root not in effect?)`);
    assert(/dotenv files anywhere \(outside node_modules\): 0/.test(r.out), 'dotenv file found');
    assert(/readable files containing the provisioner password: 0/.test(r.out), 'password found in a readable file');
    if (user === '1000:1000') {
      for (const l of ['read provisioner environ', 'read launcher environ', 'read PID 1 (tini) environ', 'read provisioner memory', 'list provisioner open fds', 'list provisioner temp dir', 'signal provisioner (TERM)', 'signal provisioner (probe 0)', 'signal launcher (STOP)', 'forge provisioner heartbeat']) {
        assert(denied(l), `jobs identity: ${l} was not denied`);
      }
      assert(/readable \/proc\/\*\/environ containing it: 0/.test(r.out), 'jobs identity can read an environ holding the password');
    } else {
      for (const l of ['read jobs environ', 'list jobs temp dir', 'signal jobs (probe 0)', 'forge jobs heartbeat', 'read launcher environ', 'read PID 1 (tini) environ', 'signal launcher (STOP)']) {
        assert(denied(l), `provisioner identity: ${l} was not denied`);
      }
    }
  }
  write(lines.join('\n'));
  return `${writeDenial.source} for every code/dotenv write; secrets unreadable`;
}
