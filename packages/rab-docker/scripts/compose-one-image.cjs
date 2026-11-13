'use strict';
/**
 * ONE IMAGE, API FIRST, WORKER AFTER — the CI check for "deploy exactly like Twenty" (owner decision 2026-11-11).
 *
 *   node packages/rab-docker/scripts/compose-one-image.cjs
 *
 * Production deploys like Twenty's packages/twenty-docker: `docker compose pull && docker compose up -d` updates rab-api and
 * rab-worker TOGETHER from ONE image variable. This check renders every DEPLOY compose combination WITHOUT interpolation
 * (`docker compose config --no-interpolate`), so it compares the variable references themselves, not values that could
 * happen to be equal, and fails when:
 *   - rab-api and rab-worker do not use the IDENTICAL image reference;
 *   - that reference is not <repository>@${CREWFLOW_IMAGE_TAG...} (one variable, a digest, never a tag), or names any other
 *     image variable (a separate API or Worker tag variable is exactly what this forbids). Only docker-compose.production.yml
 *     may carry a DEFAULT (owner decision 2026-11-12: the release is pinned in the file so OpenShip deploys without anyone
 *     typing CREWFLOW_IMAGE_TAG), and only a full digest: `${CREWFLOW_IMAGE_TAG:-sha256:<64 lowercase hex>}`. A tag,
 *     `latest`, a short or malformed digest, or any other default is refused; every other deploy combination has none;
 *   - a deploy service has a `build:` section (a server never builds; local builds are docker-compose.local-build.yml);
 *   - rab-worker does not wait for a HEALTHY rab-api with `restart: true` (Compose then stops the old Worker before it
 *     replaces the API, so an old Worker never runs beside a new API), or for a healthy rab-redis;
 *   - rab-api runs with the Worker-only switches (it must migrate and register the schedulers), or rab-worker without them;
 *   - rab-api's stop_grace_period is below 40 s;
 *   - a `rab-ops` service, or any service under an `ops` profile, is present. The separated operations container was
 *     removed (rab-ops removal, PR 2); operations run as one-off owner-login commands of the API image
 *     (`docker compose run --rm --no-deps rab-api node packages/rab-server/dist/command/main.js <command>`), so the
 *     service must not come back unnoticed. The render enables every profile (`--profile '*'`) so a profile-gated
 *     service is never hidden from this check;
 *   - ANY service has a non-empty `profiles` (security review of PR #124, MEDIUM): a deploy file starts every service with
 *     `docker compose up`, so a profile-gated service is a hidden extra container. A re-added operations container under
 *     another name and profile (e.g. `rab-maint`, `profiles: ["maint"]`, reading .env.ops) is refused here whatever it is
 *     called. Profiles, not a service allowlist, so a new always-on service (the coming `db` service) needs no gate change.
 * Scope (owner decision D): the DEPLOY files only. The test-only compose files (system e2e, H6 runtime test, cost harness,
 * BullMQ integration, the weakened rehearsal) and the dev stacks (docker-compose.yml, docker-compose.qa.yml,
 * docker-compose.local-build.yml) are deliberately not checked.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const DOCKER_DIR = path.resolve(__dirname, '..');

/** Every deploy combination, relative to packages/rab-docker. Overlays are rendered on top of their base. */
const DEPLOY_COMBOS = Object.freeze([
  ['docker-compose.production.yml'],
  ['docker-compose.image.yml'],
  ['docker-compose.image.yml', 'docker-compose.local-db.yml'],
  ['docker-compose.image.yml', 'staging/docker-compose.staging.yml'],
  ['docker-compose.image.yml', 'staging/rehearsal/docker-compose.image-rehearsal.yml'],
]);

const IMAGE_VAR = 'CREWFLOW_IMAGE_TAG';
const MIN_API_STOP_GRACE_S = 40;
// <repository or ${CREWFLOW_IMAGE_REPOSITORY...}>@${CREWFLOW_IMAGE_TAG...}: the digest form; a `:` tag cannot appear.
const ONE_IMAGE_REF = /^(\$\{CREWFLOW_IMAGE_REPOSITORY(:-[a-z0-9./_-]+)?\}|[a-z0-9./_:-]+)@\$\{CREWFLOW_IMAGE_TAG(:\?[^}]*)?\}$/;
// The same reference with the ONE allowed default: a full release index digest (docker-compose.production.yml only).
const PINNED_DIGEST_IMAGE_REF = /^(\$\{CREWFLOW_IMAGE_REPOSITORY(:-[a-z0-9./_-]+)?\}|[a-z0-9./_:-]+)@\$\{CREWFLOW_IMAGE_TAG:-sha256:[0-9a-f]{64}\}$/;
/** The deploy combinations whose image line may carry the pinned release digest as its default (owner decision 2026-11-12). */
const DEFAULT_DIGEST_COMBOS = Object.freeze(['docker-compose.production.yml']);
const allowsDefaultDigest = (combo) => combo.length === 1 && DEFAULT_DIGEST_COMBOS.includes(combo[0]);

function durationSeconds(v) {
  if (v === undefined || v === null) return NaN;
  if (typeof v === 'number') return v / 1e9; // compose renders durations as nanoseconds in JSON
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(v).trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  return { ms: n / 1000, s: n, m: n * 60, h: n * 3600, undefined: n }[m[2]];
}

/**
 * Pure check of one rendered (non-interpolated) model. Returns a list of problems. `allowDefaultDigest`: the image line may
 * be `${CREWFLOW_IMAGE_TAG:-sha256:<64 hex>}` (docker-compose.production.yml only); otherwise it must have no default.
 */
function checkModel(model, label, { allowDefaultDigest = false } = {}) {
  const problems = [];
  const p = (msg) => problems.push(`${label}: ${msg}`);
  const services = model?.services ?? {};
  const api = services['rab-api'];
  const worker = services['rab-worker'];
  if (!api) p('rab-api is missing');
  if (!worker) p('rab-worker is missing');
  if (!api || !worker) return problems;

  // rab-ops removal (PR 2): the separated operations container is gone and must not come back, under any profile.
  if (services['rab-ops']) p('rab-ops: service must not exist (removed; operations run as one-off owner-login commands of rab-api)');
  for (const [name, s] of Object.entries(services)) {
    if (Array.isArray(s?.profiles) && s.profiles.includes('ops')) p(`${name}: an "ops" profile service must not exist (the rab-ops container was removed)`);
    // Review of PR #124 (MEDIUM): no profile-gated service at all in a deploy file (a hidden extra container).
    if (Array.isArray(s?.profiles) && s.profiles.length) p(`${name}: has profiles ${JSON.stringify(s.profiles)} (a deploy file has no profile-gated service; every service starts with the stack)`);
  }

  const appServices = ['rab-api', 'rab-worker'];
  for (const name of appServices) {
    const s = services[name];
    if (s.build !== undefined) p(`${name}: has a build section (a server never builds; use the gated image)`);
    const image = String(s.image ?? '');
    if (!(ONE_IMAGE_REF.test(image) || (allowDefaultDigest && PINNED_DIGEST_IMAGE_REF.test(image)))) {
      p(allowDefaultDigest
        ? `${name}: image must be <repository>@\${${IMAGE_VAR}} with no default or a full sha256:<64 hex> default (never a tag or latest), got ${JSON.stringify(image)}`
        : `${name}: image must be <repository>@\${${IMAGE_VAR}} (one variable, a digest, no default), got ${JSON.stringify(image)}`);
    }
    const vars = [...image.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]);
    for (const v of vars) {
      if (v !== IMAGE_VAR && v !== 'CREWFLOW_IMAGE_REPOSITORY') p(`${name}: image names ${v} (only ${IMAGE_VAR} and CREWFLOW_IMAGE_REPOSITORY)`);
    }
  }
  for (const name of appServices) {
    if (name !== 'rab-api' && String(services[name].image) !== String(api.image)) {
      p(`${name}: image differs from rab-api (${JSON.stringify(services[name].image)} vs ${JSON.stringify(api.image)}): one image variable for both`);
    }
  }

  const dep = worker.depends_on ?? {};
  const onApi = dep['rab-api'];
  if (!onApi || onApi.condition !== 'service_healthy') p('rab-worker: must depend on rab-api with condition service_healthy (API first, Worker after)');
  else if (onApi.restart !== true) p('rab-worker: depends_on rab-api needs restart: true (Compose stops the old Worker before replacing the API)');
  if (!dep['rab-redis'] || dep['rab-redis'].condition !== 'service_healthy') p('rab-worker: must depend on rab-redis with condition service_healthy');
  if (api.depends_on?.['rab-worker']) p('rab-api: must not depend on rab-worker (the API starts first)');

  const envOf = (s) => (Array.isArray(s.environment)
    ? Object.fromEntries(s.environment.map((e) => [e.split('=')[0], e.split('=').slice(1).join('=')]))
    : s.environment ?? {});
  const apiEnv = envOf(api);
  const workerEnv = envOf(worker);
  if (String(apiEnv.CREWFLOW_MIGRATE_ON_START) !== 'true') p('rab-api: CREWFLOW_MIGRATE_ON_START must be "true" (the API migrates on start)');
  for (const k of ['DISABLE_DB_MIGRATIONS', 'DISABLE_CRON_JOBS_REGISTRATION']) {
    if (k in apiEnv) p(`rab-api: ${k} must not be set (the API migrates and registers the job schedulers)`);
    if (String(workerEnv[k]) !== 'true') p(`rab-worker: ${k} must be "true" (the Worker never migrates or registers schedulers)`);
  }
  if (!(durationSeconds(api.stop_grace_period) >= MIN_API_STOP_GRACE_S)) p(`rab-api: stop_grace_period below ${MIN_API_STOP_GRACE_S}s`);
  return problems;
}

function render(files) {
  const args = ['compose', '--project-directory', DOCKER_DIR];
  for (const f of files) args.push('-f', path.join(DOCKER_DIR, f));
  // Every profile is enabled so a profile-gated service (a re-added ops container) is rendered and refused, never hidden.
  args.push('--profile', '*', 'config', '--no-interpolate', '--no-env-resolution', '--format', 'json');
  return JSON.parse(execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

function main() {
  let problems = [];
  for (const combo of DEPLOY_COMBOS) {
    const label = combo.join(' + ');
    let model;
    try {
      model = render(combo);
    } catch (e) {
      problems.push(`${label}: docker compose config failed: ${String(e.stderr || e.message).trim().slice(0, 400)}`);
      continue;
    }
    const found = checkModel(model, label, { allowDefaultDigest: allowsDefaultDigest(combo) });
    console.log(`[compose-one-image] ${found.length ? 'FAIL' : 'PASS'} ${label}`);
    problems = problems.concat(found);
  }
  for (const msg of problems) console.error(`[compose-one-image] ${msg}`);
  if (problems.length) process.exit(1);
  console.log(`[compose-one-image] OK: ${DEPLOY_COMBOS.length} deploy combinations use one image variable (${IMAGE_VAR}), API first, Worker after`);
}

module.exports = { checkModel, DEPLOY_COMBOS, ONE_IMAGE_REF, PINNED_DIGEST_IMAGE_REF, DEFAULT_DIGEST_COMBOS, allowsDefaultDigest, render };
if (require.main === module) main();
