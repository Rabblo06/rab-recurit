'use strict';
/**
 * Phase A verification (pa-prov2): does every COMMITTED deployment definition that runs the Worker bundle still end up with
 * the workspace provisioner ON at a 5 s interval, and what happens to a deployment whose environment was configured
 * OUTSIDE the committed compose (an operator-set environment without the new CREWFLOW_PROVISIONER_ENABLED switch)?
 *
 * Feeds each committed compose service's real `environment:` block (YAML merge keys resolved, `${VAR:?}`/`${VAR:-x}`
 * interpolated with dummy values) plus the variables its header says the operator enters (dummy URLs) into the REAL
 * launcher planner (start-worker-bundle.cjs makePlan) and its real main(). No database, Redis, network or Docker: every URL
 * is a dummy and no child is spawned. Repo checkout only (reads the compose files and the `yaml` package from the
 * monorepo's node_modules); skipped inside the bundle image.
 *
 *   node --test packages/rab-docker/rab/worker-bundle/test/deployment-provisioner.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const launcher = require('../start-worker-bundle.cjs');

const REPO = path.resolve(__dirname, '../../../../..');
let YAML = null;
try {
  YAML = require(require.resolve('yaml', { paths: [REPO] }));
} catch {
  YAML = null;
}
const inRepo =
  YAML !== null &&
  fs.existsSync(
    path.join(REPO, 'packages/rab-docker/docker-compose.production.yml'),
  );
const skip = !inRepo && 'repo checkout with node_modules/yaml required';

const DUMMY = {
  APP: 'postgres://crewflow_app:dummy-app-pw@db.example:5432/rab',
  PROV: 'postgres://crewflow:dummy-prov-pw@db.example:5432/rab',
};

/** Compose-style interpolation with dummy values: ${X:?msg} / ${X:-default} / ${X}. `vars` wins; else the default; else a dummy. */
function interpolate(value, vars) {
  if (typeof value !== 'string')
    return value === null || value === undefined ? value : String(value);
  return value.replace(
    /\$\{([A-Z0-9_]+)(?:(:?[-?])([^}]*))?\}/g,
    (_m, name, op, arg) => {
      if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
      if (op === ':-' || op === '-') return arg;
      return 'dummy-pw';
    },
  );
}

function loadCompose(rel) {
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
  return YAML.parse(text, { merge: true });
}

/** The committed `environment:` of one service, as the container would see it (env_file NOT included — reported separately). */
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
    for (const [k, v] of Object.entries(raw))
      if (k !== '<<') out[k] = interpolate(v, vars);
  }
  return { env: out, svc };
}

/** Every service in a compose file that runs the bundle launcher (explicit command, bundle Dockerfile/image, or its health check). */
function bundleServices(rel) {
  const doc = loadCompose(rel);
  const marks = [
    'start-worker-bundle.cjs',
    'Dockerfile.worker-bundle',
    'worker-bundle-health.cjs',
    'crewflow-worker-bundle',
  ];
  return Object.entries(doc.services ?? {})
    .filter(([, s]) => {
      const text = JSON.stringify({
        command: s.command,
        build: s.build,
        image: s.image,
        healthcheck: s.healthcheck,
      });
      return marks.some((m) => text.includes(m));
    })
    .map(([name]) => name);
}

function provisionerOf(plan) {
  return plan.find((s) => s.name === 'provisioner') ?? null;
}

/** What the committed configuration resolves to: ON/OFF, interval, or the refusal. */
function resolve(env) {
  try {
    const plan = launcher.makePlan(env);
    const p = provisionerOf(plan);
    return {
      refused: null,
      children: plan.map((s) => s.name),
      interval: p ? Number(p.env.WORKSPACE_PROVISIONER_INTERVAL_SECONDS) : null,
      provEnv: p?.env ?? null,
    };
  } catch (error) {
    return {
      refused: error.message,
      children: [],
      interval: null,
      provEnv: null,
    };
  }
}

// Production: the header says DATABASE_URL, DATABASE_DIRECT_URL, CREWFLOW_PROVISIONER_DATABASE_URL, TRUSTED_PROXY_CIDRS, APP
// secrets etc. are entered in OpenShip's UI. Only the keys the launcher itself checks matter here.
const OPENSHIP_ENTERED = {
  DATABASE_URL: DUMMY.APP,
  DATABASE_DIRECT_URL: DUMMY.APP,
  CREWFLOW_PROVISIONER_DATABASE_URL: DUMMY.PROV,
  TRUSTED_PROXY_CIDRS: '10.0.0.0/16',
};

const COMMITTED = [
  // [file, service, interpolation vars, operator-entered additions, expected]
  [
    'packages/rab-docker/docker-compose.production.yml',
    'rab-worker',
    {},
    OPENSHIP_ENTERED,
    { on: true, interval: 5 },
  ],
  [
    'packages/rab-docker/docker-compose.qa.yml',
    'worker',
    {},
    {},
    { on: true, interval: 5 },
  ],
  [
    'packages/rab-e2e-testing/system/docker-compose.e2e.yml',
    'worker',
    {},
    {},
    { on: true, interval: 5 },
  ],
  // Dev stack: DATABASE_URL comes from the shell's DEVDB_URL; the interval is NOT pinned (code default 60 s) unless the
  // env_file (../rab-server/.env, not committed) sets it.
  [
    'packages/rab-docker/docker-compose.yml',
    'worker',
    { DEVDB_URL: DUMMY.APP },
    {},
    { on: true, interval: 60 },
  ],
  [
    'packages/rab-docker/rab/worker-bundle/test/integration/docker-compose.bullmq-test.yml',
    'bundle-a',
    {},
    {},
    { on: true, interval: 5 },
  ],
  [
    'packages/rab-docker/rab/worker-bundle/test/integration/docker-compose.bundle-test.yml',
    'worker-a',
    {},
    {},
    { on: true, interval: 5 },
  ],
];

for (const [rel, service, vars, entered, expected] of COMMITTED) {
  test(
    `committed ${path.basename(rel)} ${service}: provisioner ${expected.on ? 'ON' : 'OFF'} at ${expected.interval}s`,
    { skip },
    () => {
      const { env } = serviceEnv(rel, service, vars);
      const result = resolve({ ...env, ...entered });
      assert.equal(
        result.refused,
        null,
        `${rel} ${service} refused: ${result.refused}`,
      );
      assert.deepEqual(
        result.children,
        expected.on ? ['jobs', 'provisioner'] : ['jobs'],
      );
      assert.equal(result.interval, expected.interval);
      // The child is told it was explicitly enabled — that is what makes it provision with HWS off (config.ts).
      assert.equal(result.provEnv.CREWFLOW_PROVISIONER_ENABLED, 'true');
      assert.equal(result.provEnv.HWS_RUNTIME_ENABLED, env.HWS_RUNTIME_ENABLED);
    },
  );
}

test(
  'inventory: every compose service that runs the bundle is classified above (no unreviewed deployment definition)',
  { skip },
  () => {
    const files = [
      'packages/rab-docker/docker-compose.production.yml',
      'packages/rab-docker/docker-compose.qa.yml',
      'packages/rab-docker/docker-compose.yml',
      'packages/rab-e2e-testing/system/docker-compose.e2e.yml',
      'packages/rab-docker/rab/worker-bundle/test/integration/docker-compose.bullmq-test.yml',
      'packages/rab-docker/rab/worker-bundle/test/integration/docker-compose.bundle-test.yml',
    ];
    const found = {};
    for (const f of files) found[path.basename(f)] = bundleServices(f).sort();
    assert.deepEqual(found, {
      'docker-compose.production.yml': ['rab-worker'],
      'docker-compose.qa.yml': ['worker'],
      'docker-compose.yml': ['worker'],
      // e2e uses a prebuilt image (rab-worker:latest) and the launcher command.
      'docker-compose.e2e.yml': ['worker'],
      'docker-compose.bullmq-test.yml': ['bundle-a', 'bundle-b'],
      'docker-compose.bundle-test.yml': [
        'worker-a',
        'worker-b',
        'worker-mismatch',
        'worker-noprov',
        'worker-rw',
      ],
    });
    // Deliberate test variants: bundle-b/worker-b/worker-rw share bundle-a/worker-a's anchor; worker-mismatch has no pinned
    // interval (it is expected to be refused by the live identity cross-check, never to provision); worker-noprov is the
    // disabled topology on purpose.
    const bt =
      'packages/rab-docker/rab/worker-bundle/test/integration/docker-compose.bundle-test.yml';
    assert.equal(resolve(serviceEnv(bt, 'worker-mismatch').env).interval, 60);
    assert.deepEqual(resolve(serviceEnv(bt, 'worker-noprov').env).children, [
      'jobs',
    ]);
    const bq =
      'packages/rab-docker/rab/worker-bundle/test/integration/docker-compose.bullmq-test.yml';
    assert.equal(resolve(serviceEnv(bq, 'bundle-b').env).interval, 5);
  },
);

// ---------------------------------------------------------------- environments configured OUTSIDE the committed compose

/** The production worker env as an operator who configured the service BEFORE Phase A has it: no switch, no interval. */
function prePhaseAProductionEnv() {
  const { env } = serviceEnv(
    'packages/rab-docker/docker-compose.production.yml',
    'rab-worker',
  );
  const e = { ...env, ...OPENSHIP_ENTERED };
  delete e.CREWFLOW_PROVISIONER_ENABLED;
  delete e.WORKSPACE_PROVISIONER_INTERVAL_SECONDS;
  return e;
}

test(
  'operator env WITHOUT the new switch but WITH CREWFLOW_PROVISIONER_DATABASE_URL (every pre-Phase-A deployment) → provisioner ON at the old 5 s, exactly as before Phase A',
  { skip },
  () => {
    const result = resolve(prePhaseAProductionEnv());
    assert.equal(result.refused, null);
    assert.deepEqual(result.children, ['jobs', 'provisioner']);
    assert.equal(result.interval, 5);
  },
);

test(
  'operator env with NEITHER the switch NOR the provisioner URL → main() exits 1 "Missing CREWFLOW_PROVISIONER_DATABASE_URL", as the base launcher did (never a silent jobs-only start)',
  { skip },
  async () => {
    const e = prePhaseAProductionEnv();
    delete e.CREWFLOW_PROVISIONER_DATABASE_URL;
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    let code;
    try {
      code = await launcher.main({ ...e, CREWFLOW_BUNDLE_FAILURE_EXIT_DELAY_MS: '0' });
    } finally {
      console.error = original;
    }
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /\[worker-bundle\] refused: Missing CREWFLOW_PROVISIONER_DATABASE_URL/);
  },
);

test(
  'operator env with the switch but WITHOUT the interval → provisioner ON at the 60 s code default (not the old 5 s)',
  { skip },
  () => {
    const e = {
      ...prePhaseAProductionEnv(),
      CREWFLOW_PROVISIONER_ENABLED: 'true',
    };
    const result = resolve(e);
    assert.equal(result.refused, null);
    assert.equal(result.interval, 60);
  },
);

test(
  'OpenShip UI override CREWFLOW_PROVISIONER_ENABLED=false (UI wins over committed) with the URL still entered → REFUSES',
  { skip },
  () => {
    const result = resolve({
      ...prePhaseAProductionEnv(),
      CREWFLOW_PROVISIONER_ENABLED: 'false',
    });
    assert.match(
      result.refused ?? '',
      /CREWFLOW_PROVISIONER_DATABASE_URL is set but the workspace provisioner is disabled/,
    );
  },
);

test(
  'jobs-only needs the explicit opt-out: CREWFLOW_PROVISIONER_ENABLED=false with no provisioner URL → jobs only',
  { skip },
  () => {
    const e = { ...prePhaseAProductionEnv(), CREWFLOW_PROVISIONER_ENABLED: 'false' };
    delete e.CREWFLOW_PROVISIONER_DATABASE_URL;
    const result = resolve(e);
    assert.equal(result.refused, null);
    assert.deepEqual(result.children, ['jobs']);
  },
);

test(
  'a typo in the switch ("TRUE", "1", "yes") refuses rather than choosing a mode',
  { skip },
  () => {
    for (const v of ['TRUE', '1', 'yes', 'on']) {
      const result = resolve({
        ...prePhaseAProductionEnv(),
        CREWFLOW_PROVISIONER_ENABLED: v,
      });
      assert.match(
        result.refused ?? '',
        /CREWFLOW_PROVISIONER_ENABLED must be "true" or "false"/,
        v,
      );
    }
  },
);
