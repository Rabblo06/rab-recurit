'use strict';
/**
 * Crewflow Worker bundle supervisor — ONE deployment service, TWO existing entrypoints, two OS identities.
 *
 *   jobs         packages/rab-worker/dist/main.js                    uid/gid 1000  (restricted crewflow_app only)
 *   provisioner  packages/rab-worker/dist/workspace-provisioner.main.js  uid/gid 10001 (privileged crewflow, direct)
 *
 * This file is the only thing that runs as root in the container, and only to start each child under its own
 * non-root UID/GID (libuv drops supplementary groups with setgroups(0) before setgid/setuid) and to signal them.
 * It has no dependencies beyond Node's standard library, opens no network connection, runs no shell, never runs
 * migrations, and never imports application code. Neither child runs as root.
 *
 * It does NOT replace any application guard. Both entrypoints still run their own live checks first:
 * runtime-database-guard.ts (identity probe, DATABASE_URL_UNPOOLED refusal outside the provisioner, production
 * endpoint), assert-runtime-db-role.ts (crewflow_app, no BYPASSRLS/SUPERUSER, no SET ROLE, no owner membership) and
 * hws-startup-guard.ts. The string checks in makePlan() only reject an obviously wrong configuration early, with a
 * clear message; the cluster cross-check below compares what the two children's OWN live probes reported.
 *
 * Credentials: the launcher receives CREWFLOW_PROVISIONER_DATABASE_URL (direct `crewflow`) and hands it ONLY to the
 * provisioner child, as the DATABASE_URL / DATABASE_URL_UNPOOLED names its existing entrypoint reads. Each child gets an
 * explicit allowlisted environment — process.env is never inherited — so NODE_OPTIONS, DOTENV_CONFIG_*, migration
 * approval variables and anything unknown never reach either child. The launcher never logs a URL or secret value:
 * every refusal names variables only.
 *
 * Same-container is NOT separate-container isolation: the launcher, both children and the container runtime share
 * one kernel namespace set, one restart/resource fate, and the launcher (root) holds the provisioning credential.
 * See CREWFLOW_FOUR_SERVICE_WORKER_BUNDLE_REPORT.md and THREAT-MODEL.md for the reviewed trade-off.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const health = require('./worker-bundle-health.cjs');

const APP_ROOT = '/app';
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Reviewed allowlist for the ordinary jobs child, reconciled 2026-10-22 against
 * packages/rab-server/src/engine/core-modules/environment/environment-variables.ts (the validator the Worker's Nest context
 * runs, including productionConfigurationProblems) plus the direct process.env reads in rab-server/rab-worker
 * (instrument.ts, core.datasource.ts DB_POOL_MAX, runtime-database-guard.ts, render-pdf.util.ts, main.ts).
 *
 * Deliberately absent: DATABASE_URL_UNPOOLED (the jobs guard refuses it), CREWFLOW_* (provisioning/migration/bootstrap),
 * DB_TARGET / ALLOW_PRODUCTION_DB_COMMANDS (command authority), BOOTSTRAP_ADMIN_* / SEED_*, TEST_* / RAB_TEST_*,
 * AUTH_*_ISSUER_URL (test-only, refused in production), PORT (no listener), NODE_OPTIONS (would allow --inspect/--require),
 * DOTENV_CONFIG_* (would redirect dotenv). Unknown variables are never forwarded. When the validator gains a variable
 * the Worker needs, add it here in the same change.
 */
const JOBS_ENV_KEYS = Object.freeze([
  // Runtime identity / process
  'NODE_ENV', 'RAB_RUNTIME_ENV', 'TZ', 'APP_VERSION', 'SENTRY_DSN', 'WORKER_SHUTDOWN_TIMEOUT_MS',
  // Restricted database + queue
  'DATABASE_URL', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX', 'REDIS_URL',
  // Encryption / signing (push credentials, QR tokens, report links)
  'APP_SECRET', 'APP_ENCRYPTION_KEYRING', 'APP_ENCRYPTION_ACTIVE_KID', 'APP_JWT_SIGNING_KEYRING', 'APP_JWT_ACTIVE_KID',
  // URLs and production-config validation (the Worker validates the same production rules as the API)
  'APP_URL', 'ACCOUNTS_URL', 'CORS_ORIGINS', 'TRUSTED_PROXY_CIDRS', 'WORKSPACE_BASE_DOMAIN',
  // Feature switches / cutovers read by shared services
  'HWS_RUNTIME_ENABLED', 'AUTH_CONTEXT_CACHE_ENABLED', 'USER_SESSION_CACHE_ENABLED', 'CORE_ENTITY_CACHE_ENABLED',
  'WORKSPACE_METADATA_CACHE_ENABLED', 'USER_SESSION_ENFORCEMENT_CUTOVER',
  // Sign-in provider configuration: the validator refuses to boot when no provider is enabled, and requires an enabled
  // provider's client id/secret/callback — so a deployment that disables password sign-in needs these here too.
  'AUTH_PASSWORD_ENABLED', 'AUTH_GOOGLE_ENABLED', 'AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET', 'AUTH_GOOGLE_CALLBACK_URL',
  'AUTH_MICROSOFT_ENABLED', 'AUTH_MICROSOFT_CLIENT_ID', 'AUTH_MICROSOFT_CLIENT_SECRET', 'AUTH_MICROSOFT_CALLBACK_URL',
  'AUTH_MICROSOFT_TENANT', 'AUTH_OAUTH_HANDOFF_ENABLED',
  // Email
  'EMAIL_DRIVER', 'EMAIL_DELIVERY_ENABLED', 'EMAIL_SMTP_HOST', 'EMAIL_SMTP_PORT', 'EMAIL_SMTP_USER', 'EMAIL_SMTP_PASSWORD',
  'EMAIL_SMTP_NO_TLS', 'RESEND_API_KEY', 'EMAIL_FROM_ADDRESS', 'EMAIL_REPLY_TO',
  // Storage
  'STORAGE_DRIVER', 'STORAGE_LOCAL_ROOT', 'STORAGE_KEY_PREFIX', 'S3_BUCKET', 'S3_REGION', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE', 'S3_SIGNED_URL_TTL_SECONDS', 'S3_MAX_UPLOAD_BYTES', 'S3_SERVER_SIDE_ENCRYPTION',
  'S3_KMS_KEY_ID', 'STORAGE_CLEANUP_PURGE_DELETED_IMAGES_AFTER_DAYS',
  // Push
  'PUSH_ENABLED', 'PUSH_PROVIDER', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'APNS_AUTH_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID',
  'APNS_BUNDLE_ID', 'APNS_ENVIRONMENT', 'PUSH_DELIVERY_MAX_ATTEMPTS',
  // Realtime outbox publisher
  'REALTIME_ENABLED', 'REALTIME_HEARTBEAT_INTERVAL_MS', 'REALTIME_MAX_CONNECTIONS_PER_USER',
  // Scheduling / attendance / offers / invites business timings
  'CLOCK_IN_EARLY_MINUTES', 'QR_POST_SHIFT_GRACE_MINUTES', 'REPORT_AVAILABLE_BEFORE_MINUTES', 'GEOFENCE_MAX_ACCURACY_M',
  'LOCATION_EVIDENCE_MAX_AGE_SECONDS', 'LOCATION_EVIDENCE_MAX_FUTURE_SKEW_SECONDS', 'LATE_CLOCK_IN_GRACE_MINUTES',
  'MANAGER_CONFIRMATION_TIMEOUT_MINUTES', 'MEMBER_INVITE_RATE_RECIPIENT_PER_DAY', 'MEMBER_INVITE_RATE_ACTOR_PER_HOUR',
  'MEMBER_INVITE_RATE_ORGANISATION_PER_DAY', 'MEMBER_INVITE_RATE_REDEEM_PER_IP_PER_HOUR',
  // PDF rendering (system Chromium; the image sets these)
  'CHROMIUM_EXECUTABLE_PATH', 'CHROMIUM_NO_SANDBOX', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
]);

/**
 * Reviewed allowlist for the provisioner child: workspace-provisioner.main.ts builds no Nest context, so it validates no
 * app configuration and needs no APP_SECRET, email, storage, push or sign-in settings. It reads NODE_ENV/RAB_RUNTIME_ENV
 * (runtime guard), REDIS_URL (its own heartbeat/stats only), SENTRY_DSN (instrument.ts), and — set by the launcher, never
 * forwarded — DATABASE_URL / DATABASE_URL_UNPOOLED and HWS_RUNTIME_ENABLED.
 */
const PROVISIONER_ENV_KEYS = Object.freeze(['NODE_ENV', 'RAB_RUNTIME_ENV', 'TZ', 'REDIS_URL', 'SENTRY_DSN']);

/** Present on the Worker service at all (non-empty) → refuse: this service never holds migration or bootstrap authority. */
const FORBIDDEN_SERVICE_KEYS = Object.freeze([
  'DATABASE_URL_UNPOOLED',
  'CREWFLOW_MIGRATION_APPROVED',
  'CREWFLOW_MIGRATION_DATABASE_URL',
  'CREWFLOW_MIGRATION_PHASE',
  'CREWFLOW_BOOTSTRAP_PASSWORD',
  'CREWFLOW_APP_BOOTSTRAP_PASSWORD',
  'ALLOW_PRODUCTION_DB_COMMANDS',
]);

/** Packaged dotenv files would undermine explicit environment construction (main.ts loads ./.env, the provisioner its own). */
const DOTENV_PATHS = Object.freeze([
  '.env',
  'packages/rab-worker/.env',
  'packages/rab-worker/.env.provisioner',
  'packages/rab-server/.env',
]);

const DEFAULT_LAYOUT = Object.freeze({
  root: APP_ROOT,
  jobs: { uid: health.ROLES.jobs.uid, gid: health.ROLES.jobs.gid, home: '/tmp/crewflow-jobs', healthFile: health.ROLES.jobs.file },
  provisioner: {
    uid: health.ROLES.provisioner.uid,
    gid: health.ROLES.provisioner.gid,
    home: '/tmp/crewflow-provisioner',
    healthFile: health.ROLES.provisioner.file,
  },
});

class BundleConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BundleConfigError';
  }
}

const own = (env, keys) => Object.fromEntries(keys.filter((k) => typeof env[k] === 'string').map((k) => [k, env[k]]));

function required(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || !value.trim()) throw new BundleConfigError(`Missing ${key}`);
  return value.trim();
}

/** Parses a PostgreSQL URL. Errors name the variable only — never the value. */
function pgUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BundleConfigError(`Invalid ${label}: not a URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new BundleConfigError(`Invalid ${label}: expected postgres://user:password@host[:port]/database`);
  }
  return { user: decodeURIComponent(url.username), host: url.hostname.toLowerCase(), database: decodeURIComponent(url.pathname.slice(1)) };
}

/** Neon's transaction pooler cannot carry session advisory locks or the provisioner's own BEGIN/COMMIT pairs. */
const isPoolerHost = (host) => /-pooler\./.test(host);

/**
 * Pure: validates the service environment and builds the two child specs. Throws BundleConfigError (names only).
 */
function makePlan(env, layout = DEFAULT_LAYOUT) {
  for (const key of FORBIDDEN_SERVICE_KEYS) {
    if (typeof env[key] === 'string' && env[key].trim() !== '') {
      throw new BundleConfigError(`${key} must not be configured on the Worker service (no migration or bootstrap authority here)`);
    }
  }
  const appUrl = required(env, 'DATABASE_URL');
  const directUrl = required(env, 'DATABASE_DIRECT_URL');
  const provisionerUrl = required(env, 'CREWFLOW_PROVISIONER_DATABASE_URL');
  required(env, 'REDIS_URL');
  const app = pgUrl(appUrl, 'DATABASE_URL');
  const direct = pgUrl(directUrl, 'DATABASE_DIRECT_URL');
  const provisioner = pgUrl(provisionerUrl, 'CREWFLOW_PROVISIONER_DATABASE_URL');
  if (app.user !== 'crewflow_app' || direct.user !== 'crewflow_app') {
    throw new BundleConfigError('DATABASE_URL and DATABASE_DIRECT_URL must log in as crewflow_app (the live role guards still run too)');
  }
  if (provisioner.user !== 'crewflow') throw new BundleConfigError('CREWFLOW_PROVISIONER_DATABASE_URL must log in as crewflow');
  if (app.database !== direct.database || app.database !== provisioner.database) {
    throw new BundleConfigError('DATABASE_URL, DATABASE_DIRECT_URL and CREWFLOW_PROVISIONER_DATABASE_URL name different databases');
  }
  if (isPoolerHost(direct.host)) throw new BundleConfigError('DATABASE_DIRECT_URL is a pooled (-pooler) host; use the direct host');
  if (isPoolerHost(provisioner.host)) throw new BundleConfigError('CREWFLOW_PROVISIONER_DATABASE_URL is a pooled (-pooler) host; use the direct host');
  if (env.NODE_ENV === 'production' || env.RAB_RUNTIME_ENV === 'production') {
    if (env.NODE_ENV !== 'production' || env.RAB_RUNTIME_ENV !== 'production') {
      throw new BundleConfigError('NODE_ENV=production and RAB_RUNTIME_ENV=production must be set together');
    }
    required(env, 'TRUSTED_PROXY_CIDRS');
  }
  if (layout.jobs.uid === layout.provisioner.uid || layout.jobs.gid === layout.provisioner.gid) {
    throw new BundleConfigError('jobs and provisioner must run as different UIDs and GIDs');
  }
  if ([layout.jobs.uid, layout.jobs.gid, layout.provisioner.uid, layout.provisioner.gid].some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new BundleConfigError('child UIDs/GIDs must be non-root integers');
  }

  const jobsEnv = {
    ...own(env, JOBS_ENV_KEYS),
    PATH: SAFE_PATH,
    HOME: layout.jobs.home,
    TMPDIR: layout.jobs.home,
    CREWFLOW_INSTANCE_HEALTH_FILE: layout.jobs.healthFile,
  };
  const provisionerEnv = {
    ...own(env, PROVISIONER_ENV_KEYS),
    DATABASE_URL: provisionerUrl,
    DATABASE_URL_UNPOOLED: provisionerUrl,
    HWS_RUNTIME_ENABLED: 'true',
    PATH: SAFE_PATH,
    HOME: layout.provisioner.home,
    TMPDIR: layout.provisioner.home,
    CREWFLOW_INSTANCE_HEALTH_FILE: layout.provisioner.healthFile,
  };
  return [
    {
      name: 'jobs',
      entry: path.join(layout.root, 'packages/rab-worker/dist/main.js'),
      cwd: layout.root,
      env: jobsEnv,
      uid: layout.jobs.uid,
      gid: layout.jobs.gid,
      healthFile: layout.jobs.healthFile,
      expectGuard: { process: 'worker', role: 'crewflow_app' },
    },
    {
      name: 'provisioner',
      entry: path.join(layout.root, 'packages/rab-worker/dist/workspace-provisioner.main.js'),
      cwd: layout.root,
      env: provisionerEnv,
      uid: layout.provisioner.uid,
      gid: layout.provisioner.gid,
      healthFile: layout.provisioner.healthFile,
      expectGuard: { process: 'provisioner', role: 'crewflow' },
    },
  ];
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * Container-level preconditions, checked before anything starts. Refuses rather than degrading to weaker isolation.
 */
function preflight(plan, layout = DEFAULT_LAYOUT, { platform = process.platform, uid = process.getuid?.() } = {}) {
  if (platform !== 'linux' || uid !== 0) {
    throw new BundleConfigError('must run as root on Linux: it only starts each child under its own non-root UID/GID (see the image USER/user: settings)');
  }
  const childUids = new Set(plan.map((s) => s.uid));
  for (const spec of plan) {
    const st = statOrNull(spec.entry);
    if (!st || !st.isFile()) throw new BundleConfigError(`entrypoint missing: ${path.relative(layout.root, spec.entry)}`);
    // Code imported by either child must not be writable by either child (shared code is the main same-container risk).
    for (const p of [spec.entry, path.dirname(spec.entry), path.join(layout.root, 'packages'), path.join(layout.root, 'node_modules')]) {
      const s = statOrNull(p);
      if (!s) continue;
      if (childUids.has(s.uid) || (s.mode & 0o022) !== 0) {
        throw new BundleConfigError(`application code is writable by a child identity: ${path.relative(layout.root, p) || '.'} (must be root-owned, not group/other-writable)`);
      }
    }
  }
  for (const rel of DOTENV_PATHS) {
    if (statOrNull(path.join(layout.root, rel))) throw new BundleConfigError(`packaged dotenv file present: ${rel} (remove it from the image)`);
  }
  for (const [name, spec] of Object.entries({ jobs: layout.jobs, provisioner: layout.provisioner })) {
    const home = statOrNull(spec.home);
    if (!home || !home.isDirectory() || home.uid !== spec.uid || (home.mode & 0o077) !== 0) {
      throw new BundleConfigError(`${name} temporary directory ${spec.home} must exist, be owned by uid ${spec.uid} and have mode 0700`);
    }
    const dir = statOrNull(path.dirname(spec.healthFile));
    if (!dir || !dir.isDirectory() || dir.uid !== spec.uid || (dir.mode & 0o022) !== 0) {
      throw new BundleConfigError(`${name} health directory ${path.dirname(spec.healthFile)} must exist, be owned by uid ${spec.uid} and not be group/other-writable`);
    }
  }
}

const GUARD_LINE = /^\[runtime-db-guard\] process=(\S+) runtime=\S+ classification=\S+ endpoint=\S+ database=(\S+) cluster=(\S+) role=(\S+) probe=read-only-ok/;

/** Every process (other than ourselves) whose real UID is one of `uids` — the bundle's dedicated child identities. */
function processesOwnedBy(uids) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const uid = health.processUid(pid);
    if (uid !== null && uids.has(uid)) found.push(pid);
  }
  return found;
}

/**
 * Supervises the children until the service stops. Resolves with the service exit code:
 * 0 only for a requested stop (SIGTERM/SIGINT) where every child exited cleanly; 1 otherwise. Any child exit that was
 * not requested — INCLUDING exit code 0 — fails the whole service: both processes are mandatory and long-running.
 */
function supervise(specs, options = {}) {
  const {
    graceMs = 42_000,
    watchdogIntervalMs = 10_000,
    staleHeartbeatMs = 90_000,
    startupWarnMs = 180_000,
    guardDeadlineMs = 120_000,
    requireGuardLines = true,
    log = (s) => console.error(`[worker-bundle] ${s}`),
    out = (name, line) => process.stdout.write(`[${name}] ${line}\n`),
    err = (name, line) => process.stderr.write(`[${name}] ${line}\n`),
    sweepUids = true,
    signals = process,
  } = options;

  return new Promise((resolve) => {
    const records = [];
    const childUids = new Set(specs.map((s) => s.uid));
    let stopping = false;
    let settled = false;
    let exitCode = 0;
    let graceTimer;
    let watchdogTimer;
    let guardTimer;

    const killPid = (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch (e) {
        if (e.code !== 'ESRCH') log(`could not send ${signal} to pid ${pid} (${e.code})`);
      }
    };
    const killGroup = (pid, signal) => {
      try {
        process.kill(-pid, signal);
      } catch (e) {
        if (e.code !== 'ESRCH') log(`could not send ${signal} to process group ${pid} (${e.code})`);
      }
    };
    /** Descendants that left the child's process group (Playwright starts Chromium detached) are found by UID. */
    const sweep = () => {
      if (!sweepUids) return 0;
      const pids = processesOwnedBy(childUids);
      for (const pid of pids) killPid(pid, 'SIGKILL');
      return pids.length;
    };

    function finish() {
      if (settled || !stopping || records.some((r) => !r.closed)) return;
      settled = true;
      clearTimeout(graceTimer);
      clearInterval(watchdogTimer);
      clearTimeout(guardTimer);
      signals.removeListener('SIGTERM', onSigterm);
      signals.removeListener('SIGINT', onSigint);
      for (const r of records) if (r.pid) killGroup(r.pid, 'SIGKILL');
      const swept = sweep();
      if (swept > 0) log(`killed ${swept} leftover process(es) owned by a child identity`);
      resolve(exitCode);
    }

    function force() {
      exitCode = 1;
      log(`children did not exit within ${graceMs}ms — sending SIGKILL`);
      for (const r of records) if (r.pid && !r.closed) killGroup(r.pid, 'SIGKILL');
      sweep();
      // A SIGKILLed child always closes; if the runtime somehow never reports it, do not hang the stop.
      setTimeout(() => {
        for (const r of records) r.closed = true;
        finish();
      }, 5_000).unref();
    }

    function stop(code, reason) {
      exitCode = Math.max(exitCode, code);
      if (stopping) return;
      stopping = true;
      log(`stopping: ${reason}`);
      // SIGTERM to the child process ONLY (not its group): the entrypoints drain in-flight work (a PDF render included)
      // before exiting, exactly as before the bundle. Their whole groups are SIGKILLed after they exit or at the deadline.
      for (const r of records) if (r.pid && !r.closed) killPid(r.pid, 'SIGTERM');
      graceTimer = setTimeout(force, graceMs);
      finish();
    }

    function onSigterm() {
      if (stopping) force();
      else stop(0, 'received SIGTERM');
    }
    function onSigint() {
      if (stopping) force();
      else stop(0, 'received SIGINT');
    }
    signals.on('SIGTERM', onSigterm);
    signals.on('SIGINT', onSigint);

    function onGuardLine(record, match) {
      if (record.guard) return;
      record.guard = { process: match[1], database: match[2], cluster: match[3], role: match[4] };
      const expect = record.spec.expectGuard;
      if (expect && (record.guard.process !== expect.process || record.guard.role !== expect.role)) {
        stop(1, `${record.spec.name}: live identity probe reported process=${record.guard.process} role=${record.guard.role}, expected process=${expect.process} role=${expect.role}`);
        return;
      }
      const reported = records.filter((r) => r.guard);
      if (reported.length === records.length && records.length > 1) {
        const [first, ...rest] = reported;
        const mismatch = rest.find((r) => r.guard.cluster !== first.guard.cluster || r.guard.database !== first.guard.database);
        if (mismatch) {
          stop(1, `live identity probes disagree: ${first.spec.name} reached database=${first.guard.database} cluster=${first.guard.cluster}, ${mismatch.spec.name} reached database=${mismatch.guard.database} cluster=${mismatch.guard.cluster}`);
        } else {
          log(`live identity probes agree: database=${first.guard.database} cluster=${first.guard.cluster} (${reported.map((r) => `${r.spec.name}=${r.guard.role}`).join(', ')})`);
        }
      }
    }

    function pipeLines(record, stream, writer) {
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const match = GUARD_LINE.exec(line);
        if (match) onGuardLine(record, match);
        writer(record.spec.name, line);
      });
    }

    for (const spec of specs) {
      if (stopping) break;
      const record = { spec, child: null, pid: undefined, closed: false, guard: null, launchedAt: Date.now(), warnedNoBeat: false };
      records.push(record);
      let child;
      try {
        child = spawn(process.execPath, [spec.entry], {
          cwd: spec.cwd,
          env: spec.env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          uid: spec.uid,
          gid: spec.gid,
        });
      } catch (e) {
        record.closed = true;
        stop(1, `${spec.name}: launch failure (${e.code ?? 'error'})`);
        break;
      }
      record.child = child;
      record.pid = child.pid;
      if (child.pid) log(`${spec.name}: started pid=${child.pid} uid=${spec.uid} gid=${spec.gid}`);
      pipeLines(record, child.stdout, out);
      pipeLines(record, child.stderr, err);
      child.once('error', (e) => {
        if (!child.pid) record.closed = true;
        stop(1, `${spec.name}: launch failure (${e.code ?? 'error'})`);
        finish();
      });
      child.once('close', (code, signal) => {
        record.closed = true;
        log(`${spec.name}: exited (${code ?? signal ?? 'unknown'})`);
        if (!stopping) stop(1, `${spec.name} exited unexpectedly (${code ?? signal}) — a mandatory process stopped, failing the whole service`);
        else if (code !== 0) exitCode = Math.max(exitCode, 1);
        finish();
      });
    }

    // Watchdog: a child whose event loop stopped beating is hung even though its PID is alive. Only a stale heartbeat
    // from a process that HAS beaten ends the service; a slow start or a dependency outage (Redis/DB down) is reported by
    // the health check, never turned into a restart loop here.
    watchdogTimer = setInterval(() => {
      if (stopping) return;
      const now = Date.now();
      for (const r of records) {
        if (r.closed || !r.pid || !r.spec.healthFile) continue;
        const hb = health.readHeartbeat(r.spec.healthFile);
        const ours = hb && hb.pid === r.pid && typeof hb.at === 'number';
        if (ours && now - hb.at > staleHeartbeatMs) {
          // A hung (or stopped) event loop cannot run its SIGTERM drain, so waiting out the grace period for it would only
          // delay recovery: kill it now, and let the healthy child drain normally.
          stop(1, `${r.spec.name}: no heartbeat for ${Math.round((now - hb.at) / 1000)}s — process is hung, killing it`);
          killGroup(r.pid, 'SIGKILL');
          return;
        }
        if (!ours && !r.warnedNoBeat && now - r.launchedAt > startupWarnMs) {
          r.warnedNoBeat = true;
          log(`${r.spec.name}: no heartbeat ${Math.round(startupWarnMs / 1000)}s after launch — still starting or waiting on a dependency (health check reports unhealthy)`);
        }
      }
    }, watchdogIntervalMs);
    watchdogTimer.unref?.();

    if (requireGuardLines) {
      guardTimer = setTimeout(() => {
        const missing = records.filter((r) => !r.closed && !r.guard).map((r) => r.spec.name);
        if (!stopping && missing.length > 0) {
          stop(1, `could not confirm the live database identity of: ${missing.join(', ')} within ${guardDeadlineMs}ms of launch`);
        }
      }, guardDeadlineMs);
      guardTimer.unref?.();
    }

    finish();
  });
}

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Waits `delayMs`, or less if a stop signal arrives — so a platform without restart back-off cannot spin on fast failures. */
function failureDelay(delayMs) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      process.removeListener('SIGTERM', done);
      process.removeListener('SIGINT', done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    process.once('SIGTERM', done);
    process.once('SIGINT', done);
  });
}

async function main(env = process.env) {
  const startedAt = Date.now();
  const delayMs = boundedInt(env.CREWFLOW_BUNDLE_FAILURE_EXIT_DELAY_MS, 30_000, 0, 300_000);
  let plan;
  try {
    plan = makePlan(env);
    preflight(plan);
  } catch (error) {
    // BundleConfigError messages name variables and paths only, never values.
    const message = error instanceof BundleConfigError ? error.message : 'unexpected launcher error';
    console.error(`[worker-bundle] refused: ${message}`);
    await failureDelay(delayMs);
    return 1;
  }
  // Must exceed the jobs process's own deadline (WORKER_SHUTDOWN_TIMEOUT_MS drain, default 30 s, + its 10 s hard exit),
  // so its drain finishes before any SIGKILL. The platform's stop timeout must in turn exceed this (compose: 55 s).
  const workerDrainMs = boundedInt(env.WORKER_SHUTDOWN_TIMEOUT_MS, 30_000, 1_000, 600_000);
  const graceMs = boundedInt(env.CREWFLOW_BUNDLE_SHUTDOWN_GRACE_MS, workerDrainMs + 12_000, 5_000, 900_000);
  console.error(`[worker-bundle] starting jobs + provisioner (shutdown grace ${graceMs}ms)`);
  const code = await supervise(plan, { graceMs });
  if (code !== 0 && Date.now() - startedAt < 60_000) {
    console.error(`[worker-bundle] failed ${Math.round((Date.now() - startedAt) / 1000)}s after start — delaying exit ${delayMs}ms`);
    await failureDelay(delayMs);
  }
  console.error(`[worker-bundle] exiting with code ${code}`);
  return code;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    () => {
      console.error('[worker-bundle] refused: unexpected launcher error');
      process.exit(1);
    },
  );
}

module.exports = {
  JOBS_ENV_KEYS,
  PROVISIONER_ENV_KEYS,
  FORBIDDEN_SERVICE_KEYS,
  DEFAULT_LAYOUT,
  BundleConfigError,
  makePlan,
  preflight,
  main,
  supervise,
  processesOwnedBy,
  GUARD_LINE,
};
