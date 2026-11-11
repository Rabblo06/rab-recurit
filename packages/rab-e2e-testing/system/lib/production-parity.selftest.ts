import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * Drift guard (Phase X P0-H review): the measurement harnesses must run PRODUCTION's scan, dispatch and lifecycle settings
 * on BOTH the API and the Worker, because the API registers the BullMQ schedulers with its own environment and the
 * consume-only Worker runs what is registered. The reference is packages/rab-docker/docker-compose.image.yml (rab-api,
 * rab-worker). Compared: the system stack in parity mode (docker-compose.e2e.yml + docker-compose.parity.yml) and the cost
 * stack (cost/docker-compose.cost.yml). A key production does not set is compared with the code default (read from the
 * source where it is declared). A deliberate difference must be listed in ALLOWED with its reason; anything else fails.
 * No Docker, no network: the YAML is parsed and `${VAR:-default}` resolved to its default (the value an unparameterised run
 * gets).
 */
const REPO = join(__dirname, '..', '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const YAML = require(require.resolve('yaml', { paths: [REPO] })) as { parse: (s: string, o?: object) => any };
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/** The keys that decide what runs and how often: scans, dispatch, notifications, the lifecycle switches, pool, flags. */
const CHECKED = /^(WORKER_[A-Z_]+|WORKSPACE_PROVISIONER_INTERVAL_SECONDS|DISABLE_DB_MIGRATIONS|DISABLE_CRON_JOBS_REGISTRATION|CREWFLOW_MIGRATE_ON_START|CREWFLOW_MIGRATION_APPROVAL_MODE|CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS|PG_POOL_MAX_CONNECTIONS|HWS_RUNTIME_ENABLED|AI_ENABLED|PUSH_ENABLED|REALTIME_ENABLED)$/;

/** Documented deliberate differences: `<harness>/<service>/<KEY>` -> reason. Keep this list short and explained. */
const ALLOWED: Record<string, string> = {};

/** Code defaults for keys production leaves unset (the value production therefore runs). */
function codeDefaults(): Record<string, string> {
  const out: Record<string, string> = {};
  const intervals = read('packages/rab-server/src/engine/core-modules/environment/worker-scan-intervals.ts');
  for (const m of intervals.matchAll(/(WORKER_[A-Z_]+_INTERVAL_SECONDS): s\('[^']+', ([\d_]+),/g)) out[m[1]!] = m[2]!.replace(/_/g, '');
  const dispatch = read('packages/rab-worker/src/core/wake/dispatch-config.ts');
  for (const m of dispatch.matchAll(/intSetting\(env, '(WORKER_[A-Z_]+)', (\d+),/g)) out[m[1]!] = m[2]!;
  for (const m of dispatch.matchAll(/env\.get\('(WORKER_[A-Z_]+_MODE)'\) \?\? '([a-z_]+)'/g)) out[m[1]!] = m[2]!;
  const pool = read('packages/rab-server/src/database/postgres/pg-config.ts').match(/PG_POOL_MAX_DEFAULT = (\d+);/);
  if (pool) out.PG_POOL_MAX_CONNECTIONS = pool[1]!;
  const vars = read('packages/rab-server/src/engine/core-modules/environment/environment-variables.ts');
  for (const key of ['WORKER_FAST_PUBLISH_NOTIFY', 'PUSH_ENABLED', 'REALTIME_ENABLED']) {
    const m = vars.match(new RegExp(`\\b${key}: boolean = (true|false);`));
    if (m) out[key] = m[1]!;
  }
  for (const key of ['WORKER_TIMER_TRIGGERS']) {
    const m = vars.match(new RegExp(`\\b${key}: [^=;]+ = '([a-z_-]+)';`));
    if (m) out[key] = m[1]!;
  }
  // env.validation.ts / api-prestart.sh: unset = bullmq in production (interval is refused there).
  out.WORKER_SCHEDULER = 'bullmq';
  return out;
}

/** Compose interpolation as an unparameterised run sees it: ${X:-d} -> d, ${X:?m} / ${X} -> a placeholder. */
function interpolate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let s = String(v);
  for (let i = 0; i < 8; i++) {
    const n = s.replace(/\$\{([A-Z0-9_]+)(?:(:?[-?])([^${}]*))?\}/g, (_m, _n, op, arg) => (op === ':-' || op === '-' ? arg : '<set-by-env>'));
    if (n === s) break;
    s = n;
  }
  return s;
}

/** Parses a compose file (merge keys resolved). `!reset null` becomes a removal marker, `!override` / `!reset []` are dropped. */
function loadCompose(rel: string): any {
  const text = read(rel).replace(/!reset null/g, '"__RESET__"').replace(/!reset \[\]/g, '[]').replace(/!override/g, '');
  return YAML.parse(text, { merge: true });
}

interface Svc {
  env: Record<string, string>;
  healthInterval: string | null;
}

function service(docs: any[], name: string): Svc {
  const env: Record<string, string> = {};
  let healthInterval: string | null = null;
  for (const doc of docs) {
    const s = doc.services?.[name];
    if (!s) continue;
    for (const [k, v] of Object.entries(s.environment ?? {})) {
      if (k === '<<') continue;
      if (v === '__RESET__') delete env[k];
      else env[k] = interpolate(v) ?? '';
    }
    if (s.healthcheck?.interval) healthInterval = String(s.healthcheck.interval);
  }
  return { env, healthInterval };
}

const PROD = loadCompose('packages/rab-docker/docker-compose.image.yml');
const SYSTEM = [loadCompose('packages/rab-e2e-testing/system/docker-compose.e2e.yml'), loadCompose('packages/rab-e2e-testing/system/docker-compose.parity.yml')];
const COST = [loadCompose('packages/rab-e2e-testing/cost/docker-compose.cost.yml')];
const DEFAULTS = codeDefaults();

const PAIRS: [label: string, docs: any[], harnessService: string, prodService: string][] = [
  ['system-parity', SYSTEM, 'server', 'rab-api'],
  ['system-parity', SYSTEM, 'worker', 'rab-worker'],
  ['cost', COST, 'api', 'rab-api'],
  ['cost', COST, 'worker', 'rab-worker'],
  ['cost', COST, 'worker2', 'rab-worker'],
];

test('the code defaults this guard falls back to were found in the source', () => {
  for (const k of ['WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS', 'WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS', 'WORKER_DISPATCH_BACKSTOP_SECONDS', 'WORKER_CLAIM_MODE', 'WORKER_DISPATCH_MODE', 'PG_POOL_MAX_CONNECTIONS', 'WORKER_FAST_PUBLISH_NOTIFY', 'WORKER_TIMER_TRIGGERS', 'PUSH_ENABLED', 'REALTIME_ENABLED']) {
    expect(DEFAULTS[k], k).toBeTruthy();
  }
});

/** The differences between one harness service and its production service (empty = in step). */
function driftOf(label: string, docs: any[], svc: string, prodSvc: string): string[] {
  const prod = service([PROD], prodSvc);
  const harness = service(docs, svc);
  if (Object.keys(harness.env).length <= 5) return [`${label} ${svc}: service not found or not parsed`];
  const keys = new Set([...Object.keys(prod.env), ...Object.keys(harness.env)].filter((k) => CHECKED.test(k)));
  const diffs: string[] = [];
  for (const k of [...keys].sort()) {
    const expected = k in prod.env ? prod.env[k] : DEFAULTS[k];
    const actual = k in harness.env ? harness.env[k] : DEFAULTS[k];
    if (expected === undefined && actual === undefined) continue;
    if (String(expected) !== String(actual) && !ALLOWED[`${label}/${svc}/${k}`]) diffs.push(`${k}: production ${expected ?? '(unset, no known default)'} / harness ${actual ?? '(unset)'}`);
  }
  return diffs;
}

for (const [label, docs, svc, prodSvc] of PAIRS) {
  test(`${label} ${svc} runs production's ${prodSvc} scan, dispatch and lifecycle settings`, () => {
    expect(driftOf(label, docs, svc, prodSvc), `${label} ${svc} differs from ${prodSvc} (fix the harness, or list a documented reason in ALLOWED)`).toEqual([]);
  });
}

test('cost: x-app-env and x-scan-env share no key (in a YAML merge list the first anchor would silently win)', () => {
  const doc = loadCompose('packages/rab-e2e-testing/cost/docker-compose.cost.yml');
  const scan = Object.keys(doc['x-scan-env'] ?? {});
  expect(scan.length).toBeGreaterThan(5);
  expect(Object.keys(doc['x-app-env'] ?? {}).filter((k) => scan.includes(k))).toEqual([]);
});

test("the API health-check interval is production's (the health ping is part of every idle window)", () => {
  const prod = service([PROD], 'rab-api').healthInterval;
  expect(prod).toBeTruthy();
  expect(service(SYSTEM, 'server').healthInterval).toBe(prod);
  expect(service(COST, 'api').healthInterval).toBe(prod);
});

test('the guard itself fails on a drifted value, a worker-only setting and an unknown extra key', () => {
  const cost = read('packages/rab-e2e-testing/cost/docker-compose.cost.yml');
  const drifted = [YAML.parse(cost.replace("WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS: '30'", "WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS: '2'"), { merge: true })];
  expect(driftOf('cost', drifted, 'api', 'rab-api')).toEqual(['WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS: production 30 / harness 2']);
  // A setting only the worker has (the api would register another schedule) is a difference on the api.
  const workerOnly = [YAML.parse(cost.replace("<<: [*app-env, *scan-env]\n      PORT: '3000'", "<<: *app-env\n      PORT: '3000'"), { merge: true })];
  expect(driftOf('cost', workerOnly, 'api', 'rab-api').join(' ')).toContain('WORKER_TIMER_TRIGGERS: production on / harness off');
  const extra = [YAML.parse(cost.replace("  WORKER_FAST_PUBLISH_NOTIFY: 'true'", "  WORKER_FAST_PUBLISH_NOTIFY: 'true'\n  WORKER_SHIFT_SCAN_MODE: combined"), { merge: true })];
  expect(driftOf('cost', extra, 'worker', 'rab-worker')).toEqual(['WORKER_SHIFT_SCAN_MODE: production (unset, no known default) / harness combined']);
});
