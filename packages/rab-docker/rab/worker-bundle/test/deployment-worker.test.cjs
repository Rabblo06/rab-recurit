'use strict';
/**
 * O1 (one image): every COMMITTED deployment definition that runs the Worker runs it the same way, as the production
 * rab-worker service does: the ONE Crewflow image (rab/Dockerfile) with the Worker command
 * `node packages/rab-worker/dist/main.js`, ONE process as 1000:1000 under compose's init, no capability, a read-only root
 * with the two jobs tmpfs mounts, the jobs-only health check, the environment the retired launcher used to give its jobs
 * child (HOME=/nonexistent, TMPDIR and XDG caches on the jobs tmpfs, the per-instance heartbeat file), and NO
 * CREWFLOW_PROVISIONER_* variable (the Worker provisions in-process and refuses that prefix). The retired root launcher
 * (start-worker-bundle.cjs) and the separate Worker Dockerfile must not come back in any of them.
 *
 * Also the H6 runtime-isolation keys of the production services. No database, Redis, network or Docker: the compose files
 * are parsed (YAML merge keys resolved, `${VAR:?}`/`${VAR:-x}` interpolated with dummy values). Repo checkout only (reads
 * the compose files and the `yaml` package from the monorepo's node_modules); skipped elsewhere.
 *
 *   node --test packages/rab-docker/rab/worker-bundle/test/deployment-worker.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../../../../..');
let YAML = null;
try {
  YAML = require(require.resolve('yaml', { paths: [REPO] }));
} catch {
  YAML = null;
}
const inRepo = YAML !== null && fs.existsSync(path.join(REPO, 'packages/rab-docker/docker-compose.production.yml'));
const skip = !inRepo && 'repo checkout with node_modules/yaml required';

/**
 * Compose-style interpolation with dummy values: ${X:?msg} / ${X:-default} / ${X}. `vars` wins; else the default; else a
 * dummy. Nested defaults (`${A:-${B:-}}`) resolve innermost-first, as Compose does.
 */
function interpolate(value, vars) {
  if (typeof value !== 'string') return value === null || value === undefined ? value : String(value);
  let out = value;
  for (let pass = 0; pass < 8; pass++) {
    const next = out.replace(/\$\{([A-Z0-9_]+)(?:(:?[-?])([^${}]*))?\}/g, (_m, name, op, arg) => {
      if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
      if (op === ':-' || op === '-') return arg;
      return 'dummy-pw';
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

function loadCompose(rel) {
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
  return YAML.parse(text, { merge: true });
}

/** The committed `environment:` of one service, as the container would see it (env_file NOT included). */
function serviceEnv(rel, service, vars = {}) {
  const doc = loadCompose(rel);
  const svc = doc.services?.[service];
  assert.ok(svc, `${rel}: service ${service} exists`);
  const raw = svc.environment ?? {};
  const out = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const [k, ...rest] = String(item).split('=');
      out[k] = interpolate(rest.join('='), vars);
    }
  } else {
    for (const [k, v] of Object.entries(raw)) if (k !== '<<') out[k] = interpolate(v, vars);
  }
  return { env: out, svc };
}

const WORKER_COMMAND = ['node', 'packages/rab-worker/dist/main.js'];
const JOBS_HEALTH = ['CMD', 'env', 'CREWFLOW_PROVISIONER_ENABLED=false', 'node', '/opt/crewflow-bundle/worker-bundle-health.cjs'];
const JOBS_ENV = {
  HOME: '/nonexistent',
  TMPDIR: '/tmp/crewflow-jobs',
  XDG_CONFIG_HOME: '/tmp/crewflow-jobs/.config',
  XDG_CACHE_HOME: '/tmp/crewflow-jobs/.cache',
  CREWFLOW_INSTANCE_HEALTH_FILE: '/run/crewflow-health/jobs/heartbeat.json',
};
const RETIRED = ['start-worker-bundle.cjs', 'Dockerfile.worker-bundle', 'crewflow-worker-bundle', 'CREWFLOW_BASE_IMAGE'];

/** Every compose file in the repository that defines a Worker service, with the Worker services it defines. */
const WORKER_DEFINITIONS = {
  'packages/rab-docker/docker-compose.production.yml': ['rab-worker'],
  'packages/rab-docker/docker-compose.image.yml': ['rab-worker'],
  'packages/rab-docker/docker-compose.qa.yml': ['worker'],
  'packages/rab-docker/docker-compose.yml': ['worker'],
  'packages/rab-e2e-testing/system/docker-compose.e2e.yml': ['worker'],
  'packages/rab-e2e-testing/cost/docker-compose.cost.yml': ['worker', 'worker2'],
  'packages/rab-docker/rab/worker-bundle/test/integration/docker-compose.bullmq-test.yml': ['bundle-a', 'bundle-b'],
};

/** A service runs the Worker when its command, build, image or health check names the Worker entrypoint or its health. */
function workerServices(rel) {
  const doc = loadCompose(rel);
  const marks = ['rab-worker/dist/main.js', 'worker-bundle-health.cjs', ...RETIRED];
  return Object.entries(doc.services ?? {})
    .filter(([, s]) => {
      const text = JSON.stringify({ command: s.command, build: s.build, image: s.image, healthcheck: s.healthcheck });
      return marks.some((m) => text.includes(m));
    })
    .map(([name]) => name)
    .sort();
}

test('O1: the retired launcher and the separate Worker Dockerfile are gone from the image sources', () => {
  for (const rel of [
    'packages/rab-docker/rab/worker-bundle/start-worker-bundle.cjs',
    'packages/rab-docker/rab/Dockerfile.worker-bundle',
    'packages/rab-docker/rab/start-worker.sh',
  ]) {
    assert.equal(fs.existsSync(path.join(REPO, rel)), false, `${rel} must not exist (O1: one image, no launcher)`);
  }
  // The health script stays at the same path: every committed health check runs it.
  assert.ok(fs.existsSync(path.join(REPO, 'packages/rab-docker/rab/worker-bundle/worker-bundle-health.cjs')));
});

test('inventory: every compose service that runs the Worker is classified (no unreviewed deployment definition)', { skip }, () => {
  for (const [rel, expected] of Object.entries(WORKER_DEFINITIONS)) {
    assert.deepEqual(workerServices(rel), [...expected].sort(), rel);
  }
});

for (const [rel, services] of Object.entries(WORKER_DEFINITIONS)) {
  for (const service of services) {
    test(`committed ${path.basename(rel)} ${service}: the one image, the Worker command, one non-root process, jobs-only health`, { skip }, () => {
      const { env, svc } = serviceEnv(rel, service);
      const text = JSON.stringify(svc);
      for (const retired of RETIRED) assert.ok(!text.includes(retired), `${service}: still references ${retired}`);
      assert.deepEqual(svc.command, WORKER_COMMAND);
      assert.equal(svc.init, true, 'the watchdog SIGKILL is ignored for PID 1: compose init must be PID 1');
      assert.equal(String(svc.user), '1000:1000');
      assert.equal(svc.read_only, true);
      assert.deepEqual(svc.cap_drop, ['ALL']);
      assert.deepEqual(svc.cap_add ?? [], [], 'no capability: there is no identity switch any more');
      assert.ok((svc.security_opt ?? []).includes('no-new-privileges:true'));
      const tmpfs = Object.fromEntries((svc.tmpfs ?? []).map((t) => { const [p, o = ''] = String(t).split(/:(.*)/s); return [p, o]; }));
      assert.deepEqual(Object.keys(tmpfs).sort(), ['/run/crewflow-health/jobs', '/tmp/crewflow-jobs']);
      assert.deepEqual(svc.healthcheck?.test, JOBS_HEALTH);
      if (svc.build !== undefined) {
        assert.equal(svc.build.dockerfile, 'packages/rab-docker/rab/Dockerfile', `${service}: builds the one image`);
        assert.equal(svc.build.args, undefined, `${service}: no build args (no CREWFLOW_BASE_IMAGE)`);
        assert.equal(svc.build.additional_contexts, undefined, `${service}: not built FROM another service's image`);
      }
      for (const [k, v] of Object.entries(JOBS_ENV)) assert.equal(env[k], v, `${service}: ${k}`);
      // The Worker refuses any non-empty CREWFLOW_PROVISIONER_* (never-in-runtime-env.ts prefix rule): blank = absent.
      const provisioner = Object.keys(env).filter((k) => k.startsWith('CREWFLOW_PROVISIONER_') && String(env[k] ?? '').trim() !== '');
      assert.deepEqual(provisioner, [], `${service}: carries ${provisioner.join(', ')}`);
      assert.ok(durationMs(svc.stop_grace_period) >= 45_000, `stop_grace_period ${svc.stop_grace_period}`);
    });
  }
}

test('production and image compose: the Worker provisions in-process at the pinned 5 s', { skip }, () => {
  for (const rel of ['packages/rab-docker/docker-compose.production.yml', 'packages/rab-docker/docker-compose.image.yml']) {
    assert.equal(serviceEnv(rel, 'rab-worker').env.WORKSPACE_PROVISIONER_INTERVAL_SECONDS, '5', rel);
  }
});

// ---------------------------------------------------------------- H6: runtime isolation keys of the production services

/** Compose durations used here ("35s", "1m30s") in milliseconds; anything else is a test failure, not a guess. */
function durationMs(value) {
  const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(value ?? ''));
  assert.ok(m && (m[1] || m[2]), `unparsable duration ${value}`);
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 1000;
}

/** Memory sizes ("768m", "1536m", "2g") in MiB. */
function sizeMiB(value) {
  const m = /^(\d+)([mg])$/i.exec(String(value ?? ''));
  assert.ok(m, `unparsable size ${value}`);
  return Number(m[1]) * (m[2].toLowerCase() === 'g' ? 1024 : 1);
}

/** No privileged mode, host namespace, device, host mount (Docker socket included) or extra capability source. */
function assertNoHostAccess(name, svc) {
  assert.notEqual(svc.privileged, true, `${name}: privileged`);
  for (const key of ['network_mode', 'pid', 'ipc', 'uts', 'userns_mode', 'cgroup']) {
    assert.ok(!/^host$/i.test(String(svc[key] ?? '')), `${name}: ${key}=host`);
  }
  assert.equal(svc.devices, undefined, `${name}: devices`);
  assert.equal(svc.volumes, undefined, `${name}: volumes (no host mount, no Docker socket)`);
  assert.equal(svc.volumes_from, undefined, `${name}: volumes_from`);
  for (const opt of svc.security_opt ?? []) {
    assert.ok(!/unconfined|label[:=]disable/i.test(opt), `${name}: security_opt ${opt}`);
  }
}

test(
  'H6 rab-api: non-root, read-only root with NO tmpfs, no capabilities, no-new-privileges, bounded PIDs/memory/CPU, stop grace',
  { skip },
  () => {
    const svc = loadCompose('packages/rab-docker/docker-compose.production.yml').services['rab-api'];
    assert.equal(svc.user, '1000:1000');
    assert.equal(svc.read_only, true);
    assert.deepEqual(svc.cap_drop, ['ALL']);
    assert.equal(svc.cap_add, undefined, 'the API needs no capability (port 3000 is unprivileged)');
    assert.ok((svc.security_opt ?? []).includes('no-new-privileges:true'));
    assert.equal(svc.tmpfs, undefined, 'the API writes nothing to its filesystem (H6 runtime matrix); a tmpfs needs evidence');
    assert.ok(Number.isInteger(svc.pids_limit) && svc.pids_limit > 0 && svc.pids_limit <= 1024, `pids_limit ${svc.pids_limit}`);
    const mem = sizeMiB(interpolate(svc.mem_limit, {}));
    assert.ok(mem >= 512 && mem <= 4096, `mem_limit ${mem} MiB`);
    assert.ok(Number(interpolate(svc.cpus, {})) > 0, `cpus ${svc.cpus}`);
    assert.ok(durationMs(svc.stop_grace_period) >= 15_000, 'stop grace shorter than the measured Nest drain + margin');
    assertNoHostAccess('rab-api', svc);
  },
);

test(
  'H6 rab-worker (owner login): ONE process as 1000:1000, no capability, no-new-privileges, read-only root, jobs tmpfs, bounded PIDs/memory/CPU',
  { skip },
  () => {
    const svc = loadCompose('packages/rab-docker/docker-compose.production.yml').services['rab-worker'];
    // Owner login (2026-11-04): the root launcher and its per-child identities are retired; the Worker runs main.js directly
    // as the image's non-root `node` user, so it needs no capability at all.
    assert.equal(svc.user, '1000:1000');
    assert.deepEqual(svc.command, ['node', 'packages/rab-worker/dist/main.js']);
    // The watchdog's SIGKILL is ignored for PID 1: Docker's init must be PID 1.
    assert.equal(svc.init, true);
    assert.equal(svc.read_only, true);
    assert.deepEqual(svc.cap_drop, ['ALL']);
    assert.deepEqual(svc.cap_add ?? [], [], 'no capability: there is no identity switch any more');
    assert.ok((svc.security_opt ?? []).includes('no-new-privileges:true'));
    const tmpfs = Object.fromEntries((svc.tmpfs ?? []).map((t) => { const [p, o = ''] = String(t).split(/:(.*)/s); return [p, o]; }));
    assert.deepEqual(Object.keys(tmpfs).sort(), ['/run/crewflow-health/jobs', '/tmp/crewflow-jobs']);
    for (const [p, uid, mode] of [
      ['/tmp/crewflow-jobs', 1000, '0700'],
      ['/run/crewflow-health/jobs', 1000, '0755'],
    ]) {
      const o = tmpfs[p].split(',');
      assert.ok(o.includes(`uid=${uid}`) && o.includes(`gid=${uid}`) && o.includes(`mode=${mode}`), `${p}: ${tmpfs[p]}`);
      assert.ok(!o.includes('exec'), `${p} must stay noexec (Docker's tmpfs default)`);
    }
    assert.ok(Number.isInteger(svc.pids_limit) && svc.pids_limit >= 768 && svc.pids_limit <= 4096, `pids_limit ${svc.pids_limit} (sized for 4 concurrent Chromium renders = 551 tasks; kept until re-measured for the native renderer)`);
    const mem = sizeMiB(interpolate(svc.mem_limit, {}));
    assert.ok(mem >= 1024 && mem <= 8192, `mem_limit ${mem} MiB`);
    assert.ok(Number(interpolate(svc.cpus, {})) > 0, `cpus ${svc.cpus}`);
    // The stop timeout must exceed the 30 s jobs drain with margin (>= 45 s).
    assert.ok(durationMs(svc.stop_grace_period) >= 45_000, `stop_grace_period ${svc.stop_grace_period}`);
    assertNoHostAccess('rab-worker', svc);
  },
);

test('H6 production file: nothing but rab-api publishes a port, and no PostgreSQL service is defined in it', { skip }, () => {
  const services = loadCompose('packages/rab-docker/docker-compose.production.yml').services;
  for (const [name, svc] of Object.entries(services)) {
    if (name !== 'rab-api') assert.equal(svc.ports, undefined, `${name} publishes a port`);
    assert.ok(!/postgres/i.test(String(svc.image ?? '')), `${name} runs PostgreSQL inside this stack`);
  }
});

test('H6 CREWFLOW_RUNTIME_ISOLATION in the production file: unset (= warn) or a strict value on rab-api / rab-worker', { skip }, () => {
  for (const service of ['rab-api', 'rab-worker']) {
    const { env } = serviceEnv('packages/rab-docker/docker-compose.production.yml', service);
    const v = env.CREWFLOW_RUNTIME_ISOLATION;
    assert.ok(v === undefined || v === 'warn' || v === 'enforce', `${service}: CREWFLOW_RUNTIME_ISOLATION=${v}`);
  }
});
