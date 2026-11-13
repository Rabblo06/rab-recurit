#!/usr/bin/env node
'use strict';
/**
 * Owner-login deployment gate: the compose and env-file contract of the ONE-LOGIN deployment (owner decision 2026-11-04:
 * one schema-owning login, crewflow_owner, for the API and the Worker; no mode switch). O3 (owner decisions C1-C5,
 * 2026-11-05, "EXACTLY LIKE TWENTY"): no release step; the API migrates on start, the Worker never migrates.
 *
 *   node packages/rab-docker/scripts/compose-owner-login.cjs            # full: docker-compose.image.yml + every override
 *   node packages/rab-docker/scripts/compose-owner-login.cjs --static   # templates + the bundled-database (`db`) rules only
 *   node packages/rab-docker/scripts/compose-owner-login.cjs --lint-env-file <database|runtime|compose> <path>
 *
 * FULL mode renders, with every profile enabled (`docker compose --env-file <throw-away> --project-directory <throw-away>
 *   --profile '*' config --format json`; a profile-gated service is rendered and refused, review of PR #124),
 *   docker-compose.image.yml                                   (bundled db: compose.env sets only PG_DATABASE_PASSWORD)
 *   docker-compose.image.yml                                   (external: compose.env also sets PG_DATABASE_URL = an admin URL)
 *   docker-compose.image.yml                                   (pass-through: compose.env sets PG_DATABASE_URL = crewflow_owner)
 *   docker-compose.image.yml + staging/docker-compose.staging.yml
 * from sentinel env files only (no real .env, compose.env or secret of this machine is read; CREWFLOW_* / COMPOSE_* /
 * PG_DATABASE_* are removed from the child environment because they would win over --env-file), and asserts on each
 * rendered model:
 *   - DB-SETUP, like Twenty; PR #125 option 2: the ONE database setting, PG_DATABASE_URL (compose.env: an admin URL, an
 *     existing crewflow_owner URL, or unset = the bundled db), reaches ONLY the one-shot db-setup service, as the committed
 *     `${PG_DATABASE_URL:-<the bundled db's admin URL>}` (an interpolation value of compose.env, never an env file).
 *     rab-api and rab-worker have NO PG_DATABASE_URL key and no other database credential anywhere in their definition
 *     (environment, health check, command, labels: the bundled db's password, an admin password, a crewflow_owner password,
 *     any postgres:// value); they mount db-setup's target volume read-only. compose.env's PG_DATABASE_URL may be any login
 *     but a former separated one, verify-full, a direct host, with a password. db-setup has
 *     exactly its shape (same image, entrypoint ./db-setup.sh, restart "no", no port, no profile, the H1-H6 hardening,
 *     depends_on a healthy db only, the CA read-only and the target volume writable) and rab-api waits for it
 *     (service_completed_successfully). No service carries any other database URL — no migrator, provisioner,
 *     worker, ops, replica, posture, drift or test URL, no legacy DATABASE_URL* name, no libpq PG* variable, no postgres://
 *     value under another key; no CREWFLOW_DB_MODE (there is no mode switch); nothing from a separated-mode env file
 *     (.env.migrate, the retired .env.ops, per-service staging files) reaches any service;
 *   - CREWFLOW_MIGRATION_APPROVED is never set by a compose or env file (a one-run `run -e` only), and no role password or
 *     command/ops authority reaches any service; CREWFLOW_UPGRADE_INCOMPLETE (api-prestart.sh's own flag) is never set;
 *   - the H1-H6 hardening on every service: image by digest and no `build:`, non-root numeric user, read_only, cap_drop ALL
 *     and no cap_add, no-new-privileges, pids/memory/CPU limits, health checks, a stop window, bounded logs, no privileged /
 *     host namespaces / Docker socket, read-only binds, only rab-api publishes and only on loopback;
 *   - the lifecycle (O3): NO rab-migrate; the API migrates on start (CREWFLOW_MIGRATE_ON_START=true, approval mode
 *     ${CREWFLOW_MIGRATION_APPROVAL_MODE:-none} from compose.env, rendering only as none or token (BC-11/C4), a
 *     fresh-install start_period, registers the job schedulers), exactly ONE instance and never a
 *     start-first update (C5: stop-then-start); the deprecated CREWFLOW_UPGRADE_FAILURE_POLICY is not committed (C3:
 *     continue by default). The deployment identity stays an OPT-IN of database.env, never committed. The Worker never
 *     migrates (DISABLE_DB_MIGRATIONS=true), only consumes the schedulers (DISABLE_CRON_JOBS_REGISTRATION=true), does not
 *     wait for the schema itself (CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS=0), starts after a healthy API and Redis, runs
 *     main.js as 1000:1000 with tmpfs and a jobs-only health check, stop grace >= 45 s; WORKER_SCHEDULER is never
 *     committed (production defaults to bullmq); Redis AOF + noeviction + ACL, never published;
 *   - notification delivery (owner decision 2026-11-06): WORKER_FAST_PUBLISH_NOTIFY=true and
 *     WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS=30 committed, byte-identical, on rab-api AND rab-worker (the API registers the
 *     email scheduler with its own value; notify() runs in both processes), and never re-entered in an env file;
 *   - the Phase D switches (owner decision 2026-11-06): timer triggers on for all four kinds and the safety-sweep
 *     intervals (offer expiry 300 s, manager confirmation 120 s, late clock-in 300 s), committed, byte-identical, on rab-api
 *     AND rab-worker, never re-entered in an env file; the shift monitor keeps its 300 s and the combined shift scan stays
 *     off (neither may be changed by an env file);
 *   - the pay-statement dispatch sweep (owner decision 2026-11-11, Phase X J1a): WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS
 *     =30 committed, byte-identical, on rab-api AND rab-worker, never re-entered in an env file;
 *   - the push and realtime sweeps once those features are ON (Phase X J2, SJ-03): PUSH_ENABLED / REALTIME_ENABLED must be
 *     the same on rab-api and rab-worker; with PUSH_ENABLED=true, WORKER_PUSH_DISPATCH_INTERVAL_SECONDS=30 must be committed
 *     on both (owner rule 2026-11-06); with REALTIME_ENABLED=true, WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS must be
 *     identical on both (its value is an owner decision not yet taken); neither interval may be set in an env file.
 *     `--lint-env-file runtime` renders the committed compose with the file's switches to apply the same rule;
 *   - DB-SETUP PID 1: rab-api's entrypoint is exactly ./api-prestart.sh and rab-worker's exactly ./worker-start.sh, with no
 *     command and no compose init: each script is PID 1, cleans the environment, then execs the image's tini, so no process
 *     of either container holds the admin URL (T-5; lead decision 2026-11-12);
 *   - the bundled PostgreSQL `db` (DB-SETUP, owner decisions D1 a / D3 / D4; docker-compose.local-db.yml is retired): an
 *     image pinned by digest, the same H1-H6 hardening as every service, no port, the internal crewflow-db network only,
 *     a health check, its two named volumes, POSTGRES_PASSWORD exactly ${PG_DATABASE_PASSWORD:?...} (T-2) and no
 *     POSTGRES_PASSWORD_FILE / trust / database URL, TLS on with the certificate it makes itself (verify-full kept), the
 *     superuser never named crewflow_owner; rab-api waits for it healthy; rab-api and rab-worker mount only its CA volume,
 *     read-only; PG_DATABASE_PASSWORD reaches no container (only db's POSTGRES_PASSWORD and db-setup's default URL hold it).
 * STATIC mode lints the committed templates and renders docker-compose.image.yml, checking only the bundled-database rules.
 * Prints service names, variable NAMES and check results only, never a value.
 * Exit 0 = all checks passed, 1 = a check failed, 2 = usage error or docker compose unavailable.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DOCKER_DIR = path.resolve(__dirname, '..');
const FILES = Object.freeze({
  image: path.join(DOCKER_DIR, 'docker-compose.image.yml'),
  staging: path.join(DOCKER_DIR, 'staging/docker-compose.staging.yml'),
});
const TEMPLATES = Object.freeze({
  database: path.join(DOCKER_DIR, 'env/database.env.example'),
  runtime: path.join(DOCKER_DIR, 'env/runtime.env.example'),
  compose: path.join(DOCKER_DIR, 'env/compose.env.example'),
});
// O3: one lifecycle (the API migrates on start); docker-compose.migrate-on-start.yml is folded into the image compose.
// DB-SETUP (D3): docker-compose.local-db.yml is retired; the bundled `db` is part of the image compose itself. `external`
// renders the same file with an admin PG_DATABASE_URL set in compose.env (the operator's own database); `pass-through` with a
// crewflow_owner URL there (DB-SETUP-PLAN §7.1: an existing deployment). `external` names what compose.env's URL is
// (PR #125 option 2: in both cases it reaches db-setup only).
const COMBOS = Object.freeze([
  { name: 'default', files: ['image'], external: false, staging: false },
  { name: 'external', files: ['image'], external: 'admin', staging: false }, // compose.env: PG_DATABASE_URL = an admin URL
  { name: 'pass-through', files: ['image'], external: 'owner', staging: false },
  { name: 'staging', files: ['image', 'staging'], external: false, staging: true },
]);
const STATIC_COMBO = Object.freeze({ name: 'static:image', files: ['image'], external: false });

const OWNER_LOGIN = 'crewflow_owner';
/** DB-SETUP: the bundled database service and the one compose-only variable that holds its superuser password. */
const DB_SERVICE = 'db';
const DB_PASSWORD_KEY = 'PG_DATABASE_PASSWORD';
/** Where the app services mount the bundled db's CA volume (read-only), and the db's own volume targets. */
const DB_CA_VOLUME = 'crewflow-db-ca';
const DB_CA_TARGET = '/run/crewflow/db-ca';
/** PR #125 options A and 2: the one-shot setup service (the ONLY service with PG_DATABASE_URL) and its target volume. */
const DB_SETUP_SERVICE = 'db-setup';
const DB_TARGET_VOLUME = 'crewflow-db-target';
const DB_TARGET_DIR = '/run/crewflow/db-target';
const APP_SERVICES = Object.freeze(['rab-api', 'rab-worker']);
// The layout that works on Debian postgres 16, 17 AND 18 as uid 999 (a fresh volume takes the ownership of the image
// directory it is mounted on): the data volume on /var/lib/postgresql (postgres-owned in every major), the CA on /var/tmp
// (sticky world-writable in every major). /var/lib/postgresql/data, 16/17's VOLUME, is an empty read-only tmpfs.
const DB_VOLUMES = Object.freeze({ '/var/lib/postgresql': 'crewflow-db-data', '/var/tmp': DB_CA_VOLUME });
const DB_PGDATA = '/var/lib/postgresql/pgdata';
/** initdb authentication: SCRAM for socket and TCP (the image default trusts loopback TCP; peer lets any uid-999 process in). */
const DB_INITDB_AUTH = Object.freeze(['--auth-local=scram-sha-256', '--auth-host=scram-sha-256']);
/** The exact initdb arguments (SCRAM for the cluster's own pg_hba.conf, data checksums). */
const DB_INITDB_ARGS = `${DB_INITDB_AUTH.join(' ')} --data-checksums`;
/** The bundled db's whole environment: these keys and no other (PR #125 review, finding 6). */
const DB_ENV_KEYS = Object.freeze(['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD', 'POSTGRES_INITDB_ARGS', 'PGDATA', 'HOME']);
/** PR #125 review, finding 5: the server reads the pg_hba.conf the entrypoint writes on every start, TLS-only for TCP. */
const DB_HBA_FILE = '/var/lib/postgresql/tls/pg_hba.conf';
const DB_HBA_PRINTF = "printf 'local all all scram-sha-256\\nhostssl all all 0.0.0.0/0 scram-sha-256\\nhostssl all all ::/0 scram-sha-256\\n' > /var/lib/postgresql/tls/pg_hba.conf.new";
/** The bundled db's image: the official postgres repository, by digest (the committed default is the postgres:16 index). */
const DB_IMAGE = /^(docker\.io\/)?(library\/)?postgres@sha256:[0-9a-f]{64}$/;
const MIN_FRESH_INSTALL_START_PERIOD_S = 600;
const MIN_WORKER_STOP_GRACE_S = 45;
const MIN_API_STOP_GRACE_S = 40; // owner decision 2026-11-11 (deploy exactly like Twenty)

// Synthetic markers the check plants (not credentials).
const SENTINEL_OWNER_PW = 'SENTINEL-OWNER-LOGIN-PW-5b8e31'; // gitleaks:allow
const SENTINEL_URL = `postgresql://${OWNER_LOGIN}:${SENTINEL_OWNER_PW}@db-direct.example:5432/crewflow?sslmode=verify-full`;
const SENTINEL_APP_SECRET = 'SENTINEL-OWNER-LOGIN-APP-SECRET-9d04aa'; // gitleaks:allow
const SENTINEL_REDIS_PW = 'SENTINEL-OWNER-LOGIN-REDIS-PW-41c7f2'; // gitleaks:allow
const SENTINEL_LEGACY_PW = 'SENTINEL-LEGACY-SEPARATED-PW-77aa10'; // gitleaks:allow
/** DB-SETUP: the bundled db's superuser password (compose.env), and the admin URL the committed default builds from it. */
const SENTINEL_DB_PW = 'SENTINELDBSUPERUSERPW4f20c19a7e3d5b8c'; // gitleaks:allow
const BUNDLED_URL = `postgresql://postgres:${SENTINEL_DB_PW}@db:5432/crewflow?sslmode=verify-full`;
/** The external combination: a provider admin URL in compose.env. */
const SENTINEL_ADMIN_PW = 'SENTINEL-EXTERNAL-ADMIN-PW-3c91e7'; // gitleaks:allow
const SENTINEL_ADMIN_URL = `postgresql://doadmin:${SENTINEL_ADMIN_PW}@db-direct.example:5432/crewflow?sslmode=verify-full`;
/** Every database credential the gate plants: none may appear anywhere in rab-api's or rab-worker's definition. */
const DB_CREDENTIAL_SENTINELS = Object.freeze([SENTINEL_DB_PW, SENTINEL_ADMIN_PW, SENTINEL_OWNER_PW]);

/** Names no service and no env file may carry (exact). */
const FORBIDDEN_NAMES = Object.freeze([
  'DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX', 'CREWFLOW_DB_MODE',
  'CREWFLOW_PROVISIONER_DATABASE_URL', 'CREWFLOW_MIGRATION_DATABASE_URL', 'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL',
  'PG_WORKER_DATABASE_URL', 'PG_OPS_APP_DATABASE_URL', 'POSTURE_DATABASE_URL', 'DRIFT_DATABASE_URL', 'BENCH_DATABASE_URL',
  'CREWFLOW_MIGRATION_APPROVED', 'CREWFLOW_MIGRATION_PHASE', 'CREWFLOW_MIGRATOR_PASSWORD',
  'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP', 'ALLOW_PRODUCTION_DB_COMMANDS', 'DB_TARGET', 'ALLOW_REMOTE_TEST_DATABASE',
  'NODE_OPTIONS', 'CREWFLOW_PROVISIONER_ENABLED', 'WORKER_CLAIM_MODE', 'WORKER_DISPATCH_MODE',
  'WORKER_INVITE_AUTO_DELETE_ENABLED', 'WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED', 'PGCONNECT_TIMEOUT',
  'CREWFLOW_UPGRADE_INCOMPLETE', 'CREWFLOW_UPGRADE_FAILURE_POLICY',
]);
/** [pattern, reason] for whole families of forbidden names. */
const FORBIDDEN_PATTERNS = Object.freeze([
  [/^PG[A-Z]+$/, 'a libpq variable (overrides parts of the connection outside the one URL)'],
  [/REPLICA/, 'a read-replica setting (there is exactly one database URL)'],
  [/DATABASE_URL$/, 'a second database URL (there is exactly one: PG_DATABASE_URL)'],
  [/^TEST_/, 'a test-only variable'],
  // Security review L1: the start scripts' and the bootstrap child's test seams (NODE_ENV=test only) never belong in a
  // compose or env file (CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS, CREWFLOW_TEST_OWNER_SETUP_ABORT, ...).
  [/^CREWFLOW_TEST_/, 'a test seam (NODE_ENV=test only; never in a compose or env file)'],
  // Twenty Helm model (OWNER-DB-FINAL.md Part A): the crewflow_owner password lives ONLY in db-setup's password file
  // (/run/crewflow/db-target/owner-password); never a variable in any compose or env file.
  [/OWNER_PASSWORD|DB_PASSWORD_FILE|OWNER_PW/, 'the crewflow_owner password (it lives only in db-setup\'s password file on its volume, never in a variable)'],
  // Security re-review N4: the migration-harness seams (CREWFLOW_MIGRATION_TEST_*) likewise.
  [/^CREWFLOW_MIGRATION_TEST_/, 'a migration test seam (test harnesses only; never in a compose or env file)'],
  [/^(CREWFLOW_OPS_|PG_OPS_)/, 'a retired separated-mode operations variable (rab-ops was removed; never valid)'],
  [/^CREWFLOW_.*BOOTSTRAP_PASSWORD$/, 'a role password (role passwords never belong in app config)'],
  [/^BOOTSTRAP_ADMIN_/, 'bootstrap-admin input (a one-off operator command, never a runtime variable)'],
  [/^AUTH_.*_ISSUER_URL$/, 'a test-only issuer override'],
]);
const URL_KEY = 'PG_DATABASE_URL';
/** Keys the compose files commit; an env file must not re-enter them. */
const COMMITTED_KEYS = Object.freeze([
  'NODE_ENV', 'RAB_RUNTIME_ENV', 'CREWFLOW_MIGRATE_ON_START', 'DISABLE_DB_MIGRATIONS',
  'DISABLE_CRON_JOBS_REGISTRATION', 'CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS', 'CREWFLOW_RUNTIME_ISOLATION', 'AI_ENABLED',
  'HWS_RUNTIME_ENABLED', 'STORAGE_DRIVER', 'STORAGE_KEY_PREFIX', 'S3_FORCE_PATH_STYLE', 'S3_SERVER_SIDE_ENCRYPTION',
  'WORKER_SCHEDULER', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CREWFLOW_INSTANCE_HEALTH_FILE',
  'WORKER_FAST_PUBLISH_NOTIFY', 'WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS',
  'WORKER_TIMER_TRIGGERS', 'WORKER_TIMER_TRIGGER_KINDS', 'WORKER_OFFER_EXPIRY_INTERVAL_SECONDS',
  'WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS', 'WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS',
  'WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS',
]);
/**
 * Notification delivery (owner decision 2026-11-06), committed on rab-api AND rab-worker with exactly these rendered values:
 *  - WORKER_FAST_PUBLISH_NOTIFY=true: notify()'s email (and, once PUSH_ENABLED=true, push) rows are published right after
 *    the transaction commits (NotifyFastPublishService); the dispatcher stays the safety net. Read wherever notify() runs,
 *    so both processes.
 *  - WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS=30 (code default 2, bounds 1-60): the API's register-schedulers step sets the
 *    BullMQ scheduler's `every` from ITS value; the consume-only Worker's read-only verify checks only that the scheduler
 *    exists, never its interval, so a different Worker value would go unnoticed. Hence one value, identical on both.
 * The code defaults (false / 2 s) stay for development and tests. Push and realtime sweeps are not committed (2 s default).
 * compose-owner-login.test.cjs re-reads the TypeScript source and fails when 30 leaves the code's bounds.
 */
const NOTIFICATION_DELIVERY = Object.freeze({ WORKER_FAST_PUBLISH_NOTIFY: 'true', WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS: '30' });
/**
 * Phase D switches (owner decision 2026-11-06), committed on rab-api AND rab-worker with exactly these rendered values:
 *  - WORKER_TIMER_TRIGGERS=on with all four kinds LISTED (offer-expiry, manager-confirmation, no-show, late-clock-in), so a
 *    kind added to the code later is never switched on by an unset list. The API arms the offer triggers and the Worker
 *    consumes them and arms no-show / late clock-in, so both carry the same values. No-show and late clock-in touch
 *    attendance and payroll: the owner decided them explicitly (THREAT-MODEL, evidence: the 336-decision shadow run).
 *  - the scans stay as safety sweeps: offer expiry 300 s (code default 60, bounds 10-300), manager confirmation 120 s
 *    (60, 10-300), late clock-in 300 s (120, 30-600). As for the email sweep, the API registers each BullMQ scheduler
 *    with ITS value and the consume-only Worker never compares intervals, hence one value, identical on both.
 * compose-owner-login.test.cjs re-reads the TypeScript source and fails when a value leaves the code's bounds or kinds.
 */
const PHASE_D_SWITCHES = Object.freeze({
  WORKER_TIMER_TRIGGERS: 'on',
  WORKER_TIMER_TRIGGER_KINDS: 'offer-expiry,manager-confirmation,no-show,late-clock-in',
  WORKER_OFFER_EXPIRY_INTERVAL_SECONDS: '300',
  WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS: '120',
  WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS: '300',
});
/**
 * Owner decision 2026-11-06: values that stay at the code default in production. They are not committed; neither the
 * compose files nor an env file may set them to anything else. The shift monitor (300 s) also sends the clock-in reminders
 * and arms the no-show / late clock-in triggers; the combined shift scan (D-Q4a) stays off until it is measured.
 */
const PHASE_D_UNCHANGED = Object.freeze({ WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: '300', WORKER_SHIFT_SCAN_MODE: 'separate' });
/**
 * Pay-statement dispatch (owner decision 2026-11-11, Phase X J1a), committed on rab-api AND rab-worker with exactly this
 * rendered value: the sweep that discovers approved pay records whose statement is pending runs every 30 s (code default
 * 5 s, bounds 1-300) instead of every 5 s per workspace. A statement is then generated 0-30 s after approval; the 10-minute
 * lease recovery and the failed-retry backoff each gain at most 25 s. Payroll rules, core.payroll_record_guard, the
 * generation fence and the consumer are untouched. As for the email sweep, the API registers the BullMQ scheduler with ITS
 * value and the consume-only Worker never compares intervals, hence one value, identical on both. The code default stays
 * for development and tests. compose-owner-login.test.cjs re-reads the TypeScript source and fails when 30 leaves the
 * code's bounds.
 */
const STATEMENT_DISPATCH = Object.freeze({ WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS: '30' });
/**
 * Phase X J2 (S0-J SJ-03): the push and realtime sweep rule, enforced the moment the feature is switched on. Both switches
 * are off in production and live in runtime.env (both services read it). Before J2 the rule was a compose comment only, so
 * turning push on through runtime.env silently gave a 2 s push sweep (the code default).
 *  - PUSH_ENABLED=true: the owner rule (2026-11-06) - push's immediate send is WORKER_FAST_PUBLISH_NOTIFY (already true)
 *    and its sweep goes to 30 s, COMMITTED on rab-api AND rab-worker (the API registers the scheduler with ITS value; the
 *    consume-only Worker never compares intervals).
 *  - REALTIME_ENABLED=true: no owner value exists yet (realtime has no immediate path, so its sweep interval IS the live
 *    latency; choosing it is a separate owner decision). The gate requires only what correctness needs: the same value on
 *    both services (unset on both = the 2 s code default on both). `value: null` = not pinned.
 * Either switch must be identical on both services, and neither interval may be set in an env file (commit it).
 */
const FEATURE_SWEEPS = Object.freeze({
  PUSH_ENABLED: Object.freeze({ key: 'WORKER_PUSH_DISPATCH_INTERVAL_SECONDS', value: '30', decision: 'owner rule 2026-11-06' }),
  REALTIME_ENABLED: Object.freeze({ key: 'WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS', value: null, decision: 'value not yet decided by the owner' }),
});
/** The environment's own parse (`@Transform(({ value }) => value === 'true')`): only the exact string true switches it on. */
const switchedOn = (v) => String(v ?? '') === 'true';
/** The only values a feature switch may carry (after Compose's own normalisation); anything else is refused (fail closed). */
const SWITCH_VALUES = Object.freeze(['true', 'false']);

/**
 * The value Docker Compose gives a service for one env-file value (the text after `KEY=`), so the gate reads what the app
 * reads (review J2-1: `PUSH_ENABLED=true # on` reaches the app as "true"):
 *  - "double" or 'single' quoted: the text between the quotes; after the closing quote only blanks or a `#` comment;
 *  - unquoted: everything before the first blank-then-`#` (that starts a comment), trimmed; `a#b` stays `a#b`.
 * Returns null when the value cannot be read unambiguously (an unterminated quote, text after the closing quote): callers
 * that decide something from the value (the feature switches) fail closed on null.
 */
function composeEnvValue(raw) {
  const v = String(raw ?? '').trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end < 0) return null;
    const rest = v.slice(end + 1).trim();
    return rest === '' || rest.startsWith('#') ? v.slice(1, end) : null;
  }
  const comment = v.search(/\s#/);
  return (comment >= 0 ? v.slice(0, comment) : v).trim();
}

/**
 * Problems of the J2 rule on the rab-api and rab-worker environments (pure; variable names and the rule's own values only,
 * never a secret).
 */
function featureSweepProblems(apiEnv = {}, workerEnv = {}) {
  const problems = [];
  for (const [flag, rule] of Object.entries(FEATURE_SWEEPS)) {
    // Fail closed (review J2-1): a switch the service receives must be exactly true or false (Compose already normalised it).
    for (const [name, e] of [['rab-api', apiEnv], ['rab-worker', workerEnv]]) {
      if (e[flag] !== undefined && !SWITCH_VALUES.includes(String(e[flag]))) problems.push(`${name}: ${flag} must be exactly true or false`);
    }
    const apiOn = switchedOn(apiEnv[flag]);
    const workerOn = switchedOn(workerEnv[flag]);
    if (apiOn !== workerOn) problems.push(`${flag} differs between rab-api and rab-worker (both read it from runtime.env; one value)`);
    if (!apiOn && !workerOn) continue;
    if (rule.value !== null) {
      for (const [name, e] of [['rab-api', apiEnv], ['rab-worker', workerEnv]]) {
        if (String(e[rule.key] ?? '') !== rule.value) {
          problems.push(`${name}: ${flag}=true needs ${rule.key}="${rule.value}" committed in the compose files (${rule.decision}); it is "${e[rule.key] ?? ''}"`);
        }
      }
    } else if (String(apiEnv[rule.key] ?? '') !== String(workerEnv[rule.key] ?? '')) {
      problems.push(`${flag}=true: ${rule.key} differs between rab-api and rab-worker (the API registers the scheduler with its own value; the Worker never compares)`);
    }
  }
  return problems;
}
// DB-SETUP: PG_DATABASE_URL left database.env: it is an interpolation value of compose.env (rab-api's and rab-worker's
// committed ${PG_DATABASE_URL:-<bundled db>} would silently override an env-file value).
const DATABASE_ALLOWED = Object.freeze([
  'PG_SSL_CA_CERT_PATH', 'PG_EXPECTED_DATABASE_NAME', 'CREWFLOW_DEPLOYMENT_ENVIRONMENT', 'CREWFLOW_DEPLOYMENT_ID',
]);
/** DB-SETUP: the only non-CREWFLOW_* names compose.env may hold (the one database setting and the bundled db's password). */
const COMPOSE_DATABASE_KEYS = Object.freeze([URL_KEY, DB_PASSWORD_KEY]);
/**
 * BC-11 opt-ins: database.env only (so rab-api and rab-worker see one value), never committed in compose. O3: the approval
 * mode is no longer one of them (below).
 */
const DATABASE_OPT_INS = Object.freeze(['CREWFLOW_DEPLOYMENT_ENVIRONMENT', 'CREWFLOW_DEPLOYMENT_ID']);
/**
 * O3 + BC-11/C4: the approval mode is an INTERPOLATION value of compose.env (none by default, token an opt-in), committed on
 * rab-api as exactly this expression. In database.env / runtime.env it would be silently overridden by that line.
 */
const APPROVAL_MODE_KEY = 'CREWFLOW_MIGRATION_APPROVAL_MODE';
const APPROVAL_MODE_EXPR = '${CREWFLOW_MIGRATION_APPROVAL_MODE:-none}';
const APPROVAL_MODES = Object.freeze(['none', 'token']);
/**
 * BC-07: the external security audit sink, required in production by security-audit-sink.ts (securityAuditSinkConfig).
 * The values are the code's own: CREWFLOW_AUDIT_SINK none | stdout | file, of which production accepts only stdout;
 * CREWFLOW_AUDIT_SINK_FAILURE refuse | log, of which production accepts only refuse (unset = refuse);
 * CREWFLOW_AUDIT_SINK_FILE only with file (development). compose-owner-login.test.cjs re-reads the TypeScript source and
 * fails when these lists drift from it. It lives in runtime.env (rab-api and rab-worker both start the sink), never
 * committed in a compose file: the operator chooses it explicitly.
 */
const AUDIT_SINK_KEY = 'CREWFLOW_AUDIT_SINK';
const AUDIT_SINK_MODES = Object.freeze(['none', 'stdout', 'file']);
const AUDIT_SINK_PRODUCTION_MODES = Object.freeze(['stdout']);
const AUDIT_SINK_FAILURES = Object.freeze(['refuse', 'log']);
const AUDIT_SINK_PRODUCTION_FAILURES = Object.freeze(['refuse']);
/** O3 C3: what runtime.env may set for the upgrade-failure policy (unset = continue). */
const UPGRADE_FAILURE_VALUES = Object.freeze(['continue', 'refuse']);
/**
 * The former separated runtime logins and schema roles: never the PG_DATABASE_URL login (they are NOLOGIN schema roles or
 * cannot create roles, so they are neither crewflow_owner nor an admin). DB-SETUP T-1 relaxes ONLY the provider admin
 * logins (postgres, neondb_owner, doadmin, the RDS master, ...): PG_DATABASE_URL is now the database ADMIN URL.
 */
const NOT_THE_APP_LOGIN = Object.freeze([
  'crewflow', 'crewflow_app', 'crewflow_worker', 'crewflow_migrator', 'rab_owner', 'rab_secure_owner', 'rab_app',
]);
/** The bundled db's superuser password: interpolated into a URL, so URL-safe characters only, and long. */
const DB_PASSWORD_SHAPE = /^[A-Za-z0-9._~-]{32,}$/;
const POOLER_HINTS = Object.freeze([[/-pooler\./i, 'Neon -pooler host'], [/:6543(\/|$)/, 'port 6543 (Supabase pooler)'],
  [/:25061(\/|$)/, 'port 25061 (DigitalOcean pool)'], [/:6432(\/|$)/, 'port 6432 (PgBouncer)'], [/\.proxy-[a-z0-9]+\.rds\.amazonaws\.com/i, 'RDS Proxy']]);
const DIGEST_REF = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

/** First reason a NAME is forbidden for any service or env file, or null. */
function forbiddenReason(name) {
  if (name === URL_KEY) return null;
  if (name === DB_PASSWORD_KEY) return 'an interpolation value of compose.env only (the bundled db and the default admin URL); never a container variable or an env file entry';
  if (name === 'CREWFLOW_MIGRATION_APPROVED') return 'the approval token (O3: approval mode none; there is no token to pass)';
  if (name === 'CREWFLOW_UPGRADE_INCOMPLETE') return 'set only by api-prestart.sh after a failed upgrade (an inherited value is refused at start)';
  if (name === 'CREWFLOW_UPGRADE_FAILURE_POLICY') return 'deprecated (O3 C3): use CREWFLOW_UPGRADE_FAILURE=continue|refuse in runtime.env, or leave it unset (continue)';
  if (name === 'CREWFLOW_DB_MODE') return 'there is no mode switch (the owner login is the only architecture)';
  if (FORBIDDEN_NAMES.includes(name)) return 'forbidden (migration/bootstrap/ops/command authority, a second database identity, or an unapproved switch)';
  for (const [pattern, why] of FORBIDDEN_PATTERNS) if (pattern.test(name)) return why;
  return null;
}

const isPgUrl = (v) => /postgres(ql)?:\/\//i.test(String(v ?? ''));

/** Seconds from a compose duration ("45s", "15m0s", "1h2m3s", "1m30.5s"); NaN when unparseable. */
function durationSeconds(value) {
  if (value === undefined || value === null) return NaN;
  if (typeof value === 'number') return value / 1e9;
  const text = String(value).trim();
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text);
  if (!m || text === '') return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

// ------------------------------------------------------------------------------------------------- rendered-model checks

/** Generic H1-H6 hardening of one service. */
function hardeningProblems(name, s, p, { longRunning }) {
  if ('build' in s) p(`${name}: has a build section (images by digest only; a host must never rebuild a release)`);
  if (!DIGEST_REF.test(String(s.image ?? ''))) p(`${name}: image is not pinned by digest (repository@sha256:<64 hex>)`);
  const user = String(s.user ?? '');
  const uid = user.split(':')[0];
  if (!user) p(`${name}: no explicit user (the image default may be root)`);
  else if (uid === '0' || !/^\d+$/.test(uid)) p(`${name}: user "${user}" is root or not numeric`);
  if (s.read_only !== true) p(`${name}: read_only root filesystem is not set`);
  if (!(Array.isArray(s.cap_drop) && s.cap_drop.includes('ALL'))) p(`${name}: cap_drop ALL is missing`);
  if (Array.isArray(s.cap_add) && s.cap_add.length) p(`${name}: adds capabilities (${s.cap_add.join(', ')})`);
  if (!(Array.isArray(s.security_opt) && s.security_opt.includes('no-new-privileges:true'))) p(`${name}: security_opt no-new-privileges:true is missing`);
  if (s.privileged === true) p(`${name}: privileged`);
  for (const ns of ['network_mode', 'pid', 'ipc', 'userns_mode', 'uts', 'cgroup']) if (String(s[ns] ?? '').startsWith('host')) p(`${name}: ${ns} is host`);
  if (Array.isArray(s.devices) && s.devices.length) p(`${name}: maps host devices`);
  if (!(Number(s.pids_limit) > 0)) p(`${name}: pids_limit is missing`);
  if (!(Number(s.mem_limit) > 0)) p(`${name}: mem_limit is missing`);
  if (!(Number(s.cpus) > 0)) p(`${name}: cpus limit is missing`);
  if (s.logging?.driver !== 'json-file' || !s.logging?.options?.['max-size']) p(`${name}: logging is not bounded (json-file with max-size)`);
  if (!(durationSeconds(s.stop_grace_period) > 0)) p(`${name}: stop_grace_period is missing`);
  for (const v of s.volumes ?? []) {
    if (/docker\.sock/.test(String(v.source ?? '')) || /docker\.sock/.test(String(v.target ?? ''))) p(`${name}: mounts the Docker socket`);
    if (v.type === 'bind' && v.read_only !== true) p(`${name}: bind mount to ${v.target} is writable (host binds must be read-only)`);
    const dbClient = [...APP_SERVICES, DB_SETUP_SERVICE].includes(name);
    const dbCaMount = dbClient && v.target === DB_CA_TARGET && v.source === DB_CA_VOLUME;
    const targetMount = dbClient && v.target === DB_TARGET_DIR && v.source === DB_TARGET_VOLUME;
    if (v.type === 'volume' && !((name === 'rab-redis' && v.target === '/data') || (name === DB_SERVICE && DB_VOLUMES[v.target] === v.source) || dbCaMount || targetMount)) {
      p(`${name}: unexpected named volume at ${v.target}`);
    }
    if (v.type === 'volume' && dbCaMount && v.read_only !== true) p(`${name}: the bundled db's CA volume must be mounted read-only`);
    // Twenty Helm model: db-setup's volume holds the crewflow_owner password file. Nothing but that named volume may be
    // mounted at (or under) its path, and only on db-setup (read-write) and rab-api / rab-worker (read-only).
    const mountTarget = String(v.target ?? '');
    if ((mountTarget === DB_TARGET_DIR || mountTarget.startsWith(`${DB_TARGET_DIR}/`)) && !(v.type === 'volume' && targetMount)) {
      p(`${name}: mounts something at ${mountTarget} (db-setup's volume holds the crewflow_owner password file: only the ${DB_TARGET_VOLUME} named volume, on db-setup read-write and rab-api / rab-worker read-only)`);
    }
    // Option A: only db-setup writes the target file; rab-api and rab-worker read it.
    if (v.type === 'volume' && targetMount && name !== DB_SETUP_SERVICE && v.read_only !== true) p(`${name}: db-setup's target volume must be mounted read-only`);
    if (v.type === 'volume' && targetMount && name === DB_SETUP_SERVICE && v.read_only === true) p(`${name}: the target volume must be writable here (db-setup writes the target file)`);
  }
  for (const port of s.ports ?? []) {
    if (name !== 'rab-api') p(`${name}: publishes a port (only rab-api may, on loopback)`);
    const hostIp = String(port.host_ip ?? '');
    if (hostIp === '' || hostIp === '0.0.0.0' || hostIp === '::') p(`${name}: port ${port.target} is published on every interface`);
  }
  if (longRunning) {
    if (s.restart !== 'unless-stopped') p(`${name}: restart is "${s.restart}", expected unless-stopped`);
    const hc = s.healthcheck;
    if (!hc || hc.disable === true || !Array.isArray(hc.test) || hc.test.length === 0 || hc.test[0] === 'NONE') p(`${name}: no health check`);
  }
}

/**
 * DB-SETUP: the bundled PostgreSQL `db` (owner decisions D1 a / D3 / D4). Pure. T-2: POSTGRES_PASSWORD comes from
 * PG_DATABASE_PASSWORD (an env var, like Twenty: OpenShip has no secret files). T-3: the image's default pg_hba (the
 * bootstrap child logs in over the internal network as the superuser). Everything else of the retired local-db rules holds:
 * H1-H6 hardening, digest, no port, internal network only, TLS on (verify-full clients), never trust, no database URL, the
 * superuser never crewflow_owner.
 */
function bundledDbProblems(services, model, p) {
  const db = services[DB_SERVICE];
  if (!db) { p(`${DB_SERVICE}: missing (the bundled database)`); return; }
  hardeningProblems(DB_SERVICE, db, p, { longRunning: true });
  // PR #124's rule for every deploy service: no profile (a profile-gated db would not start with the stack, or would hide).
  if (Array.isArray(db.profiles) && db.profiles.length) p(`${DB_SERVICE}: has profiles (it would not start with the stack)`);
  if (!DB_IMAGE.test(String(db.image ?? ''))) p(`${DB_SERVICE}: image is not the official postgres repository pinned by digest (postgres@sha256:<64 hex>)`);
  for (const msg of bundledDbEnvironmentProblems(db.environment ?? {}, { expectedPassword: SENTINEL_DB_PW })) p(msg);
  const cmd = (db.command ?? []).map(String);
  if (!cmd.includes(`hba_file=${DB_HBA_FILE}`)) p(`${DB_SERVICE}: the server does not read the TLS-only pg_hba.conf the entrypoint writes (hba_file=${DB_HBA_FILE})`);
  if (!cmd.includes('ssl=on')) p(`${DB_SERVICE}: TLS is not on (verify-full clients need it)`);
  if (!cmd.includes('ssl_cert_file=/var/lib/postgresql/tls/server.crt') || !cmd.includes('ssl_key_file=/var/lib/postgresql/tls/server.key')) p(`${DB_SERVICE}: TLS does not use the certificate it makes itself (data volume tls/)`);
  const dbTmpfs = (db.tmpfs ?? []).map(String);
  if (!dbTmpfs.some((t) => /^\/var\/lib\/postgresql\/data:/.test(t) && /mode=0?555\b/.test(t))) p(`${DB_SERVICE}: /var/lib/postgresql/data (the 16/17 images' VOLUME) is not an empty read-only tmpfs`);
  // `docker compose config` keeps a literal $ escaped as $$ in its output.
  const entry = (db.entrypoint ?? []).map(String).join('\n').split('$$').join('$');
  if (!/openssl req -x509/.test(entry) || !/subjectAltName=DNS:db/.test(entry) || !/rm -f ca\.key/.test(entry) || !/exec docker-entrypoint\.sh "\$@"/.test(entry)) {
    p(`${DB_SERVICE}: the entrypoint does not create its own CA and server certificate (SAN db, CA key deleted) before the image's entrypoint (D1 a)`);
  }
  if (!entry.includes(DB_HBA_PRINTF) || /\bhost(nossl)?\s+all\b/.test(entry) || /\b(trust|peer|ident|md5)\b/.test(entry)) {
    p(`${DB_SERVICE}: the entrypoint does not write exactly the TLS-only pg_hba.conf (local scram-sha-256; hostssl scram-sha-256 for every TCP login; no plain host, trust, peer, ident or md5)`);
  }
  if ((db.volumes ?? []).some((v) => String(v.target ?? '').startsWith('/docker-entrypoint-initdb.d'))) p(`${DB_SERVICE}: mounts an init script (the API creates crewflow_owner itself)`);
  if (JSON.stringify(Object.keys(db.networks ?? {})) !== JSON.stringify(['crewflow-db'])) p(`${DB_SERVICE}: must be on the internal crewflow-db network only`);
  if (model?.networks?.['crewflow-db']?.internal !== true) p('network crewflow-db is not internal');
  for (const target of Object.keys(DB_VOLUMES)) if (!(db.volumes ?? []).some((v) => v.type === 'volume' && v.target === target)) p(`${DB_SERVICE}: named volume ${DB_VOLUMES[target]} at ${target} is missing`);
  const hc = (db.healthcheck?.test ?? []).map(String).join(' ');
  if (!/pg_isready/.test(hc) || !/-h localhost/.test(hc)) p(`${DB_SERVICE}: health check is not pg_isready over TCP (the first-start init server is socket-only)`);
  if (services['rab-api'] && services['rab-api'].depends_on?.[DB_SERVICE]?.condition !== 'service_healthy') p(`rab-api: does not wait for a healthy ${DB_SERVICE}`);
  for (const name of ['rab-api', 'rab-worker']) {
    if (!services[name]) continue;
    if (!Object.keys(services[name].networks ?? {}).includes('crewflow-db')) p(`${name}: is not on the crewflow-db network`);
    if (!(services[name].volumes ?? []).some((v) => v.type === 'volume' && v.source === DB_CA_VOLUME && v.target === DB_CA_TARGET && v.read_only === true)) {
      p(`${name}: does not mount the bundled db's CA read-only at ${DB_CA_TARGET}`);
    }
    if (!(services[name].volumes ?? []).some((v) => v.type === 'volume' && v.source === DB_TARGET_VOLUME && v.target === DB_TARGET_DIR && v.read_only === true)) {
      p(`${name}: does not mount db-setup's target volume read-only at ${DB_TARGET_DIR}`);
    }
  }
  for (const [name, svc] of Object.entries(services)) {
    if (name !== DB_SERVICE && (svc.volumes ?? []).some((v) => v.type === 'volume' && v.source === 'crewflow-db-data')) p(`${name}: mounts the bundled db's data volume (its cluster and TLS key)`);
  }
}

/**
 * PR #125 option 2: the one-shot db-setup service, the ONLY service that receives PG_DATABASE_URL (admin or crewflow_owner).
 * Pure. `wantUrl`: the PG_DATABASE_URL it must render (the bundled default, compose.env's admin URL, or a crewflow_owner
 * URL in pass-through).
 */
function dbSetupProblems(services, p, wantUrl) {
  const s = services[DB_SETUP_SERVICE];
  if (!s) { p(`${DB_SETUP_SERVICE}: missing (the one-shot database setup; option 2)`); return; }
  const api = services['rab-api'] ?? {};
  hardeningProblems(DB_SETUP_SERVICE, s, p, { longRunning: false });
  if (Array.isArray(s.profiles) && s.profiles.length) p(`${DB_SETUP_SERVICE}: has profiles (it would not run with the stack, and rab-api would wait for it in vain)`);
  if (s.image !== api.image) p(`${DB_SETUP_SERVICE}: image differs from rab-api (O2: one image; the same bootstrap child)`);
  if (JSON.stringify(s.entrypoint ?? null) !== JSON.stringify(['./db-setup.sh'])) p(`${DB_SETUP_SERVICE}: entrypoint is not exactly ./db-setup.sh`);
  if (Array.isArray(s.command) ? s.command.length > 0 : (s.command !== undefined && s.command !== null)) p(`${DB_SETUP_SERVICE}: has a command (db-setup.sh takes none)`);
  if (s.init === true) p(`${DB_SETUP_SERVICE}: init: true (no compose init: the script runs as PID 1 and exits)`);
  if (s.restart !== 'no') p(`${DB_SETUP_SERVICE}: restart is "${s.restart ?? ''}", expected "no" (a one-shot: it exits after the setup)`);
  if ((s.ports ?? []).length) p(`${DB_SETUP_SERVICE}: publishes a port`);
  if (s.user !== '1000:1000') p(`${DB_SETUP_SERVICE}: user is "${s.user ?? ''}", expected 1000:1000 (it writes the target file rab-api and rab-worker read as uid 1000)`);
  const replicas = s.deploy?.replicas ?? s.scale;
  if (replicas !== undefined && Number(replicas) !== 1) p(`${DB_SETUP_SERVICE}: ${replicas} replicas (exactly one)`);
  if (!Object.keys(s.networks ?? {}).includes('crewflow-db')) p(`${DB_SETUP_SERVICE}: is not on the crewflow-db network`);
  const vols = s.volumes ?? [];
  if (!vols.some((v) => v.type === 'volume' && v.source === DB_CA_VOLUME && v.target === DB_CA_TARGET && v.read_only === true)) p(`${DB_SETUP_SERVICE}: does not mount the bundled db's CA read-only at ${DB_CA_TARGET}`);
  if (!vols.some((v) => v.type === 'volume' && v.source === DB_TARGET_VOLUME && v.target === DB_TARGET_DIR && v.read_only !== true)) p(`${DB_SETUP_SERVICE}: does not mount the target volume writable at ${DB_TARGET_DIR}`);
  const deps = s.depends_on ?? {};
  if (JSON.stringify(Object.keys(deps)) !== JSON.stringify([DB_SERVICE]) || deps[DB_SERVICE]?.condition !== 'service_healthy') p(`${DB_SETUP_SERVICE}: depends_on must be exactly a healthy ${DB_SERVICE}`);
  const env = s.environment ?? {};
  if (env[URL_KEY] !== wantUrl) p(`${DB_SETUP_SERVICE}: ${URL_KEY} is not the committed \${PG_DATABASE_URL:-<bundled db>} (compose.env's value, or the bundled db's admin URL)`);
  if (env.NODE_ENV !== 'production') p(`${DB_SETUP_SERVICE}: NODE_ENV is not production`);
  if (env.RAB_RUNTIME_ENV !== 'production') p(`${DB_SETUP_SERVICE}: RAB_RUNTIME_ENV is not production`);
  // Twenty Helm model: APP_SECRET is never part of a database credential; db-setup does not receive it (db-setup.sh refuses it).
  if ('APP_SECRET' in env) p(`${DB_SETUP_SERVICE}: has APP_SECRET (never part of a database credential; db-setup must not receive it)`);
  const setupFiles = (s.env_file ?? []).map((e) => String(typeof e === 'string' ? e : e.path ?? ''));
  if (setupFiles.some((f) => /(^|\/)runtime\.env$/.test(f))) p(`${DB_SETUP_SERVICE}: reads runtime.env (it needs only database.env: no runtime secret reaches db-setup)`);
  if (api.depends_on?.[DB_SETUP_SERVICE]?.condition !== 'service_completed_successfully') p(`rab-api: does not wait for ${DB_SETUP_SERVICE} (depends_on: condition: service_completed_successfully)`);
  for (const [name, svc] of Object.entries(services)) {
    if (name !== 'rab-api' && name !== 'rab-worker' && name !== DB_SETUP_SERVICE && (svc.volumes ?? []).some((v) => v.source === DB_TARGET_VOLUME)) p(`${name}: mounts db-setup's target volume`);
  }
}

/**
 * PR #125 option 2: rab-api and rab-worker never receive a PG_DATABASE_URL value, in ANY form: the key is pinned to the
 * literal empty string (so an env-file value cannot reach them; never `${PG_DATABASE_URL...}`, checked on the raw text by
 * lintComposeText), and NOTHING in their whole rendered definition (environment, health check, entrypoint, command, labels,
 * an overlay's additions) holds the bundled db's password, an admin password, a crewflow_owner password or a postgres://
 * value. They build the crewflow_owner URL from db-setup's target file. Pure.
 */
function appCredentialProblems(services, p) {
  for (const name of APP_SERVICES) {
    const s = services[name];
    if (!s) continue;
    const env = s.environment ?? {};
    if (!(URL_KEY in env)) p(`${name}: ${URL_KEY} is not pinned to "" (an env-file value would reach it; option 2)`);
    else if (env[URL_KEY] !== '') p(`${name}: ${URL_KEY} is not empty (option 2: only db-setup receives a database URL, in any form; the entrypoint refuses it)`);
    const text = JSON.stringify(s);
    if (DB_CREDENTIAL_SENTINELS.some((v) => text.includes(v))) p(`${name}: carries a database credential somewhere in its definition (environment, health check, command or labels; option 2: never)`);
    if (isPgUrl(text)) p(`${name}: holds a postgres:// value somewhere in its definition (option 2: never; the crewflow_owner URL is built from db-setup's target file)`);
  }
}

/**
 * The bundled db's environment rules (PR #125 review, finding 6), shared by this gate (committed model) and
 * staging/verify-image-compose.cjs (the deployed model). Pure; names and rules only, never a value. `expectedPassword`:
 * the gate's sentinel (exact match); without it (a real deployment) the password must be present and URL-safe.
 */
function bundledDbEnvironmentProblems(env, { expectedPassword } = {}) {
  const out = [];
  const p = (m) => out.push(`${DB_SERVICE}: ${m}`);
  for (const [k, v] of Object.entries(env)) {
    if (k === URL_KEY) p(`has ${URL_KEY}`);
    else if (k === 'POSTGRES_PASSWORD_FILE') p('POSTGRES_PASSWORD_FILE is set (one source: PG_DATABASE_PASSWORD)');
    else if (k === 'POSTGRES_HOST_AUTH_METHOD') p('POSTGRES_HOST_AUTH_METHOD is set (the image switch that can add trust / md5 lines; the entrypoint writes the pg_hba.conf)');
    else if (k !== 'PGDATA' && forbiddenReason(k)) p(`environment has ${k}`);
    else if (!DB_ENV_KEYS.includes(k)) p(`environment has ${k} (only ${DB_ENV_KEYS.join(', ')})`);
    if (isPgUrl(v)) p(`${k} holds a PostgreSQL URL`);
  }
  const superuser = String(env.POSTGRES_USER ?? '');
  if (superuser === OWNER_LOGIN) p('the superuser is the app login (crewflow_owner must never be a superuser)');
  else if (superuser !== 'postgres') p('POSTGRES_USER must be postgres (the default admin URL logs in as postgres)');
  if (String(env.POSTGRES_DB ?? '') !== 'crewflow') p('POSTGRES_DB must be crewflow');
  const password = String(env.POSTGRES_PASSWORD ?? '');
  if (expectedPassword !== undefined) {
    if (password !== expectedPassword) p(`POSTGRES_PASSWORD must be exactly \${${DB_PASSWORD_KEY}:?...} (T-2), nothing else`);
  } else if (!DB_PASSWORD_SHAPE.test(password)) p('POSTGRES_PASSWORD is missing or not 32+ URL-safe characters (PG_DATABASE_PASSWORD)');
  if (String(env.POSTGRES_INITDB_ARGS ?? '') !== DB_INITDB_ARGS) p(`POSTGRES_INITDB_ARGS must be exactly "${DB_INITDB_ARGS}" (SCRAM only: no trust, peer or md5)`);
  if (!('PGDATA' in env)) p(`PGDATA is not set (the image default differs per major; ${DB_PGDATA} for all)`);
  else if (env.PGDATA !== DB_PGDATA) p(`PGDATA must be ${DB_PGDATA} (in the data volume beside its TLS key; fixed for every major)`);
  if (String(env.HOME ?? '') !== '/tmp') p('HOME must be /tmp (the private tmpfs, never a volume)');
  return out;
}

/** Problems with one rendered FULL-mode combination (an entry of COMBOS). Pure: never prints a value. */
function checkModel(model, combo) {
  const problems = [];
  const p = (msg) => problems.push(`${combo.name}: ${msg}`);
  const services = model?.services ?? {};
  const names = Object.keys(services).sort();
  // O3: no rab-migrate (the API migrates on start).
  const expected = ['rab-api', 'rab-redis', 'rab-worker', DB_SERVICE, DB_SETUP_SERVICE].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) p(`services are [${names.join(', ')}], expected [${expected.join(', ')}]`);
  const appServices = APP_SERVICES;
  const setupUrl = combo.external === 'admin' ? SENTINEL_ADMIN_URL : combo.external === 'owner' ? SENTINEL_URL : BUNDLED_URL;

  for (const name of names) {
    if (name === DB_SERVICE) continue; // bundledDbProblems
    const s = services[name] ?? {};
    if (name !== DB_SETUP_SERVICE) hardeningProblems(name, s, p, { longRunning: true }); // db-setup: dbSetupProblems
    if (Array.isArray(s.profiles) && s.profiles.length) p(`${name}: has profiles (it would not start with the stack)`);
    const env = s.environment ?? {};
    for (const [key, value] of Object.entries(env)) {
      const why = forbiddenReason(key);
      if (why) p(`${name}: environment has ${key} (${why})`);
      if (key !== URL_KEY && isPgUrl(value)) p(`${name}: environment ${key} holds a PostgreSQL URL (a second database identity)`);
    }
    const values = Object.values(env).map(String);
    if (values.some((v) => v.includes(SENTINEL_LEGACY_PW))) p(`${name}: received a value from a separated-mode env file (.env.migrate / .env.ops / per-service staging files)`);
    if (name !== DB_SETUP_SERVICE && URL_KEY in env && !(appServices.includes(name) && env[URL_KEY] === '')) p(`${name}: has ${URL_KEY} (option 2: only db-setup; rab-api / rab-worker pin it empty)`);
    if (!appServices.includes(name) && values.some((v) => v.includes(SENTINEL_APP_SECRET) || v.includes(SENTINEL_REDIS_PW))) {
      p(`${name}: received a runtime secret (only rab-api and rab-worker read runtime.env; db-setup never)`);
    }
    // The crewflow_owner password: only db-setup, only in its PG_DATABASE_URL (pass-through), never another key.
    for (const [key, value] of Object.entries(env)) {
      if (String(value ?? '').includes(SENTINEL_OWNER_PW) && !(name === DB_SETUP_SERVICE && key === URL_KEY && combo.external === 'owner')) p(`${name}: received the database credential (${key})`);
      if (String(value ?? '').includes(SENTINEL_ADMIN_PW) && !(name === DB_SETUP_SERVICE && key === URL_KEY && combo.external === 'admin')) p(`${name}: received the database admin credential (${key})`);
    }
  }
  // Option 2: no PG_DATABASE_URL and no database credential anywhere in rab-api's or rab-worker's definition; db-setup's
  // exact shape.
  appCredentialProblems(services, p);
  dbSetupProblems(services, p, setupUrl);
  // DB-SETUP: the bundled db's password reaches only db (POSTGRES_PASSWORD) and, inside the default admin URL, db-setup's
  // PG_DATABASE_URL. Never under another key, never another service, never by its own name.
  for (const name of names) {
    for (const [key, value] of Object.entries(services[name]?.environment ?? {})) {
      if (key === DB_PASSWORD_KEY) p(`${name}: environment has ${DB_PASSWORD_KEY} (compose.env only; it never reaches a container)`);
      if (!String(value ?? '').includes(SENTINEL_DB_PW)) continue;
      const allowed = (name === DB_SERVICE && key === 'POSTGRES_PASSWORD') || (name === DB_SETUP_SERVICE && key === URL_KEY && !combo.external);
      if (!allowed) p(`${name}: ${key} carries the bundled db's password`);
    }
  }

  // BC-11: the deployment identity is an opt-in of database.env. The sentinel database.env sets none of it, so a value in
  // the rendered model was committed by a compose file and would override the operator's choice.
  for (const name of names) {
    const env = services[name]?.environment ?? {};
    for (const key of DATABASE_OPT_INS) if (key in env) p(`${name}: commits ${key} (an opt-in of database.env, never a compose value)`);
  }


  const api = services['rab-api'] ?? {};
  const worker = services['rab-worker'] ?? {};
  const redis = services['rab-redis'] ?? {};
  const envOf = (s) => s?.environment ?? {};
  for (const name of appServices) {
    const e = envOf(services[name]);
    const want = { NODE_ENV: 'production' };
    for (const [k, v] of Object.entries(want)) if (e[k] !== v) p(`${name}: ${k} is "${e[k] ?? ''}", expected "${v}"`);
    // O3 C3: the upgrade-failure policy is not committed (unset = continue); runtime.env may opt into refuse.
    if ('CREWFLOW_UPGRADE_FAILURE' in e && !UPGRADE_FAILURE_VALUES.includes(String(e.CREWFLOW_UPGRADE_FAILURE))) p(`${name}: CREWFLOW_UPGRADE_FAILURE must be continue or refuse`);
    // O3 C2: the scheduler mode is never committed (production defaults to bullmq; interval is refused there).
    if ('WORKER_SCHEDULER' in e) p(`${name}: commits WORKER_SCHEDULER (leave it unset: production runs bullmq; interval is refused)`);
  }
  for (const name of ['rab-api', 'rab-worker']) {
    const e = envOf(services[name]);
    // The long-running services refuse to start when a declared isolation control is missing (H6 enforce).
    if (e.CREWFLOW_RUNTIME_ISOLATION !== 'enforce') p(`${name}: CREWFLOW_RUNTIME_ISOLATION is "${e.CREWFLOW_RUNTIME_ISOLATION ?? ''}", expected "enforce"`);
    if (e.RAB_RUNTIME_ENV !== 'production') p(`${name}: RAB_RUNTIME_ENV is not production`);
    if (!String(e.APP_SECRET ?? '').includes(SENTINEL_APP_SECRET)) p(`${name}: does not read runtime.env (APP_SECRET missing)`);
    // BC-07: the sink must reach both services, as a production-accepted value.
    if (!AUDIT_SINK_PRODUCTION_MODES.includes(String(e[AUDIT_SINK_KEY] ?? ''))) p(`${name}: ${AUDIT_SINK_KEY} is "${e[AUDIT_SINK_KEY] ?? ''}", expected stdout (BC-07, from runtime.env)`);
    // Owner decision 2026-11-06: notification delivery, the same committed values on both services.
    for (const [key, want] of Object.entries(NOTIFICATION_DELIVERY)) {
      if (String(e[key] ?? '') !== want) p(`${name}: ${key} is "${e[key] ?? ''}", expected "${want}" (owner decision 2026-11-06, committed on rab-api and rab-worker)`);
    }
    // Owner decision 2026-11-06: the Phase D switches, the same committed values on both services.
    for (const [key, want] of Object.entries(PHASE_D_SWITCHES)) {
      if (String(e[key] ?? '') !== want) p(`${name}: ${key} is "${e[key] ?? ''}", expected "${want}" (owner decision 2026-11-06, Phase D switches, committed on rab-api and rab-worker)`);
    }
    for (const [key, keep] of Object.entries(PHASE_D_UNCHANGED)) {
      if (key in e && String(e[key]) !== keep) p(`${name}: ${key} is "${e[key]}"; the owner decision 2026-11-06 keeps it at ${keep} (leave it unset)`);
    }
    // Owner decision 2026-11-11 (J1a): the pay-statement sweep, the same committed value on both services.
    for (const [key, want] of Object.entries(STATEMENT_DISPATCH)) {
      if (String(e[key] ?? '') !== want) p(`${name}: ${key} is "${e[key] ?? ''}", expected "${want}" (owner decision 2026-11-11, pay-statement sweep, committed on rab-api and rab-worker)`);
    }
  }
  // The rule is "identical on both"; the per-service pin above implies it, and this names the drift directly.
  for (const key of Object.keys(STATEMENT_DISPATCH)) {
    const a = envOf(services['rab-api'])[key];
    const w = envOf(services['rab-worker'])[key];
    if (services['rab-api'] && services['rab-worker'] && String(a ?? '') !== String(w ?? '')) p(`${key} differs between rab-api and rab-worker (one identical value: the API registers the scheduler, the Worker never compares)`);
  }

  // Phase X J2 (SJ-03): the push / realtime sweep rule once a feature is on.
  for (const msg of featureSweepProblems(envOf(api), envOf(worker))) p(msg);

  // rab-api: the lifecycle.
  const apiEnv = envOf(api);
  // DB-SETUP PID 1 (lead decision 2026-11-12): api-prestart.sh is the ENTRYPOINT (PID 1); it cleans the environment and only
  // then execs the image's tini, so no process of the container keeps the admin URL. No command (the script refuses none,
  // but a command would turn every start into a one-off) and no compose init (docker-init at PID 1 keeps the container env).
  if (JSON.stringify(api.entrypoint ?? null) !== JSON.stringify(['./api-prestart.sh'])) p('rab-api: entrypoint is not exactly ./api-prestart.sh (PID 1 must clean the environment before the init starts)');
  if (Array.isArray(api.command) ? api.command.length > 0 : (api.command !== undefined && api.command !== null)) p('rab-api: has a command (api-prestart.sh, the entrypoint, takes none: with arguments it runs a one-off, not the API)');
  if (api.init === true) p('rab-api: init: true (docker-init would be PID 1 with the container environment, i.e. the admin URL)');
  // O3 C1: the API migrates on start, without an approval token, with a start_period long enough for a fresh install.
  if (apiEnv.CREWFLOW_MIGRATE_ON_START !== 'true') p('rab-api: CREWFLOW_MIGRATE_ON_START must be "true" (O3: the API migrates on start)');
  if (!APPROVAL_MODES.includes(String(apiEnv[APPROVAL_MODE_KEY] ?? ''))) p(`rab-api: ${APPROVAL_MODE_KEY} must render as none or token (compose.env; default none)`);
  if (String(apiEnv.DISABLE_DB_MIGRATIONS ?? '') === 'true') p('rab-api: DISABLE_DB_MIGRATIONS=true (the API is the one process that migrates)');
  if (String(apiEnv.DISABLE_CRON_JOBS_REGISTRATION ?? '') === 'true') p('rab-api: DISABLE_CRON_JOBS_REGISTRATION=true (the API registers the job schedulers; nothing else does)');
  if (!(durationSeconds(api.healthcheck?.start_period) >= MIN_FRESH_INSTALL_START_PERIOD_S)) p(`rab-api: healthcheck start_period below ${MIN_FRESH_INSTALL_START_PERIOD_S}s (it migrates first)`);
  for (const [name, s] of Object.entries(services)) if (s.depends_on?.['rab-migrate']) p(`${name}: depends on rab-migrate (O3: there is no release step)`);
  // C5: ONE API, deployed stop-then-start (two versions starting together would race for the migration lock).
  const replicas = api.deploy?.replicas ?? api.scale;
  if (replicas !== undefined && Number(replicas) !== 1) p(`rab-api: ${replicas} replicas (O3 C5: exactly one API)`);
  if (api.deploy?.update_config?.order === 'start-first') p('rab-api: start-first update (O3 C5: stop-then-start only)');
  if (!(durationSeconds(api.stop_grace_period) >= MIN_API_STOP_GRACE_S)) p(`rab-api: stop_grace_period below ${MIN_API_STOP_GRACE_S}s`);
  if (api.depends_on?.['rab-redis']?.condition !== 'service_healthy') p('rab-api: does not wait for a healthy rab-redis');

  // rab-worker
  const workerEnv = envOf(worker);
  if (worker.user !== '1000:1000') p(`rab-worker: user is "${worker.user ?? ''}", expected 1000:1000`);
  // DB-SETUP T-5 + PID 1 (lead decision 2026-11-12): worker-start.sh is the ENTRYPOINT (PID 1); it swaps the admin URL for
  // the derived crewflow_owner URL and only then execs the image's tini, which runs the Worker as its child. Anything else
  // would start the Worker, or its init, with the admin URL in its environment.
  if (JSON.stringify(worker.entrypoint ?? null) !== JSON.stringify(['./worker-start.sh'])) p('rab-worker: entrypoint is not exactly ./worker-start.sh (the Worker and its init must never start with the admin URL; T-5)');
  if (Array.isArray(worker.command) ? worker.command.length > 0 : (worker.command !== undefined && worker.command !== null)) p('rab-worker: has a command (worker-start.sh, the entrypoint, takes none)');
  if (worker.working_dir !== '/app') p('rab-worker: working_dir is not /app');
  // The Worker's watchdog SIGKILLs itself when its event loop stalls; the kernel ignores that signal for PID 1, so the
  // Worker refuses to start as PID 1: worker-start.sh execs tini, which stays PID 1 with the Worker as its child. Compose's
  // init must NOT be used: docker-init would be PID 1 with the container environment (the admin URL) for the Worker's life.
  if (worker.init === true) p('rab-worker: init: true (docker-init would be PID 1 with the admin URL; worker-start.sh execs tini as PID 1 instead)');
  const tmpfs = (worker.tmpfs ?? []).map(String);
  for (const dir of ['/tmp/crewflow-jobs', '/run/crewflow-health/jobs']) if (!tmpfs.some((t) => t === dir || t.startsWith(`${dir}:`))) p(`rab-worker: tmpfs ${dir} is missing`);
  if (!tmpfs.every((t) => /uid=1000/.test(t) && /gid=1000/.test(t))) p('rab-worker: a tmpfs is not owned by 1000:1000');
  if (String(workerEnv.CREWFLOW_MIGRATE_ON_START ?? 'false') !== 'false') p('rab-worker: CREWFLOW_MIGRATE_ON_START is set (the Worker never migrates)');
  if (workerEnv.DISABLE_DB_MIGRATIONS !== 'true') p('rab-worker: DISABLE_DB_MIGRATIONS must be "true" (O3 C1: the Worker never migrates)');
  if (workerEnv.DISABLE_CRON_JOBS_REGISTRATION !== 'true') p('rab-worker: DISABLE_CRON_JOBS_REGISTRATION must be "true" (O3 C2: the API registers the schedulers; the Worker consumes them)');
  if (workerEnv.CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS !== '0') p('rab-worker: CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS must be "0" (it starts after a healthy API)');
  if (workerEnv.CREWFLOW_INSTANCE_HEALTH_FILE !== '/run/crewflow-health/jobs/heartbeat.json') p('rab-worker: CREWFLOW_INSTANCE_HEALTH_FILE does not name the jobs heartbeat on its tmpfs');
  if (workerEnv.HOME !== '/nonexistent') p('rab-worker: HOME must be /nonexistent (H1-M1: not a writable module search root)');
  const wTest = (worker.healthcheck?.test ?? []).map(String);
  if (!wTest.some((t) => t.endsWith('worker-bundle-health.cjs'))) p('rab-worker: health check is not the per-instance heartbeat check');
  if (!wTest.includes('CREWFLOW_PROVISIONER_ENABLED=false')) p('rab-worker: health check is not jobs-only (CREWFLOW_PROVISIONER_ENABLED=false on the check command)');
  if (worker.depends_on?.['rab-api']?.condition !== 'service_healthy') p('rab-worker: does not wait for a healthy rab-api (the schema must be current first)');
  // Owner decision 2026-11-11: Compose stops the old Worker BEFORE it replaces rab-api, so an old Worker never runs beside a
  // new API (`docker compose pull && docker compose up -d` updates both together).
  if (worker.depends_on?.['rab-api']?.restart !== true) p('rab-worker: depends_on rab-api needs restart: true (an old Worker must never run beside a new API)');
  if (worker.depends_on?.['rab-redis']?.condition !== 'service_healthy') p('rab-worker: does not wait for a healthy rab-redis');
  if (!(durationSeconds(worker.stop_grace_period) >= MIN_WORKER_STOP_GRACE_S)) p(`rab-worker: stop_grace_period below ${MIN_WORKER_STOP_GRACE_S}s`);

  // rab-redis
  const rc = (redis.command ?? []).map(String);
  const pair = (flag, value) => rc.some((t, i) => t === flag && rc[i + 1] === value);
  if (!pair('--appendonly', 'yes')) p('rab-redis: --appendonly yes is missing');
  if (!pair('--maxmemory-policy', 'noeviction')) p('rab-redis: --maxmemory-policy noeviction is missing');
  if (!rc.includes('--aclfile')) p('rab-redis: --aclfile is missing (unauthenticated Redis)');
  if (!rc.includes('--maxmemory')) p('rab-redis: --maxmemory is missing');

  // O1/O2: one image for every application service.
  if (worker.image !== api.image) p('rab-worker: image differs from rab-api (O2: one image)');

  if (combo.staging) {
    if (model?.name !== 'crewflow-staging') p(`project name is "${model?.name}", expected crewflow-staging`);
    for (const n of ['rab-api', 'rab-worker']) if (envOf(services[n]).STORAGE_KEY_PREFIX !== 'staging') p(`${n}: STORAGE_KEY_PREFIX is not staging`);
  }
  bundledDbProblems(services, model, p);
  return problems;
}

/** STATIC mode: only the bundled-database rules, on the image compose. */
function checkStaticModel(model) {
  const problems = [];
  bundledDbProblems(model?.services ?? {}, model, (msg) => problems.push(`${STATIC_COMBO.name}: ${msg}`));
  return problems;
}

// --------------------------------------------------------------------------------------------------------- env files

/** Parses KEY=VALUE lines (optional `export `). Returns [{key, value, line}]; comments and blanks skipped. */
function parseEnvText(text) {
  const out = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) { out.push({ key: null, value: '', line: i + 1 }); return; }
    // Review J2-1: the value as Docker Compose reads it (quotes, inline ` #` comments), so every rule checks what the app
    // gets. `unreadable` when that reading is ambiguous; `value` then keeps the raw text, which no rule accepts as valid.
    const parsed = composeEnvValue(m[2]);
    out.push({ key: m[1], value: parsed ?? m[2].trim(), unreadable: parsed === null, line: i + 1 });
  });
  return out;
}

const isPlaceholder = (v) => /<[^>]*>/.test(v);

/**
 * Problems with one env file. kind: 'database' (database.env), 'runtime' (runtime.env) or 'compose' (compose.env).
 * `template` relaxes only the value-shape checks a <placeholder> cannot satisfy. Never includes a value.
 */
function lintEnvText(kind, text, { template = false } = {}) {
  const problems = [];
  const entries = parseEnvText(text);
  const seen = new Set();
  for (const { key, value, line } of entries) {
    if (key === null) { problems.push(`line ${line}: not a KEY=VALUE line`); continue; }
    if (seen.has(key)) problems.push(`${key}: set more than once (line ${line})`);
    seen.add(key);
    const why = kind === 'compose' && key === DB_PASSWORD_KEY ? null : forbiddenReason(key);
    if (why) problems.push(`${key}: ${why}`);
    if (COMMITTED_KEYS.includes(key)) problems.push(`${key}: committed in the compose files; never re-enter it in an env file`);
    if (kind !== 'compose' && key === URL_KEY) problems.push(`${key}: set it in compose.env (the interpolation file): it belongs to db-setup only (its committed \${PG_DATABASE_URL:-...} would override a value here), and rab-api / rab-worker refuse it`);
    if (kind === 'database' && !why && key !== URL_KEY && !DATABASE_ALLOWED.includes(key)) problems.push(`${key}: does not belong in the shared database file (only ${DATABASE_ALLOWED.join(', ')})`);
    if (kind === 'runtime' && DATABASE_OPT_INS.includes(key)) problems.push(`${key}: belongs in database.env only (so rab-api and rab-worker see the same value)`);
    if (key === 'CREWFLOW_UPGRADE_FAILURE' && !UPGRADE_FAILURE_VALUES.includes(value)) problems.push(`${key}: must be exactly continue or refuse`);
    // Review J2-1 (fail closed): a feature switch is exactly true or false once read the way Compose reads it.
    if (Object.hasOwn(FEATURE_SWEEPS, key) && !SWITCH_VALUES.includes(value)) problems.push(`${key}: must be exactly true or false (quotes and an inline # comment are read as Compose reads them)`);
    for (const [flag, rule] of Object.entries(FEATURE_SWEEPS)) {
      if (key === rule.key) problems.push(`${key}: commit it in the compose files on rab-api and rab-worker, never in an env file (the API registers the ${flag === 'PUSH_ENABLED' ? 'push' : 'realtime'} scheduler with its own value)`);
    }
    if (Object.hasOwn(PHASE_D_UNCHANGED, key) && value !== PHASE_D_UNCHANGED[key]) problems.push(`${key}: the owner decision 2026-11-06 keeps it at ${PHASE_D_UNCHANGED[key]} in production (leave it unset)`);
    if (/^CREWFLOW_AUDIT_SINK/.test(key) && kind !== 'runtime') problems.push(`${key}: belongs in runtime.env (rab-api and rab-worker both start the audit sink)`);
    if (kind === 'runtime' && key === AUDIT_SINK_KEY) {
      if (!AUDIT_SINK_MODES.includes(value)) problems.push(`${key}: must be exactly none, stdout or file (security-audit-sink.ts)`);
      else if (!AUDIT_SINK_PRODUCTION_MODES.includes(value)) problems.push(`${key}: production refuses ${value}; set stdout with an off-host append-only log shipper (BC-07)`);
    }
    if (kind === 'runtime' && key === 'CREWFLOW_AUDIT_SINK_FAILURE') {
      if (!AUDIT_SINK_FAILURES.includes(value)) problems.push(`${key}: must be exactly refuse or log (security-audit-sink.ts)`);
      else if (!AUDIT_SINK_PRODUCTION_FAILURES.includes(value)) problems.push(`${key}: production requires refuse (or leave it unset)`);
    }
    if (kind === 'runtime' && key === 'CREWFLOW_AUDIT_SINK_FILE') problems.push(`${key}: the file sink is development-only (production refuses CREWFLOW_AUDIT_SINK=file)`);
    if (key === APPROVAL_MODE_KEY && kind !== 'compose') problems.push(`${key}: set it in compose.env (the interpolation file): rab-api's committed ${APPROVAL_MODE_EXPR} would silently override a value here`);
    if (key === APPROVAL_MODE_KEY && kind === 'compose' && !APPROVAL_MODES.includes(value)) problems.push(`${key}: must be exactly none or token`);
    if (kind !== 'runtime' && key === 'CREWFLOW_UPGRADE_FAILURE') problems.push(`${key}: belongs in runtime.env (the API reads it)`);
    if (kind === 'compose') {
      // DB-SETUP (T-1 / T-2): the two database values are the only secrets compose.env holds; everything else stays
      // CREWFLOW_* and secret-free.
      const dbKey = COMPOSE_DATABASE_KEYS.includes(key);
      if (!key.startsWith('CREWFLOW_') && !dbKey) problems.push(`${key}: compose.env holds only CREWFLOW_* interpolation values (and ${COMPOSE_DATABASE_KEYS.join(', ')})`);
      // CREWFLOW_SECRETS_DIR names a directory, not a secret.
      if (key !== 'CREWFLOW_SECRETS_DIR' && !dbKey && /PASSWORD|SECRET|TOKEN|APPROVED|_URL$|_KEY$/.test(key)) problems.push(`${key}: a secret-like name in the interpolation file`);
      if (!dbKey && /:\/\/[^/\s]*@/.test(value)) problems.push(`${key}: a URL with credentials in the interpolation file`);
      if (key === DB_PASSWORD_KEY && !(template && isPlaceholder(value)) && !DB_PASSWORD_SHAPE.test(value)) {
        problems.push(`${key}: must be at least 32 URL-safe characters (letters, digits, - . _ ~; e.g. openssl rand -hex 32): it is interpolated into the bundled db's admin URL`);
      }
      if (/_IMAGE$/.test(key) && !template && !DIGEST_REF.test(value)) problems.push(`${key}: not pinned by digest (repository@sha256:<64 hex>)`);
      // Owner decision 2026-11-11: ONE image variable, named like Twenty's TAG, that accepts ONLY a digest (a tag can be moved
      // on the registry; a digest cannot). A plain tag is refused here and by the `@` form in the compose files.
      if (key === 'CREWFLOW_IMAGE_TAG' && !template && !/^sha256:[0-9a-f]{64}$/.test(value)) problems.push(`${key}: not a sha256:<64 hex> digest (a plain tag is refused; use the release's index digest)`);
      if (/_IMAGE_DIGEST$/.test(key) && !template && !/^sha256:[0-9a-f]{64}$/.test(value)) problems.push(`${key}: not a sha256:<64 hex> digest`);
      // The previous name of the one variable: the compose files no longer read it, so one left in compose.env would be
      // silently ignored while CREWFLOW_IMAGE_TAG decides what runs.
      if (key === 'CREWFLOW_IMAGE_DIGEST') problems.push(`${key}: renamed (2026-11-11); set CREWFLOW_IMAGE_TAG=<the same sha256 digest> instead`);
      // O2 (one image, one variable): the per-role image variables are retired, and so is any per-role TAG variable — there is
      // no API-only or Worker-only deploy path.
      if (/^CREWFLOW_(API|WORKER|OPS)_IMAGE_(DIGEST|REPOSITORY|TAG)$/.test(key)) problems.push(`${key}: retired (O2: one image); set CREWFLOW_IMAGE_${key.endsWith('REPOSITORY') ? 'REPOSITORY' : 'TAG'} instead`);
      if (key === 'CREWFLOW_API_BIND' && ['0.0.0.0', '::', ''].includes(value)) problems.push(`${key}: binds every interface`);
    }
    if (key !== URL_KEY && isPgUrl(value)) problems.push(`${key}: holds a PostgreSQL URL (a second database identity)`);
  }
  if (kind === 'runtime' && !entries.some((e) => e.key === AUDIT_SINK_KEY)) {
    problems.push(`${AUDIT_SINK_KEY}: missing (BC-07: production refuses to start without an external audit sink; set stdout with an off-host append-only log shipper)`);
  }
  // DB-SETUP + PR #125 option 2 (compose.env, optional; unset = the bundled db): PG_DATABASE_URL is the ONE database setting,
  // your database's ADMIN URL (T-1 accepts a provider admin login) or an existing crewflow_owner URL (pass-through, D5);
  // either way it reaches db-setup only. A former separated login, TLS below verify-full, a transaction pooler and a URL
  // without a password are refused.
  if (kind === 'compose') {
    for (const key of [URL_KEY]) {
      const url = entries.find((e) => e.key === key)?.value;
      if (url === undefined || url === '' || (template && isPlaceholder(url))) continue;
      let u = null;
      try { u = new URL(url); } catch { problems.push(`${key}: not a parseable URL`); }
      if (!u) continue;
      const login = decodeURIComponent(u.username);
      if (!/^postgres(ql)?:$/.test(u.protocol)) problems.push(`${key}: not a postgres:// URL`);
      if (NOT_THE_APP_LOGIN.includes(login)) problems.push(`${key}: logs in as a former separated login or schema role (use the database admin login, or ${OWNER_LOGIN})`);
      if (login === '') problems.push(`${key}: has no login`);
      if (u.searchParams.get('sslmode') !== 'verify-full') problems.push(`${key}: sslmode is not verify-full`);
      for (const [re, label] of POOLER_HINTS) if (re.test(url)) problems.push(`${key}: points at a transaction pooler (${label}); use the DIRECT host`);
      if (u.password === '') problems.push(`${key}: has no password`);
    }
  }
  return problems;
}

/** Problems in raw compose text that rendering cannot show. */
function lintComposeText(rel, text) {
  const problems = [];
  if (/^\s*build\s*:/m.test(text)) problems.push(`${rel}: has a build: key`);
  if (/^\s*-?\s*CREWFLOW_MIGRATION_APPROVED\s*[:=]/m.test(text)) problems.push(`${rel}: sets CREWFLOW_MIGRATION_APPROVED`);
  if (/^\s*-?\s*CREWFLOW_DB_MODE\s*[:=]/m.test(text)) problems.push(`${rel}: sets CREWFLOW_DB_MODE (there is no mode switch)`);
  // PR #125 option 2: ${PG_DATABASE_URL...} is interpolated in exactly one place, db-setup's environment (never on rab-api /
  // rab-worker, which pin the literal empty string). A second interpolation would hand the one database setting to another
  // service.
  const urlInterpolations = text.split('\n').filter((l) => !/^\s*#/.test(l) && l.includes('${PG_DATABASE_URL')).length;
  if (urlInterpolations > 1) problems.push(`${rel}: interpolates \${PG_DATABASE_URL...} ${urlInterpolations} times (option 2: only db-setup's one line)`);
  if (/^\s*-?\s*CREWFLOW_(DEPLOYMENT_ENVIRONMENT|DEPLOYMENT_ID)\s*:/m.test(text)) problems.push(`${rel}: commits a BC-11 opt-in (the deployment identity belongs in database.env)`);
  if (/^\s*-?\s*CREWFLOW_AUDIT_SINK\w*\s*[:=]/m.test(text)) problems.push(`${rel}: commits the audit sink (BC-07: the operator sets CREWFLOW_AUDIT_SINK in runtime.env)`);
  // The approval mode may only be the compose.env interpolation (none by default), never a literal that pins it.
  for (const m of text.matchAll(/^\s*-?\s*CREWFLOW_MIGRATION_APPROVAL_MODE\s*[:=]\s*(.*?)\s*$/gm)) {
    if (m[1] !== APPROVAL_MODE_EXPR) problems.push(`${rel}: ${APPROVAL_MODE_KEY} must be exactly ${APPROVAL_MODE_EXPR} (an opt-in of compose.env)`);
  }
  if (/^\s*privileged\s*:\s*true/m.test(text)) problems.push(`${rel}: privileged: true`);
  return problems;
}

// ------------------------------------------------------------------------------------------------------------ render

// The sentinel database.env sets NONE of the BC-11 opt-ins (approval mode, deployment identity): any of them in a rendered
// model was therefore committed by a compose file.
// DB-SETUP: the URL is no longer in database.env (compose.env, or the bundled default); the sentinel database.env plants one
// anyway, so a compose file that stopped overriding it renders the legacy marker and fails.
const DATABASE_ENV_TEXT = [
  `${URL_KEY}=postgresql://crewflow_owner:${SENTINEL_LEGACY_PW}@db-direct.example:5432/crewflow?sslmode=verify-full`, 'PG_EXPECTED_DATABASE_NAME=crewflow', '',
].join('\n');
const RUNTIME_ENV_TEXT = [`APP_SECRET=${SENTINEL_APP_SECRET}`, `REDIS_URL=redis://crewflow:${SENTINEL_REDIS_PW}@rab-redis:6379`, 'APP_URL=https://crewflow.example', 'CREWFLOW_AUDIT_SINK=stdout', ''].join('\n');
/** Separated-mode env files a compose file must no longer read: their marker value must never reach a service. */
const LEGACY_ENV_TEXT = `PG_DATABASE_URL=postgresql://crewflow_migrator:${SENTINEL_LEGACY_PW}@db-direct.example:5432/rab?sslmode=verify-full\nLEGACY_MARKER=${SENTINEL_LEGACY_PW}\n`;

/** Renders the given combos; returns { [comboName]: model }. Throws when docker compose fails. */
function renderModels(combos = COMBOS, extraComposeEnv = [], extraRuntimeEnv = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-owner-login-'));
  try {
    const secrets = path.join(tmp, 'secrets');
    const project = path.join(tmp, 'project');
    fs.mkdirSync(secrets);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(secrets, 'database.env'), DATABASE_ENV_TEXT, { mode: 0o600 });
    fs.writeFileSync(path.join(secrets, 'runtime.env'), RUNTIME_ENV_TEXT + extraRuntimeEnv.map((l) => `${l}\n`).join(''), { mode: 0o600 });
    // The separated-mode env files (project-relative .env.migrate, the retired .env.ops, per-service staging files) exist
    // only so a file that still names them renders; the gate then fails on their marker.
    for (const f of ['.env.migrate', '.env.ops']) fs.writeFileSync(path.join(project, f), LEGACY_ENV_TEXT, { mode: 0o600 });
    for (const f of ['api.env', 'worker.env', 'migrate.env']) fs.writeFileSync(path.join(secrets, f), LEGACY_ENV_TEXT, { mode: 0o600 });
    const fwd = (p) => p.split(path.sep).join('/');
    const composeEnv = path.join(tmp, 'compose.env');
    fs.writeFileSync(composeEnv, [
      `CREWFLOW_IMAGE_TAG=sha256:${'0'.repeat(64)}`,
      `CREWFLOW_REDIS_IMAGE=redis@sha256:${'2'.repeat(64)}`,
      `CREWFLOW_SECRETS_DIR=${fwd(secrets)}`,
      'CREWFLOW_REDIS_CONF=/etc/crewflow/redis.conf',
      // DB-SETUP: the bundled db's password; the db image and CREWFLOW_PG_CA_FILE keep their committed defaults.
      `${DB_PASSWORD_KEY}=${SENTINEL_DB_PW}`,
      ...extraComposeEnv,
      '',
    ].join('\n'), { mode: 0o600 });
    // The external combination: the operator's own database ADMIN URL in compose.env's PG_DATABASE_URL; pass-through: a
    // crewflow_owner URL there (an existing deployment, DB-SETUP-PLAN §7.1). Option 2: the same one variable.
    const envFor = { admin: path.join(tmp, 'compose.external.env'), owner: path.join(tmp, 'compose.pass-through.env') };
    fs.writeFileSync(envFor.admin, `${fs.readFileSync(composeEnv, 'utf8')}${URL_KEY}=${SENTINEL_ADMIN_URL}\n`, { mode: 0o600 });
    fs.writeFileSync(envFor.owner, `${fs.readFileSync(composeEnv, 'utf8')}${URL_KEY}=${SENTINEL_URL}\n`, { mode: 0o600 });
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CREWFLOW_|COMPOSE_|PG_DATABASE_)/i.test(k)));
    const models = {};
    for (const combo of combos) {
      // --project-directory: relative env_file / bind paths resolve in the throw-away directory, never this checkout.
      const args = ['compose', '--env-file', combo.external ? envFor[combo.external] : composeEnv, '--project-directory', project];
      // A combo names FILES keys; a test may pass a compose file path instead (a weakened copy of a committed file).
      for (const f of combo.files) args.push('-f', FILES[f] ?? f);
      // Every profile (security review of PR #124, MEDIUM): a profile-gated service is rendered, so the exact service list
      // and the "has profiles" check refuse it, never a service hidden behind `profiles:` that `up --profile x` would start.
      args.push('--profile', '*', 'config', '--format', 'json');
      models[combo.name] = JSON.parse(execFileSync('docker', args, { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }));
    }
    return models;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Static checks: committed templates and the raw text of the owner-login files that exist. */
function staticProblems() {
  const problems = [];
  for (const [kind, file] of Object.entries(TEMPLATES)) {
    const rel = path.relative(DOCKER_DIR, file).split(path.sep).join('/');
    for (const msg of lintEnvText(kind, fs.readFileSync(file, 'utf8'), { template: true })) problems.push(`${rel}: ${msg}`);
  }
  for (const file of Object.values(FILES)) {
    if (!fs.existsSync(file)) continue;
    problems.push(...lintComposeText(path.relative(DOCKER_DIR, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')));
  }
  return problems;
}

// -------------------------------------------------------------------------------------------------------------- main

function main(argv) {
  if (argv[0] === '--lint-env-file') {
    const [, kind, file] = argv;
    if (!['database', 'runtime', 'compose'].includes(kind) || !file) {
      console.error('usage: compose-owner-login.cjs --lint-env-file <database|runtime|compose> <path>');
      return 2;
    }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { console.error(`[owner-login] cannot read ${file}`); return 2; }
    const problems = lintEnvText(kind, text);
    // Phase X J2: a runtime.env that switches push or realtime on is checked against the COMMITTED compose files, rendered
    // with exactly those switches (no other value of the file is used).
    const switches = kind === 'runtime' ? parseEnvText(text).filter((e) => Object.hasOwn(FEATURE_SWEEPS, e.key) && switchedOn(e.value)) : [];
    if (switches.length) {
      try { execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' }); } catch { console.log('[owner-login] docker compose is not available (needed to check the push/realtime sweep rule)'); return 2; }
      let models;
      try {
        models = renderModels(COMBOS, [], switches.map((e) => `${e.key}=true`));
      } catch (error) {
        console.log(`[owner-login] FAIL docker compose config: ${String(error.stderr ?? error.message).trim().split('\n').slice(-3).join(' | ')}`);
        return 1;
      }
      for (const combo of COMBOS) {
        const s = models[combo.name]?.services ?? {};
        for (const msg of featureSweepProblems(s['rab-api']?.environment, s['rab-worker']?.environment)) problems.push(`${combo.name}: ${msg}`);
      }
    }
    for (const msg of problems) console.log(`[owner-login] FAIL ${kind} env file: ${msg}`);
    console.log(`[owner-login] ${problems.length === 0 ? 'PASS' : 'FAIL'} ${kind} env file (${parseEnvText(text).length} entries; names only, no value printed)`);
    return problems.length === 0 ? 0 : 1;
  }
  const staticOnly = argv[0] === '--static';
  if (argv.length && !staticOnly) { console.error('usage: compose-owner-login.cjs [--static | --lint-env-file <kind> <path>]'); return 2; }
  let failures = 0;
  const report = (label, problems) => {
    for (const msg of problems) console.log(`[owner-login] FAIL ${msg}`);
    console.log(`[owner-login] ${problems.length === 0 ? 'PASS' : 'FAIL'} ${label}`);
    failures += problems.length;
  };
  report('templates and raw compose text', staticProblems());
  try { execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' }); } catch { console.log('[owner-login] docker compose is not available (CI must have it)'); return 2; }
  const combos = staticOnly ? [STATIC_COMBO] : COMBOS;
  let models;
  try {
    models = renderModels(combos);
  } catch (error) {
    console.log(`[owner-login] FAIL docker compose config: ${String(error.stderr ?? error.message).trim().split('\n').slice(-3).join(' | ')}`);
    return 1;
  }
  for (const combo of combos) {
    const label = `${combo.name} (${combo.files.map((f) => path.relative(DOCKER_DIR, FILES[f]).split(path.sep).join('/')).join(' + ')})`;
    report(label, staticOnly ? checkStaticModel(models[combo.name]) : checkModel(models[combo.name], combo));
  }
  return failures === 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  FILES, TEMPLATES, COMBOS, STATIC_COMBO, DB_SERVICE, DB_SETUP_SERVICE, DB_TARGET_VOLUME, DB_TARGET_DIR, SENTINEL_ADMIN_PW, SENTINEL_ADMIN_URL, dbSetupProblems, appCredentialProblems, bundledDbEnvironmentProblems, DB_INITDB_ARGS, DB_ENV_KEYS, DB_PASSWORD_KEY, SENTINEL_DB_PW, BUNDLED_URL, NOT_THE_APP_LOGIN, NOTIFICATION_DELIVERY, PHASE_D_SWITCHES, PHASE_D_UNCHANGED, STATEMENT_DISPATCH, FEATURE_SWEEPS, SWITCH_VALUES, featureSweepProblems, composeEnvValue, AUDIT_SINK_MODES, AUDIT_SINK_PRODUCTION_MODES, AUDIT_SINK_FAILURES,
  AUDIT_SINK_PRODUCTION_FAILURES, SENTINEL_URL, SENTINEL_OWNER_PW, SENTINEL_APP_SECRET,
  SENTINEL_REDIS_PW, SENTINEL_LEGACY_PW, forbiddenReason, durationSeconds, checkModel, checkStaticModel, parseEnvText,
  lintEnvText, lintComposeText, renderModels, staticProblems, main,
};
