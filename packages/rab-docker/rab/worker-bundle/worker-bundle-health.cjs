'use strict';
/**
 * Crewflow Worker bundle — per-instance health for BOTH roles (ordinary jobs + workspace provisioner).
 * Phase A (pa-provisioner): the provisioner role is checked only when CREWFLOW_PROVISIONER_ENABLED=true in the container
 * environment (the same strict switch the launcher reads); otherwise only the jobs role is expected.
 *
 * Used two ways:
 *   1. As the container HEALTHCHECK command: `node /opt/crewflow-bundle/worker-bundle-health.cjs` (exit 0 healthy, 1 not).
 *   2. By the launcher's watchdog (start-worker-bundle.cjs), through `readHeartbeat()`.
 *
 * Source of truth: the per-instance heartbeat file each child writes (packages/rab-worker/src/core/runtime/
 * instance-heartbeat.ts) into a directory only that child's UID can write. NOT the global Redis keys
 * (`rab:worker:heartbeat`, `rab:workspace-provisioner:heartbeat`, `rab:worker:stats`): every replica refreshes those,
 * so a dead or hung child in THIS container would be masked by a healthy replica. NOT the API's /healthz either.
 *
 * Bounded: synchronous reads of two small local files and /proc. No network, no database, no Redis connection.
 * A living PID is not treated as progress: the check requires a fresh event-loop heartbeat, a recently settled AND
 * a recently succeeded cycle, a recent successful Redis write from that same process, and no cycle in flight for longer
 * than its hang budget.
 *
 * Dependency failures (Redis or the database down) make the check report unhealthy, but the launcher never restarts the
 * service for them — only a child that exits or whose event loop stops beating ends the service (see the watchdog in
 * start-worker-bundle.cjs), so a dependency outage cannot turn into a restart storm.
 */
const fs = require('node:fs');

const HEALTH_ROOT = '/run/crewflow-health';
const MAX_HEARTBEAT_BYTES = 64 * 1024;

/** Fixed identities. The jobs UID is the image's existing `node` user (1000), so LOCAL storage written by the API keeps working. */
const ROLES = Object.freeze({
  jobs: Object.freeze({
    uid: 1000,
    gid: 1000,
    file: `${HEALTH_ROOT}/jobs/heartbeat.json`,
    // Several jobs loops run every 2 s; a 5-minute gap means the whole scheduler is wedged.
    settledMaxAgeMs: 5 * 60 * 1000,
    succeededMaxAgeMs: 5 * 60 * 1000,
    // Longest legitimate cycles are report batches (PDF renders, each bounded by 30 s timeouts) and the daily storage sweep.
    inFlightMaxMs: 30 * 60 * 1000,
  }),
  provisioner: Object.freeze({
    uid: 10001,
    gid: 10001,
    file: `${HEALTH_ROOT}/provisioner/heartbeat.json`,
    // One loop, every WORKSPACE_PROVISIONER_INTERVAL_SECONDS (Phase A: default 60 s, at most 120 s — so a settled cycle
    // always fits this 5-minute window, a lock-busy skip included).
    settledMaxAgeMs: 5 * 60 * 1000,
    succeededMaxAgeMs: 5 * 60 * 1000,
    // A batch is at most 10 workspaces, each a few seconds of DDL.
    inFlightMaxMs: 10 * 60 * 1000,
  }),
});

/** Both processes write their heartbeat every 15 s. */
const HEARTBEAT_MAX_AGE_MS = 45 * 1000;
/** Redis heartbeat writes (same 15 s cadence) must have succeeded within this window. */
const REDIS_MAX_AGE_MS = 90 * 1000;
/** bullmq mode: the 15 s heartbeat re-confirms the BullMQ consumers are running; same window as the Redis write. */
const BULLMQ_CONSUMERS_MAX_AGE_MS = 90 * 1000;

/** Returns the parsed heartbeat, or null when absent/unreadable/malformed. Never throws. */
function readHeartbeat(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_HEARTBEAT_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Real UID of a live process, or null when it does not exist (or /proc is unavailable). */
function processUid(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^Uid:\s+(\d+)/m.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

const age = (now, at) => (typeof at === 'number' && Number.isFinite(at) ? now - at : Infinity);
const seconds = (ms) => (Number.isFinite(ms) ? `${Math.round(ms / 1000)}s` : 'never');

function evaluateRole(role, spec, heartbeat, now, uidOf = processUid) {
  const problems = [];
  if (!heartbeat) return { role, healthy: false, problems: ['no heartbeat file from this instance yet'] };
  if (heartbeat.role !== role) problems.push(`heartbeat file names role "${String(heartbeat.role)}"`);
  if (!Number.isInteger(heartbeat.pid) || heartbeat.pid <= 1) {
    problems.push('heartbeat has no valid pid');
  } else {
    const uid = uidOf(heartbeat.pid);
    if (uid === null) problems.push(`process ${heartbeat.pid} is not running`);
    else if (uid !== spec.uid) problems.push(`process ${heartbeat.pid} runs as uid ${uid}, expected ${spec.uid}`);
  }
  const beatAge = age(now, heartbeat.at);
  if (beatAge > HEARTBEAT_MAX_AGE_MS) problems.push(`heartbeat stale (${seconds(beatAge)}): event loop blocked, stopped or dead`);
  const redisAge = age(now, heartbeat.redisOkAt);
  if (redisAge > REDIS_MAX_AGE_MS) problems.push(`no successful Redis heartbeat write for ${seconds(redisAge)}`);
  const sinceStart = age(now, heartbeat.startedAt);
  if (heartbeat.mode === 'bullmq') {
    // WORKER_SCHEDULER=bullmq (jobs role only): one cluster-wide scheduler hands each scan tick to ONE replica, so an idle
    // replica may legitimately finish no cycle for minutes — "a cycle finished recently" would restart-loop it. Instead:
    // its BullMQ consumers must be running and its own scheduler reconcile (which needs Redis and re-creates lost
    // schedulers) must have succeeded recently; and if this instance DID run cycles recently, at least one must have
    // succeeded (all failing = database or dependency failure, as in interval mode).
    const readyAge = heartbeat.consumersReadyAt == null ? sinceStart : age(now, heartbeat.consumersReadyAt);
    if (readyAge > BULLMQ_CONSUMERS_MAX_AGE_MS) problems.push(`BullMQ consumers not confirmed running for ${seconds(readyAge)}`);
    const reconcileAge = heartbeat.reconcileOkAt == null ? sinceStart : age(now, heartbeat.reconcileOkAt);
    if (reconcileAge > spec.settledMaxAgeMs) problems.push(`scheduler reconcile has not succeeded for ${seconds(reconcileAge)}`);
    const settled = heartbeat.lastCycleSettledAt == null ? Infinity : age(now, heartbeat.lastCycleSettledAt);
    const succeeded = heartbeat.lastCycleSucceededAt == null ? Infinity : age(now, heartbeat.lastCycleSucceededAt);
    if (settled <= spec.settledMaxAgeMs && succeeded > spec.succeededMaxAgeMs) {
      problems.push(`cycles on this instance are failing: none succeeded for ${seconds(succeeded)} (database or dependency failure)`);
    }
  } else {
    const settledAge = heartbeat.lastCycleSettledAt == null ? sinceStart : age(now, heartbeat.lastCycleSettledAt);
    if (settledAge > spec.settledMaxAgeMs) problems.push(`no cycle finished for ${seconds(settledAge)}`);
    const succeededAge = heartbeat.lastCycleSucceededAt == null ? sinceStart : age(now, heartbeat.lastCycleSucceededAt);
    if (succeededAge > spec.succeededMaxAgeMs) problems.push(`no cycle succeeded for ${seconds(succeededAge)} (database or dependency failure)`);
  }
  const oldest = heartbeat.oldestInFlight;
  if (oldest && typeof oldest === 'object') {
    const running = age(now, oldest.startedAt);
    if (running > spec.inFlightMaxMs) problems.push(`cycle "${String(oldest.name).slice(0, 80)}" in flight for ${seconds(running)}`);
  }
  if (heartbeat.shuttingDown === true) problems.push('shutting down');
  return { role, healthy: problems.length === 0, problems };
}

function evaluate({ now = Date.now(), roles = ROLES, read = readHeartbeat, uidOf = processUid } = {}) {
  const results = Object.entries(roles).map(([role, spec]) => evaluateRole(role, spec, read(spec.file), now, uidOf));
  return { healthy: results.every((r) => r.healthy), roles: results };
}

/**
 * Phase A (pa-provisioner): the provisioner switch. Shared by the launcher (which refuses an invalid value) and this
 * health check (which reads the same container environment). Strict:
 *   "true"        → 'on'      explicit opt-in.
 *   "false"       → 'off'     explicit opt-out: jobs child only.
 *   unset / empty → 'legacy'  every environment configured before Phase A: the provisioner runs exactly as it did then
 *                             (its URL is required, 5 s cadence), so an existing deployment never loses provisioning.
 *   anything else → null      invalid — the caller fails closed.
 */
function provisionerMode(env) {
  const raw = env.CREWFLOW_PROVISIONER_ENABLED;
  if (raw === undefined || raw === null) return 'legacy';
  const value = String(raw).trim();
  if (value === '') return 'legacy';
  if (value === 'true') return 'on';
  if (value === 'false') return 'off';
  return null;
}

/** True when the provisioner child runs ('on' or 'legacy'), false for 'off', null when the switch is invalid. */
function parseProvisionerEnabled(env) {
  const mode = provisionerMode(env);
  return mode === null ? null : mode !== 'off';
}

/** The roles this container is expected to run: both when the provisioner is enabled, jobs only otherwise; null = invalid. */
function rolesFor(env) {
  const enabled = parseProvisionerEnabled(env);
  if (enabled === null) return null;
  return enabled ? ROLES : Object.freeze({ jobs: ROLES.jobs });
}

if (require.main === module) {
  const roles = rolesFor(process.env);
  if (!roles) {
    // Fail closed: the launcher refuses this value too, so a container reporting it is misconfigured.
    console.log('configuration: UNHEALTHY - CREWFLOW_PROVISIONER_ENABLED must be "true" or "false"');
    process.exit(1);
  }
  const result = evaluate({ roles });
  for (const r of result.roles) {
    // Timestamps and loop names only — the heartbeat never carries configuration or credentials.
    console.log(`${r.role}: ${r.healthy ? 'healthy' : `UNHEALTHY - ${r.problems.join('; ')}`}`);
  }
  process.exitCode = result.healthy ? 0 : 1;
}

module.exports = {
  ROLES, HEALTH_ROOT, HEARTBEAT_MAX_AGE_MS, REDIS_MAX_AGE_MS, BULLMQ_CONSUMERS_MAX_AGE_MS, readHeartbeat, processUid, evaluateRole, evaluate,
  provisionerMode, parseProvisionerEnabled, rolesFor,
};
