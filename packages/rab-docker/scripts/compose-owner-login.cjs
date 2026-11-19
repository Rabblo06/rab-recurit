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
 *   docker-compose.image.yml                                   (a, bundled db: compose.env sets PG_DATABASE_PASSWORD and
 *                                                               PG_DATABASE_APP_PASSWORD)
 *   docker-compose.image.yml                                   (external: compose.env also sets PG_ADMIN_URL = an admin URL
 *                                                               and PG_DATABASE_URL = the crewflow_owner URL)
 *   docker-compose.image.yml                                   (pass-through: compose.env sets PG_DATABASE_URL = crewflow_owner)
 *   docker-compose.image.yml                                   (b external-no-db / c pass-through-no-db: the same URLs plus
 *                                                               CREWFLOW_BUNDLED_DB=0, Twenty's Helm db.enabled=false,
 *                                                               and NO PG_DATABASE_PASSWORD / PG_DATABASE_APP_PASSWORD)
 *   docker-compose.image.yml + staging/docker-compose.staging.yml
 * from sentinel env files only (no real .env, compose.env or secret of this machine is read; CREWFLOW_* / COMPOSE_* /
 * PG_DATABASE_* / PG_ADMIN_* are removed from the child environment because they would win over --env-file), and asserts on
 * each rendered model:
 *   - DATABASE, the Twenty way (owner decision 2026-11-18, "change PR #125 option 2 to Twenty's way"): rab-api, rab-worker
 *     and db-setup receive PG_DATABASE_URL, ALWAYS the crewflow_owner URL, as the ONE committed expression
 *     ${PG_DATABASE_URL:-postgresql://crewflow_owner:${PG_DATABASE_APP_PASSWORD:-}@${PG_DATABASE_HOST:-db}:${PG_DATABASE_PORT:-5432}/${PG_DATABASE_NAME:-crewflow}?sslmode=verify-full}
 *     (APP_URL_EXPR; compose.env's URL, or the bundled db's crewflow_owner URL built from PG_DATABASE_APP_PASSWORD), the
 *     SAME rendered value on all three, never from an env file. The admin login reaches ONLY db-setup: compose.env's
 *     PG_ADMIN_URL (`${PG_ADMIN_URL:-}`) and the bundled db's superuser URL built from `${PG_DATABASE_PASSWORD:-}`
 *     (CREWFLOW_BUNDLED_DB_ADMIN_URL). rab-api and rab-worker pin PG_ADMIN_URL to "" (ADMIN_URL_PLACEMENT: in no compose file
 *     at all, raw text included, outside db-setup), and NOTHING else in their definition (environment, health check,
 *     command, labels) holds a database credential or a postgres:// value. The crewflow_owner password appears only inside
 *     PG_DATABASE_URL of those three services; PG_DATABASE_PASSWORD / PG_DATABASE_APP_PASSWORD never reach a container by
 *     name. NO file carries a credential: the retired crewflow-db-target volume and any mount at /run/crewflow/db-target are
 *     refused everywhere. compose.env's PG_ADMIN_URL may be any login but crewflow_owner or a former separated one, its
 *     PG_DATABASE_URL only crewflow_owner (any other login: "an admin URL goes in PG_ADMIN_URL"); with PG_ADMIN_URL the
 *     two name the same database; verify-full, a direct host, with a password; PG_DATABASE_PASSWORD and
 *     PG_DATABASE_APP_PASSWORD required exactly in the bundled mode (dbSettingsProblems). db-setup has exactly its shape
 *     (same image, started through the wait-for-db wrapper (db-setup-wait.cjs: the block of rab/db-setup.sh, then exec
 *     ./db-setup.sh; owner instruction 2026-11-18, Twenty's Helm wait-for-db), restart "no", no port, no profile, the H1-H6
 *     hardening, NO depends_on (with CREWFLOW_BUNDLED_DB=0 there is no db container), CREWFLOW_DB_WAIT_SECONDS committed as
 *     ${CREWFLOW_DB_WAIT_SECONDS:-170}, the CA read-only) and rab-api waits for it (service_completed_successfully) and
 *     never for db. No service carries any other database URL — no migrator, provisioner,
 *     worker, ops, replica, posture, drift or test URL, no legacy DATABASE_URL* name, no libpq PG* variable, no postgres://
 *     value under another key; no CREWFLOW_DB_MODE (there is no mode switch); nothing from a separated-mode env file
 *     (.env.migrate, the retired .env.ops, per-service staging files) reaches any service;
 *   - CREWFLOW_MIGRATION_APPROVED is never set by a compose or env file (a one-run `run -e` only), and no role password or
 *     command/ops authority reaches any service; the retired CREWFLOW_UPGRADE_INCOMPLETE and the removed
 *     CREWFLOW_UPGRADE_FAILURE / CREWFLOW_UPGRADE_FAILURE_POLICY (OWNER-DB-ULTIMATE Part B3) are never set;
 *   - the H1-H6 hardening on every service: image by digest and no `build:`, non-root numeric user, read_only, cap_drop ALL
 *     and no cap_add, no-new-privileges, pids/memory/CPU limits, health checks, a stop window, bounded logs, no privileged /
 *     host namespaces / Docker socket, read-only binds, only rab-api publishes and only on loopback;
 *   - the lifecycle (O3): NO rab-migrate; the API migrates on start (CREWFLOW_MIGRATE_ON_START=true, approval mode
 *     ${CREWFLOW_MIGRATION_APPROVAL_MODE:-none} from compose.env, rendering only as none or token (BC-11/C4), a
 *     fresh-install start_period, registers the job schedulers), exactly ONE instance and never a
 *     start-first update (C5: stop-then-start). The deployment identity stays an OPT-IN of database.env, never committed. The Worker never
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
 *     a health check, its two named volumes, POSTGRES_PASSWORD exactly ${PG_DATABASE_PASSWORD:-} (T-2; the entrypoint refuses
 *     an empty one before it touches the volume: required only while it runs) and no
 *     POSTGRES_PASSWORD_FILE / trust / database URL, TLS on with the certificate it makes itself (verify-full kept), the
 *     superuser never named crewflow_owner; nothing depends on it (db-setup waits for it itself); rab-api and rab-worker mount only its CA volume,
 *     read-only; PG_DATABASE_PASSWORD reaches no container (only db's POSTGRES_PASSWORD and db-setup's bundled URL hold it).
 *     Exactly one db replica (deploy.replicas, never `scale`); 0 only in the -no-db combinations, i.e. compose.env's
 *     CREWFLOW_BUNDLED_DB=0 with PG_DATABASE_URL (and optionally PG_ADMIN_URL) set (Twenty's Helm db.enabled=false; the
 *     env-file lint refuses 0 unless those URLs name a host other than db, and any value but 0 or 1).
 * STATIC mode lints the committed templates and renders docker-compose.image.yml, checking only the bundled-database rules.
 * Prints service names, variable NAMES and check results only, never a value.
 * Exit 0 = all checks passed, 1 = a check failed, 2 = usage error or docker compose unavailable.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pgCaPemProblem } = require('./pg-ca-pem.cjs');
const { dbSetupStartProblems, waitSecondsProblem, WAIT_SECONDS_KEY, WAIT_SECONDS_DEFAULT } = require('./db-setup-wait.cjs');

const DOCKER_DIR = path.resolve(__dirname, '..');
const FILES = Object.freeze({
  image: path.join(DOCKER_DIR, 'docker-compose.image.yml'),
  staging: path.join(DOCKER_DIR, 'staging/docker-compose.staging.yml'),
});
/** The OpenShip production file: only databaseExpressionProblems here (the other gates own its other rules). */
const PRODUCTION_FILE = path.join(DOCKER_DIR, 'docker-compose.production.yml');
const TEMPLATES = Object.freeze({
  database: path.join(DOCKER_DIR, 'env/database.env.example'),
  runtime: path.join(DOCKER_DIR, 'env/runtime.env.example'),
  compose: path.join(DOCKER_DIR, 'env/compose.env.example'),
});
// O3: one lifecycle (the API migrates on start); docker-compose.migrate-on-start.yml is folded into the image compose.
// DB-SETUP (D3): docker-compose.local-db.yml is retired; the bundled `db` is part of the image compose itself. `external`
// renders the same file with PG_ADMIN_URL (the operator's own database's admin URL) AND PG_DATABASE_URL (the crewflow_owner
// URL) set in compose.env (mode b); `pass-through` with only a crewflow_owner URL in PG_DATABASE_URL (mode c). Owner decision
// 2026-11-18: PG_DATABASE_URL reaches db-setup, rab-api and rab-worker alike; PG_ADMIN_URL only db-setup.
const COMBOS = Object.freeze([
  { name: 'default', files: ['image'], external: false, staging: false },
  { name: 'external', files: ['image'], external: 'admin', staging: false }, // compose.env: PG_ADMIN_URL + PG_DATABASE_URL
  { name: 'pass-through', files: ['image'], external: 'owner', staging: false }, // PG_DATABASE_URL = crewflow_owner
  // Twenty's Helm db.enabled=false: your own database (either URL) and CREWFLOW_BUNDLED_DB=0 in compose.env, so the bundled
  // db renders with 0 replicas (never started; Compose skips the wait on it). Owner modes (b) and (c): rendered WITHOUT
  // PG_DATABASE_PASSWORD and PG_DATABASE_APP_PASSWORD (no dummy password; owner decision 2026-11-17). Every other rule is
  // unchanged.
  { name: 'external-no-db', files: ['image'], external: 'admin', staging: false, bundledDb: 0 },
  { name: 'pass-through-no-db', files: ['image'], external: 'owner', staging: false, bundledDb: 0 },
  { name: 'staging', files: ['image', 'staging'], external: false, staging: true },
]);
const STATIC_COMBO = Object.freeze({ name: 'static:image', files: ['image'], external: false });

const OWNER_LOGIN = 'crewflow_owner';
/** DB-SETUP: the bundled database service and the one compose-only variable that holds its superuser password. */
const DB_SERVICE = 'db';
const DB_PASSWORD_KEY = 'PG_DATABASE_PASSWORD';
/**
 * Owner decision 2026-11-18 (Twenty's way): the bundled crewflow_owner password, a compose.env value interpolated ONLY into
 * the committed PG_DATABASE_URL expression (APP_URL_EXPR); it never reaches a container by name.
 */
const APP_PASSWORD_KEY = 'PG_DATABASE_APP_PASSWORD';
/**
 * The ONE committed PG_DATABASE_URL expression, on db-setup, rab-api and rab-worker alike: compose.env's crewflow_owner URL
 * (modes b and c), or the bundled db's crewflow_owner URL built from PG_DATABASE_APP_PASSWORD (mode a).
 */
const APP_URL_EXPR = '${PG_DATABASE_URL:-postgresql://crewflow_owner:${PG_DATABASE_APP_PASSWORD:-}@${PG_DATABASE_HOST:-db}:${PG_DATABASE_PORT:-5432}/${PG_DATABASE_NAME:-crewflow}?sslmode=verify-full}';
/** compose.env: the bundled db on (1, the default when unset) or off (0, only with PG_DATABASE_URL, plus any PG_ADMIN_URL). */
const BUNDLED_DB_KEY = 'CREWFLOW_BUNDLED_DB';
const BUNDLED_DB_VALUES = Object.freeze(['0', '1']);
/**
 * PG_ADMIN_URL (owner decision 2026-11-17): the database admin URL, a compose.env value interpolated ONLY into db-setup
 * (never rab-api / rab-worker, never an env file). PG_DATABASE_URL is then ALWAYS the app login (crewflow_owner).
 */
const ADMIN_URL_KEY = 'PG_ADMIN_URL';
/**
 * PG_ADMIN_DIRECT_URL (owner decision 2026-11-19): the DIRECT address of the PG_ADMIN_URL login, for an operator who pastes a
 * pooled admin URL as-is. db-setup / db-harden only, under exactly PG_ADMIN_URL's placement rule (never rab-api / rab-worker,
 * not even pinned); the same login and database as PG_ADMIN_URL (db-setup refuses otherwise).
 */
const ADMIN_DIRECT_URL_KEY = 'PG_ADMIN_DIRECT_URL';
/**
 * Owner decision 2026-11-19 ("You set one shared password"): the non-secret address of your own database, copied from
 * PG_ADMIN_URL, from which compose builds PG_DATABASE_URL together with PG_DATABASE_APP_PASSWORD (APP_URL_EXPR). Unset =
 * the bundled db (db:5432/crewflow).
 */
const DB_HOST_KEY = 'PG_DATABASE_HOST';
const DB_PORT_KEY = 'PG_DATABASE_PORT';
const DB_NAME_KEY = 'PG_DATABASE_NAME';
/** The retired name(s) of the admin URL: refused everywhere with a "renamed" message (never read, never reinterpreted). */
const RETIRED_ADMIN_URL_KEYS = Object.freeze(['PG_DATABASE_ADMIN_URL']);
/** db-setup's committed bundled-db superuser URL, built from ${PG_DATABASE_PASSWORD:-}; used only when neither URL is set. */
const BUNDLED_ADMIN_URL_KEY = 'CREWFLOW_BUNDLED_DB_ADMIN_URL';
/** db-setup's whole database environment, exactly (names). */
const DB_SETUP_DB_KEYS = Object.freeze([ADMIN_URL_KEY, ADMIN_DIRECT_URL_KEY, 'PG_DATABASE_URL', BUNDLED_DB_KEY, BUNDLED_ADMIN_URL_KEY]);
/** Where the app services mount the bundled db's CA volume (read-only), and the db's own volume targets. */
const DB_CA_VOLUME = 'crewflow-db-ca';
const DB_CA_TARGET = '/run/crewflow/db-ca';
/** The one-shot setup service (with db-harden, the ONLY services with an admin login). */
const DB_SETUP_SERVICE = 'db-setup';
/**
 * Owner decision 2026-11-18 (security review of PR #246, M1: "auto-close plus a grace period"): the one-shot CREATEROLE
 * hardening service. The same image and code path as db-setup (`./db-setup.sh harden`), the same database environment, plus
 * its bounded wait. NO depends_on, and nothing may depend on it: it polls by itself and never blocks rab-api / rab-worker.
 */
const DB_HARDEN_SERVICE = 'db-harden';
/** The only services that may hold the admin login (PG_ADMIN_URL, the bundled db's superuser URL). */
const ADMIN_SERVICES = Object.freeze([DB_SETUP_SERVICE, DB_HARDEN_SERVICE]);
/** db-harden's bounded wait for the ledger (seconds; the child accepts 60-7200). Committed with the code default. */
const HARDEN_TIMEOUT_KEY = 'CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS';
const HARDEN_TIMEOUT_EXPR = '${CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS:-1200}';
const HARDEN_TIMEOUT_MIN_S = 60;
const HARDEN_TIMEOUT_MAX_S = 7200;
const HARDEN_ENTRYPOINT = Object.freeze(['./db-setup.sh', 'harden']);
/**
 * RETIRED (owner decision 2026-11-18): PR #125 option 2's setup volume, which held a credential-free target file and the
 * crewflow_owner password file. No file carries a credential any more: the volume, and any mount at its path, is refused
 * everywhere, so it can never come back unreviewed.
 */
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
/** The same committed URL when PG_DATABASE_PASSWORD is not set (modes b and c): db-setup.sh ignores it there. */
const BUNDLED_URL_NO_PASSWORD = 'postgresql://postgres:@db:5432/crewflow?sslmode=verify-full';
/** Mode a: the bundled crewflow_owner password (compose.env), and the crewflow_owner URL the committed default builds from it. */
const SENTINEL_APP_PW = 'SENTINELAPPOWNERPW7c1e5a93b04d2f68e1'; // gitleaks:allow
const BUNDLED_APP_URL = `postgresql://${OWNER_LOGIN}:${SENTINEL_APP_PW}@db:5432/crewflow?sslmode=verify-full`;
/** The external combination: a provider admin URL in compose.env. */
const SENTINEL_ADMIN_PW = 'SENTINEL-EXTERNAL-ADMIN-PW-3c91e7'; // gitleaks:allow
const SENTINEL_ADMIN_URL = `postgresql://doadmin:${SENTINEL_ADMIN_PW}@db-direct.example:5432/crewflow?sslmode=verify-full`;
/**
 * Every database credential the gate plants: none may appear anywhere in rab-api's or rab-worker's definition OUTSIDE their
 * PG_DATABASE_URL (which carries exactly the crewflow_owner one).
 */
const DB_CREDENTIAL_SENTINELS = Object.freeze([SENTINEL_DB_PW, SENTINEL_ADMIN_PW, SENTINEL_OWNER_PW, SENTINEL_APP_PW]);
/** The crewflow_owner passwords the gate plants (compose.env's URL, or the bundled default's). */
const OWNER_PASSWORD_SENTINELS = Object.freeze([SENTINEL_OWNER_PW, SENTINEL_APP_PW]);

/** Names no service and no env file may carry (exact). */
const FORBIDDEN_NAMES = Object.freeze([
  'DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX', 'CREWFLOW_DB_MODE',
  'CREWFLOW_PROVISIONER_DATABASE_URL', 'CREWFLOW_MIGRATION_DATABASE_URL', 'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL',
  'PG_WORKER_DATABASE_URL', 'PG_OPS_APP_DATABASE_URL', 'POSTURE_DATABASE_URL', 'DRIFT_DATABASE_URL', 'BENCH_DATABASE_URL',
  'CREWFLOW_MIGRATION_APPROVED', 'CREWFLOW_MIGRATION_PHASE', 'CREWFLOW_MIGRATOR_PASSWORD',
  'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP', 'ALLOW_PRODUCTION_DB_COMMANDS', 'DB_TARGET', 'ALLOW_REMOTE_TEST_DATABASE',
  'NODE_OPTIONS', 'CREWFLOW_PROVISIONER_ENABLED', 'WORKER_CLAIM_MODE', 'WORKER_DISPATCH_MODE',
  'WORKER_INVITE_AUTO_DELETE_ENABLED', 'WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED', 'PGCONNECT_TIMEOUT',
  'CREWFLOW_UPGRADE_INCOMPLETE', 'CREWFLOW_UPGRADE_FAILURE_POLICY', 'CREWFLOW_UPGRADE_FAILURE',
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
  // Owner decision 2026-11-18: the crewflow_owner password lives ONLY inside PG_DATABASE_URL (or, for the bundled db, in
  // compose.env's PG_DATABASE_APP_PASSWORD, which compose interpolates into it); never another variable.
  [/OWNER_PASSWORD|DB_PASSWORD_FILE|OWNER_PW/, 'the crewflow_owner password (it lives only inside PG_DATABASE_URL, or compose.env\'s PG_DATABASE_APP_PASSWORD for the bundled db; never another variable)'],
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
/** The environment's own parse (strictBoolean since X3.1): only the exact string true switches it on. */
const switchedOn = (v) => String(v ?? '') === 'true';
/** The only values a feature switch may carry (after Compose's own normalisation); anything else is refused (fail closed). */
const SWITCH_VALUES = Object.freeze(['true', 'false']);
/**
 * Phase X3.1 (XR-05 / ENV-01): the on/off switches rab-api and rab-worker parse strictly (environment-variables.ts
 * strictBoolean, and HWS_RUNTIME_ENABLED's own strict resolver): exactly true or false; unset or empty keeps the default;
 * anything else REFUSES TO BOOT. The gate refuses the same values first, so a typo in an env file fails the lint instead of
 * crash-looping the release (packages/rab-docker/docs/release/RELEASE-NOTE-X3.1-STRICT-BOOLEANS.md). PUSH_ENABLED and
 * REALTIME_ENABLED keep their stricter J2-1 rule above (empty refused too).
 *
 * The list is READ from environment-variables.ts (review of #169), never retyped, so a switch made strict later is linted
 * too. Fail closed: an unreadable file, or a scan that misses one of the X3.1 switches, stops the gate.
 */
const ENVIRONMENT_VARIABLES_TS = path.resolve(__dirname, '../../rab-server/src/engine/core-modules/environment/environment-variables.ts');
/** The fourteen switches X3.1 made strict: the scan must find every one (a guard against a scan that silently breaks). */
const X31_SWITCHES = Object.freeze([
  'EMAIL_DELIVERY_ENABLED', 'AUTH_CONTEXT_CACHE_ENABLED', 'USER_SESSION_CACHE_ENABLED', 'CORE_ENTITY_CACHE_ENABLED',
  'WORKSPACE_METADATA_CACHE_ENABLED', 'WORKER_FAST_PUBLISH_NOTIFY', 'USER_SESSION_ENFORCEMENT_CUTOVER', 'AUTH_PASSWORD_ENABLED',
  'AUTH_GOOGLE_ENABLED', 'AUTH_MICROSOFT_ENABLED', 'AUTH_OAUTH_HANDOFF_ENABLED', 'EMAIL_SMTP_NO_TLS', 'REALTIME_ENABLED', 'PUSH_ENABLED',
]);
const STRICT_TRANSFORM = /^\s*@Transform\(\(\{ value(?:, obj)? \}\) => (?:strictBoolean\(value\)|resolveHwsRuntimeEnabled\()/;
const PROPERTY = /^ {2}([A-Z][A-Z0-9_]*)[?!]?\s*:/;

/** Every property of environment-variables.ts whose transform is strictBoolean (or the HWS resolver), sorted. Pure. */
function scanStrictSwitches(source) {
  const lines = String(source).split(/\r?\n/);
  const found = new Set();
  lines.forEach((line, i) => {
    if (!STRICT_TRANSFORM.test(line)) return;
    for (let j = i + 1; j < lines.length && j <= i + 6; j += 1) {
      const m = PROPERTY.exec(lines[j]);
      if (m) { found.add(m[1]); return; }
    }
  });
  return [...found].sort();
}

function loadStrictSwitches() {
  let source;
  try { source = fs.readFileSync(ENVIRONMENT_VARIABLES_TS, 'utf8'); } catch {
    throw new Error(`[owner-login] cannot read ${path.relative(path.resolve(__dirname, '../../..'), ENVIRONMENT_VARIABLES_TS)} (the strict switch list comes from it; run the gate from the repository)`);
  }
  const switches = scanStrictSwitches(source);
  const missing = X31_SWITCHES.filter((key) => !switches.includes(key));
  if (missing.length) throw new Error(`[owner-login] the strict switch scan of environment-variables.ts missed ${missing.join(', ')}: fix the scan`);
  return Object.freeze(switches);
}
const STRICT_SWITCHES = loadStrictSwitches();
const STRICT_SWITCH_MESSAGE = 'must be exactly true or false (X3.1: rab-api and rab-worker refuse anything else at boot; empty or unset keeps the default)';

/** X3.1 problems of one service environment (pure; names only, never a value). */
function strictSwitchProblems(name, env = {}) {
  const problems = [];
  for (const key of STRICT_SWITCHES) {
    if (Object.hasOwn(FEATURE_SWEEPS, key)) continue; // featureSweepProblems checks these (stricter: empty refused too)
    const v = env?.[key];
    if (v !== undefined && v !== null && String(v) !== '' && !SWITCH_VALUES.includes(String(v))) problems.push(`${name}: ${key} ${STRICT_SWITCH_MESSAGE}`);
  }
  return problems;
}

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
// DB-SETUP: PG_DATABASE_URL left database.env: it is an interpolation value of compose.env (the committed APP_URL_EXPR on
// db-setup, rab-api and rab-worker would silently override an env-file value).
const DATABASE_ALLOWED = Object.freeze([
  'PG_SSL_CA_CERT_PATH', 'PG_SSL_CA_CERT', 'PG_EXPECTED_DATABASE_NAME', 'CREWFLOW_DEPLOYMENT_ENVIRONMENT', 'CREWFLOW_DEPLOYMENT_ID',
]);
/** DB-SETUP: the only non-CREWFLOW_* names compose.env may hold (the two URLs and the bundled db's two passwords). */
const COMPOSE_DATABASE_KEYS = Object.freeze([ADMIN_URL_KEY, ADMIN_DIRECT_URL_KEY, URL_KEY, DB_PASSWORD_KEY, APP_PASSWORD_KEY, DB_HOST_KEY, DB_PORT_KEY, DB_NAME_KEY]);
/**
 * BC-11 opt-ins: database.env only (so rab-api and rab-worker see one value), never committed in compose. O3: the approval
 * mode is no longer one of them (below).
 */
const DATABASE_OPT_INS = Object.freeze(['CREWFLOW_DEPLOYMENT_ENVIRONMENT', 'CREWFLOW_DEPLOYMENT_ID']);
/**
 * Keys that belong in database.env only (read by db-setup, rab-api and rab-worker alike), so runtime.env refuses them: the
 * opt-ins above plus the database CA. Kept apart from DATABASE_OPT_INS because the production compose file commits the CA
 * keys as bare optional entries (no value), which the "never a compose value" model check on the opt-ins would refuse.
 */
const DATABASE_ENV_ONLY = Object.freeze([...DATABASE_OPT_INS, 'PG_SSL_CA_CERT', 'PG_SSL_CA_CERT_PATH']);
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
/**
 * The former separated runtime logins and schema roles: never a db-setup URL login (they are NOLOGIN schema roles or cannot
 * create roles, so they are neither crewflow_owner nor an admin). DB-SETUP T-1 relaxes ONLY the database admin login (any
 * login that can create roles, e.g. the cluster superuser or a managed service's admin), and only in PG_ADMIN_URL.
 */
const NOT_THE_APP_LOGIN = Object.freeze([
  'crewflow', 'crewflow_app', 'crewflow_worker', 'crewflow_migrator', 'rab_owner', 'rab_secure_owner', 'rab_app',
]);
/** The bundled db's superuser password: interpolated into a URL, so URL-safe characters only, and long. */
const DB_PASSWORD_SHAPE = /^[A-Za-z0-9._~-]{32,}$/;
/** The bundled crewflow_owner password: interpolated unencoded into PG_DATABASE_URL; db-setup.sh refuses anything else. */
const APP_PASSWORD_SHAPE = /^[A-Za-z0-9_-]{32,}$/;
/**
 * Owner decision 2026-11-19 (provider-neutral, by capability): no host-name or port rule for a connection pooler. db-setup
 * refuses a pooled admin connection by what it does (08P01 for its session settings, or the session-affinity probe).
 * sslmode (owner rule 2026-11-19, the same at runtime, #257): require, verify-ca and verify-full are accepted for EVERY database
 * URL (PG_DATABASE_URL, PG_DATABASE_SESSION_URL, PG_ADMIN_URL, PG_ADMIN_DIRECT_URL) and all mean FULL verification (certificate
 * and host name); disable, allow, prefer, no-verify and a missing sslmode are refused. channel_binding=require is accepted.
 */
const ACCEPTED_SSLMODES = Object.freeze(['require', 'verify-ca', 'verify-full']);
/** The sslmode rule above for one parsed URL (null = fine). Exported for the PG_DATABASE_SESSION_URL rule of PR #258. */
function sslmodeProblem(key, u) {
  return ACCEPTED_SSLMODES.includes(u.searchParams.get('sslmode') ?? '')
    ? null
    : `${key}: sslmode must be require, verify-ca or verify-full (all mean full verification); disable, allow, prefer, no-verify or none are refused`;
}
const DIGEST_REF = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

/**
 * The database settings rule (owner decisions 2026-11-17 and 2026-11-18, Twenty's way), ONE definition for the compose.env
 * lint and the deployed-model --environment preflight (staging/verify-image-compose.cjs). Pure; names and rules only, never
 * a value. Inputs: the raw values of PG_ADMIN_URL / PG_DATABASE_URL (undefined or '' = not set), CREWFLOW_BUNDLED_DB ('0' or
 * '1'; undefined = '1'), whether PG_DATABASE_PASSWORD and PG_DATABASE_APP_PASSWORD are set. `template`: a <placeholder> URL
 * is not parsed.
 *   (a) bundled (1), no PG_ADMIN_URL, no PG_DATABASE_URL: PG_DATABASE_PASSWORD AND PG_DATABASE_APP_PASSWORD REQUIRED (compose
 *       builds the crewflow_owner URL from the latter; compose demands neither with `:?`, so this, db, db-setup and the
 *       entrypoints do). With the bundled db and no PG_ADMIN_URL, a PG_DATABASE_URL must name the bundled host `db`;
 *   (b) own database (0) + PG_ADMIN_URL + PG_DATABASE_URL (both set is NORMAL): the same database (host, port, database),
 *       neither host the bundled `db`;
 *   (c) own database (0) + PG_DATABASE_URL only, its host not `db`;
 *   PG_ADMIN_URL always needs PG_DATABASE_URL (the crewflow_owner URL whose password db-setup sets); with 0,
 *   PG_DATABASE_PASSWORD and PG_DATABASE_APP_PASSWORD are refused (unused: no dummy password); PG_DATABASE_APP_PASSWORD is
 *   refused beside a PG_DATABASE_URL (it would never be used). PG_DATABASE_URL's login ONLY crewflow_owner; PG_ADMIN_URL's
 *   login never crewflow_owner; each URL a postgres:// URL, verify-full, a direct host, with a login and a password, never
 *   a former separated login.
 * `appPasswordSet` must be passed (fail closed: unset = not set, so the bundled mode then reports it missing).
 */
function dbSettingsProblems({
  adminUrl,
  adminDirectUrl,
  appUrl,
  dbHost,
  dbPort,
  dbName,
  bundled = '1',
  passwordSet = false,
  appPasswordSet = false,
  template = false,
} = {}) {
  const problems = [];
  const has = (v) => v !== undefined && v !== null && String(v) !== '';
  const own = String(bundled) === '0';
  const placeholder = (v) => template && /<[^>]*>/.test(String(v));
  // The parsed target of a URL (null: unset, a placeholder or not parseable: the per-URL rules below report it).
  const target = (url) => {
    if (!has(url) || placeholder(url)) return null;
    try {
      const u = new URL(String(url));
      return { host: u.hostname.toLowerCase(), port: u.port || '5432', database: decodeURIComponent(u.pathname.replace(/^\//, '')) };
    } catch { return null; }
  };
  // Owner decision 2026-11-19: with PG_ADMIN_DIRECT_URL, db-setup connects there; PG_ADMIN_URL then only has to name the same
  // login and database (it may be a pooled address pasted as-is).
  const admin = target(has(adminDirectUrl) ? adminDirectUrl : adminUrl);
  // Owner decision 2026-11-19 ("You set one shared password"): without PG_DATABASE_URL, compose builds the crewflow_owner URL
  // from PG_DATABASE_APP_PASSWORD and PG_DATABASE_HOST / PG_DATABASE_PORT / PG_DATABASE_NAME (APP_URL_EXPR).
  const built = !has(appUrl) && appPasswordSet;
  const addressSet = has(dbHost) || has(dbPort) || has(dbName);
  const app = built
    ? { host: String(has(dbHost) ? dbHost : DB_SERVICE).toLowerCase(), port: String(has(dbPort) ? dbPort : '5432'), database: String(has(dbName) ? dbName : 'crewflow') }
    : target(appUrl);
  if (has(adminDirectUrl) && !has(adminUrl)) problems.push(`${ADMIN_DIRECT_URL_KEY}: needs ${ADMIN_URL_KEY} (it is only the direct address of that login)`);
  if (has(adminDirectUrl) && has(adminUrl) && !placeholder(adminUrl) && !placeholder(adminDirectUrl)) {
    try {
      const a = new URL(String(adminUrl));
      const d = new URL(String(adminDirectUrl));
      if (a.username !== d.username || a.pathname !== d.pathname) problems.push(`${ADMIN_DIRECT_URL_KEY}: must name the same login and database as ${ADMIN_URL_KEY} (only the address may differ)`);
    } catch { /* the per-URL rules below report an unparseable URL */ }
  }
  if (has(dbPort) && !/^[0-9]{1,5}$/.test(String(dbPort))) problems.push(`${DB_PORT_KEY}: a port number`);
  if (has(dbHost) && !/^[A-Za-z0-9.-]+$/.test(String(dbHost)) && !placeholder(dbHost)) problems.push(`${DB_HOST_KEY}: a host name only (no scheme, port, login or path)`);
  if (has(dbName) && !/^[A-Za-z0-9_-]+$/.test(String(dbName)) && !placeholder(dbName)) problems.push(`${DB_NAME_KEY}: a database name only`);
  if (has(appUrl) && addressSet) problems.push(`${DB_HOST_KEY} / ${DB_PORT_KEY} / ${DB_NAME_KEY}: remove them: ${URL_KEY} is set, so they are never used`);
  if (!own && !passwordSet) problems.push(`${DB_PASSWORD_KEY}: required for the bundled database (${BUNDLED_DB_KEY} unset or 1; openssl rand -hex 32). With your own database set ${BUNDLED_DB_KEY}=0 and ${URL_KEY} (plus ${ADMIN_URL_KEY}) instead`);
  if (own && passwordSet) problems.push(`${DB_PASSWORD_KEY}: remove it with ${BUNDLED_DB_KEY}=0 (there is no bundled database; it would only sit unused in db-setup's definition)`);
  if (has(appUrl) && appPasswordSet) {
    problems.push(`${APP_PASSWORD_KEY}: set it OR ${URL_KEY}, never both (two sources of the crewflow_owner password could disagree; with ${URL_KEY} set, ${APP_PASSWORD_KEY} is never used)`);
  }
  if (own && built && !has(dbHost)) problems.push(`${DB_HOST_KEY}: required with ${BUNDLED_DB_KEY}=0 and ${APP_PASSWORD_KEY} (copy the host, and ${DB_NAME_KEY} / ${DB_PORT_KEY}, from your database's direct address)`);
  if (!own && addressSet && !has(adminUrl)) problems.push(`${DB_HOST_KEY} / ${DB_PORT_KEY} / ${DB_NAME_KEY}: only for your own database (${BUNDLED_DB_KEY}=0 and ${ADMIN_URL_KEY}); the bundled db is db:5432/crewflow`);
  if (!own && !has(adminUrl) && !has(appUrl) && !appPasswordSet) {
    problems.push(`${APP_PASSWORD_KEY}: required for the bundled database (the crewflow_owner password; openssl rand -hex 32): compose builds ${URL_KEY} from it for db-setup, rab-api and rab-worker`);
  }
  if (has(adminUrl) && !has(appUrl) && !appPasswordSet) problems.push(`${ADMIN_URL_KEY} needs ${APP_PASSWORD_KEY} (openssl rand -hex 32) and ${DB_HOST_KEY}, or ${URL_KEY}: the crewflow_owner password db-setup creates crewflow_owner with, and that rab-api and rab-worker use`);
  if (own) {
    if (!has(appUrl) && !appPasswordSet) problems.push(`${BUNDLED_DB_KEY}: 0 (no bundled db) needs your own database's crewflow_owner URL in ${URL_KEY} (a host other than the bundled ${DB_SERVICE}), plus ${ADMIN_URL_KEY} to have db-setup create crewflow_owner`);
    for (const [key, t] of [[has(adminDirectUrl) ? ADMIN_DIRECT_URL_KEY : ADMIN_URL_KEY, admin], [built ? DB_HOST_KEY : URL_KEY, app]]) {
      if (t && t.host === DB_SERVICE) problems.push(`${BUNDLED_DB_KEY}: 0 (no bundled db), but ${key} names the bundled host ${DB_SERVICE}: use your own database's host`);
    }
  } else if (!has(adminUrl) && app && app.host !== DB_SERVICE) {
    problems.push(`${URL_KEY}: with the bundled db (${BUNDLED_DB_KEY} unset or 1) and no ${ADMIN_URL_KEY}, db-setup creates crewflow_owner in the bundled db, so ${URL_KEY} must name it (host ${DB_SERVICE}) or stay unset (then set ${APP_PASSWORD_KEY}); your own database: ${BUNDLED_DB_KEY}=0`);
  }
  if (admin && app && (admin.host !== app.host || admin.port !== app.port || admin.database !== app.database)) {
    problems.push(
      `${has(adminDirectUrl) ? ADMIN_DIRECT_URL_KEY : ADMIN_URL_KEY} and ${built ? `${DB_HOST_KEY} / ${DB_PORT_KEY} / ${DB_NAME_KEY}` : URL_KEY} name different databases (host, port or database differ): both must name the same database (db-setup creates crewflow_owner there; rab-api and rab-worker connect there)`,
    );
  }
  // With PG_ADMIN_DIRECT_URL, PG_ADMIN_URL is never connected to: only its login and database matter (checked above).
  for (const [key, url] of [has(adminDirectUrl) ? [ADMIN_DIRECT_URL_KEY, adminDirectUrl] : [ADMIN_URL_KEY, adminUrl], [URL_KEY, appUrl]]) {
    if (!has(url) || placeholder(url)) continue;
    let u = null;
    try { u = new URL(String(url)); } catch { problems.push(`${key}: not a parseable URL`); }
    if (!u) continue;
    const login = decodeURIComponent(u.username);
    if (!/^postgres(ql)?:$/.test(u.protocol)) problems.push(`${key}: not a postgres:// URL`);
    if (login === '') problems.push(`${key}: has no login`);
    else if (NOT_THE_APP_LOGIN.includes(login)) problems.push(`${key}: logs in as a former separated login or schema role (use ${key === ADMIN_URL_KEY ? 'the database admin login' : OWNER_LOGIN})`);
    else if (key === URL_KEY && login !== OWNER_LOGIN) problems.push(`${URL_KEY}: is the app login and must log in as ${OWNER_LOGIN}; it is never an admin URL (an admin URL goes in ${ADMIN_URL_KEY}, db-setup only)`);
    else if (key !== URL_KEY && login === OWNER_LOGIN) problems.push(`${key}: logs in as ${OWNER_LOGIN}, the app login: put that URL in ${URL_KEY} instead and remove ${key} (db-setup then only checks it)`);
    const sslProblem = sslmodeProblem(key, u);
    if (sslProblem) problems.push(sslProblem);
    // Review of PR #230, I-4: the login is the URL's userinfo only; a `?user=` (or `password` / `host` / `dbname`) query
    // parameter would change who logs in or where, behind the login rules above (the URL policy refuses it at start too).
    for (const param of ['user', 'password', 'host', 'hostaddr', 'dbname']) if (u.searchParams.has(param)) problems.push(`${key}: has a ?${param}= query parameter (put the login in the URL's userinfo; never a query parameter)`);
    if (u.password === '') problems.push(`${key}: has no password`);
  }
  return problems;
}

/**
 * ADMIN_URL_PLACEMENT (owner requirement 2026-11-17: rab-api and rab-worker must NEVER receive PG_ADMIN_URL; owner decision
 * L-2: they pin it to the empty literal). Raw-text rule for EVERY compose file in the repository (ADMIN_URL_SCAN_ROOTS),
 * before any rendering. Outside the `db-setup` service block, the token PG_ADMIN_URL may appear ANYWHERE on a line (map or
 * list form, a flow mapping `{ PG_ADMIN_URL: x }`, an interpolation, a merged `x-...` block) only as the exact pin
 * `PG_ADMIN_URL: ""` (or `''`) inside rab-api / rab-worker (and the dev / QA `server` / `worker`); any other occurrence fails. `${PG_ADMIN_URL...}` is interpolated
 * only inside db-setup, once. The retired PG_DATABASE_ADMIN_URL appears nowhere, and db-setup's bundled-db URL
 * (CREWFLOW_BUNDLED_DB_ADMIN_URL) nowhere outside db-setup. Security review of PR #230, L-3: service headers may carry an
 * anchor, a tag or a merge (`name: &x`, `name: !tag`, `name: <<`), and NO anchor may be defined inside the db-setup block
 * (its header included): an alias of it merged into another service would copy the admin URL there. The rendered models
 * (checkModel / appCredentialProblems) then prove the same for env files and overlays. Pure; never prints a value.
 */
function adminUrlPlacementProblems(rel, text) {
  const problems = [];
  let top = null; // the current top-level key
  let service = null; // the current service under `services:`
  let serviceIndent = null; // the indentation of the service names (the first key under `services:`)
  const perService = new Map(); // ${PG_ADMIN_URL...} interpolations per admin service (at most one each)
  const ANCHOR = /(?:^|[\s:[{,-])&[A-Za-z0-9_.-]+/;
  const PIN = /^\s*PG_ADMIN_URL\s*:\s*(""|'')\s*$/;
  // The services that may carry that pin: production's rab-api / rab-worker and the dev / QA stacks' server / worker.
  const PIN_SERVICES = [...APP_SERVICES, 'server', 'worker'];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*#/.test(raw) || raw.trim() === '') return;
    const topKey = /^([A-Za-z0-9_.-]+)\s*:/.exec(raw);
    if (topKey) { top = topKey[1]; service = null; serviceIndent = null; return; }
    const svcKey = /^( +)([A-Za-z0-9_.-]+)\s*:\s*(&[A-Za-z0-9_.-]+|![A-Za-z0-9_.!/:-]+|<<)?\s*(#.*)?$/.exec(raw);
    if (top === 'services' && svcKey && (serviceIndent === null || svcKey[1].length === serviceIndent)) {
      serviceIndent = svcKey[1].length;
      service = svcKey[2];
      if (ADMIN_SERVICES.includes(service) && /^&/.test(svcKey[3] ?? '')) problems.push(`${rel}:${i + 1}: an anchor on the ${service} service (an alias of it would copy ${ADMIN_URL_KEY} into another service)`);
      return;
    }
    // Owner decision 2026-11-18 (M1): db-harden holds the same admin login as db-setup, under the same rules.
    const inSetup = top === 'services' && ADMIN_SERVICES.includes(service);
    const where = top === 'services' ? `service ${service ?? '?'}` : `top-level ${top ?? '?'}`;
    const line = raw.replace(/\s+#.*$/, '');
    if (inSetup && ANCHOR.test(line)) problems.push(`${rel}:${i + 1}: an anchor defined inside the ${service} service (an alias of it would copy ${ADMIN_URL_KEY} into another service)`);
    if (!inSetup && /\bPG_ADMIN_URL\b/.test(line) && !(top === 'services' && PIN_SERVICES.includes(service) && PIN.test(line))) {
      problems.push(`${rel}:${i + 1}: ${ADMIN_URL_KEY} in ${where} (only the one-shot db-setup and db-harden services may receive it; rab-api / rab-worker only pin it to "")`);
    }
    // `$$` is Compose's escape for a literal `$` (db-setup's wait-for-db wrapper reads the variable in its own shell): only
    // an unescaped `${PG_ADMIN_URL...}` is an interpolation.
    if (line.split('$$').join('').includes('${PG_ADMIN_URL')) {
      if (!inSetup) problems.push(`${rel}:${i + 1}: \${PG_ADMIN_URL...} interpolated in ${where} (db-setup and db-harden only)`);
      else perService.set(service, (perService.get(service) ?? 0) + 1);
    }
    for (const retired of RETIRED_ADMIN_URL_KEYS) {
      if (new RegExp(`\\b${retired}\\b`).test(line)) problems.push(`${rel}:${i + 1}: ${retired} (renamed to ${ADMIN_URL_KEY})`);
    }
    if (!inSetup && /\bPG_ADMIN_DIRECT_URL\b/.test(line)) problems.push(`${rel}:${i + 1}: ${ADMIN_DIRECT_URL_KEY} in ${where} (the direct admin address; db-setup and db-harden only)`);
    if (!inSetup && /\bCREWFLOW_BUNDLED_DB_ADMIN_URL\b/.test(line)) problems.push(`${rel}:${i + 1}: ${BUNDLED_ADMIN_URL_KEY} in ${where} (the bundled db's superuser URL; db-setup and db-harden only)`);
  });
  for (const [name, count] of perService) {
    if (count > 1) problems.push(`${rel}: interpolates \${PG_ADMIN_URL...} ${count} times in ${name} (one line per admin service)`);
  }
  return problems;
}

/** Where every compose file of the repository lives (ADMIN_URL_PLACEMENT scans each `*compose*.yml|yaml` below them). */
const ADMIN_URL_SCAN_ROOTS = Object.freeze([path.resolve(DOCKER_DIR, '..')]);
/** Every compose file below ADMIN_URL_SCAN_ROOTS (node_modules, dist and dot directories skipped). */
function composeFilesInRepo(roots = ADMIN_URL_SCAN_ROOTS) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/compose.*\.ya?ml$/i.test(entry.name)) out.push(full);
    }
  };
  for (const root of roots) if (fs.existsSync(root)) walk(root);
  return out.sort();
}

/** First reason a NAME is forbidden for any service or env file, or null. */
function forbiddenReason(name) {
  if (name === URL_KEY || name === ADMIN_URL_KEY) return null;
  if (RETIRED_ADMIN_URL_KEYS.includes(name)) return `renamed to ${ADMIN_URL_KEY} (your database's admin URL, a compose.env value for db-setup only); ${URL_KEY} is ALWAYS the app login (crewflow_owner)`;
  if (name === BUNDLED_ADMIN_URL_KEY) return `committed on db-setup only (the bundled db's superuser URL, built from ${DB_PASSWORD_KEY}); never an env file entry or another service's variable`;
  if (name === DB_PASSWORD_KEY) return 'an interpolation value of compose.env only (the bundled db and the default admin URL); never a container variable or an env file entry';
  if (name === APP_PASSWORD_KEY) return `an interpolation value of compose.env only (the bundled db's crewflow_owner password, built into ${URL_KEY}); never a container variable or an env file entry`;
  if (name === 'CREWFLOW_MIGRATION_APPROVED') return 'the approval token (O3: approval mode none; there is no token to pass)';
  if (name === 'CREWFLOW_UPGRADE_INCOMPLETE') return 'retired with the C3 continue path (OWNER-DB-ULTIMATE Part B3; api-prestart.sh refuses an inherited value)';
  if (name === 'CREWFLOW_UPGRADE_FAILURE' || name === 'CREWFLOW_UPGRADE_FAILURE_POLICY') return 'removed (OWNER-DB-ULTIMATE Part B3): a failed migration always refuses to start and is retried on the next start; there is nothing to choose';
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

/** Docker's own volume store on the host (rootful and rootless): a bind into it reaches any named volume's files. */
const DOCKER_VOLUME_STORE = /(^|\/)(var\/lib\/docker|\.local\/share\/docker)(\/|$)/;
const CREWFLOW_RUN_DIR = '/run/crewflow';
const underDir = (target, dir) => target === dir || target.startsWith(`${dir}/`);
/**
 * Security re-review F2: a bind of the Docker root or ANY of its ancestors reaches the volume store as well (`/`, `/var`,
 * `/var/lib`; rootless: a home directory, `~/.local`, `~/.local/share`).
 */
const DOCKER_ROOT_ANCESTOR = /^\/(var(\/lib)?|home|home\/[^/]+(\/\.local(\/share)?)?|root(\/\.local(\/share)?)?)?$/;
/** The services that hold the crewflow_owner credential (PG_DATABASE_URL): their namespaces are never shared. */
const PASSWORD_VOLUME_SERVICES = ['rab-api', 'rab-worker', 'db-setup', 'db-harden'];
/** A container path as the engine resolves it: relative to `base`, `..` and `//` collapsed. */
const containerPath = (target, base) => path.posix.resolve(base, String(target ?? '').replace(/\\/g, '/'));

/**
 * Security review L3 (one definition for both gates; verify-image-compose.cjs imports it), kept after owner decision
 * 2026-11-18 removed the setup volume: every way a service could reach another service's files or credentials besides a
 * plain `volumes:` entry (checked where the mounts are):
 *   - `volumes_from` on ANY service (it copies another service's mounts);
 *   - a `secrets` / `configs` entry whose target resolves under /run/crewflow (it would shadow or plant a file there, e.g.
 *     the bundled db's CA);
 *   - a bind whose host source is inside Docker's volume store (/var/lib/docker/volumes/..., rootless ~/.local/share/docker):
 *     it reaches every named volume's files directly (the bundled db's data and TLS key included);
 *   - ANY mount or `tmpfs` at or under /run/crewflow/db-target, on any service (`..` and `//` collapsed first): the retired
 *     setup volume's path, which must never come back unreviewed;
 *   - rab-redis not running as uid 999 (`user: 999:<gid>`): never uid 1000, the uid of the services that hold
 *     PG_DATABASE_URL.
 * `redisUser: false` skips the last rule (the OpenShip reference file's rab-redis has no `user:`).
 * Pure: never prints a value.
 */
function credentialMountProblems(services, where = '', { redisUser = true } = {}) {
  const out = [];
  for (const [name, s] of Object.entries(services ?? {})) {
    if (!s || typeof s !== 'object') continue;
    if (s.volumes_from !== undefined && !(Array.isArray(s.volumes_from) && s.volumes_from.length === 0)) {
      out.push(`${name}: has volumes_from${where} (it copies another service's mounts)`);
    }
    for (const [kind, base] of [['secrets', '/run/secrets'], ['configs', '/']]) {
      for (const e of Array.isArray(s[kind]) ? s[kind] : []) {
        const raw = typeof e === 'string' ? e : e?.target ?? e?.source ?? '';
        if (underDir(containerPath(raw, base), CREWFLOW_RUN_DIR)) out.push(`${name}: a ${kind} entry targets ${CREWFLOW_RUN_DIR}${where} (never a file under the database setup's directories)`);
      }
    }
    for (const v of Array.isArray(s.volumes) ? s.volumes : []) {
      const source = String(v?.source ?? '').replace(/\\/g, '/');
      if (v?.type === 'bind' && DOCKER_VOLUME_STORE.test(source)) out.push(`${name}: binds a path inside Docker's volume store${where} (it reaches named volumes' files, the bundled db's data and TLS key included)`);
      const t = containerPath(v?.target, '/');
      if (underDir(t, DB_TARGET_DIR)) {
        out.push(`${name}: mounts something at ${t}${where} (the retired ${DB_TARGET_VOLUME} path: owner decision 2026-11-18, no file carries a database credential; PG_DATABASE_URL comes from the environment)`);
      }
    }
    // F2: a bind of the Docker root's ancestors; namespace sharing with the three services that hold the password file.
    for (const v of Array.isArray(s.volumes) ? s.volumes : []) {
      const source = String(v?.source ?? '').replace(/\\/g, '/');
      if (v?.type === 'bind' && source.startsWith('/') && DOCKER_ROOT_ANCESTOR.test(path.posix.normalize(source).replace(/\/+$/, '') || '/')) {
        out.push(`${name}: binds an ancestor of Docker's root directory${where} (it reaches the volume store, the bundled db's data and TLS key included)`);
      }
    }
    for (const key of ['pid', 'ipc', 'network_mode']) {
      const value = String(s[key] ?? '');
      const m = /^service:(.+)$/.exec(value);
      if (/^container:/.test(value)) out.push(`${name}: ${key} joins another container's namespace${where} (container:..., never)`);
      else if (m && PASSWORD_VOLUME_SERVICES.includes(m[1])) out.push(`${name}: ${key} shares the namespace of ${m[1]}${where} (it could read that service's files through /proc)`);
    }
    const tmpfs = s.tmpfs === undefined || s.tmpfs === null ? [] : Array.isArray(s.tmpfs) ? s.tmpfs : [s.tmpfs];
    for (const entry of tmpfs) {
      const t = containerPath(String(entry).split(':')[0], '/');
      if (underDir(t, DB_TARGET_DIR)) out.push(`${name}: a tmpfs at ${t}${where} (the retired ${DB_TARGET_VOLUME} path; never mounted again)`);
    }
  }
  const redis = services?.['rab-redis'];
  if (redisUser && redis && !/^999:\d+$/.test(String(redis.user ?? ''))) {
    out.push(`rab-redis: user is "${redis.user ?? ''}"${where}, expected 999:<gid> (never uid 1000, the uid of the services that hold the crewflow_owner credential)`);
  }
  return out;
}

/**
 * Security re-review F2: the top-level volumes. Docker's name of a volume is `name`, else `<project>_<key>`. Owner decision
 * 2026-11-18: the setup volume is RETIRED, so no key may be crewflow-db-target and no volume may be named it (on any project
 * name, `external: true` aliases included). No volume may be a host bind through `driver_opts` (`o: bind`, or `type: none`
 * with a `device`); `strict` (the deployed model): no driver options and no driver but `local` on any volume. Pure.
 */
function topLevelVolumeProblems(model, where = '', { strict = false } = {}) {
  const out = [];
  const vols = model?.volumes && typeof model.volumes === 'object' ? model.volumes : {};
  const project = String(model?.name ?? '');
  const nameOf = (key, v) => String(v?.name ?? (project ? `${project}_${key}` : key));
  for (const [key, v] of Object.entries(vols)) {
    const name = nameOf(key, v);
    if (key === DB_TARGET_VOLUME || name === DB_TARGET_VOLUME || name.endsWith(`_${DB_TARGET_VOLUME}`)) {
      out.push(`volume ${key}: declares the retired ${DB_TARGET_VOLUME} volume${where} (owner decision 2026-11-18: no file carries a database credential; rab-api and rab-worker read PG_DATABASE_URL from their environment)`);
    }
    const opts = v?.driver_opts && typeof v.driver_opts === 'object' ? v.driver_opts : {};
    // R4 (the deployed model): no driver options and no driver but `local` on ANY volume.
    if (strict && (Object.keys(opts).length || (v?.driver !== undefined && v.driver !== 'local'))) {
      out.push(`volume ${key}: has driver options or a non-local driver${where} (never in a deployment: a host path or a remote store)`);
    }
    if (/(^|,)\s*r?bind\s*(,|$)/.test(String(opts.o ?? '')) || (String(opts.type ?? '') === 'none' && opts.device)) {
      out.push(`volume ${key}: is a host bind through driver_opts${where} (never: it can reach the Docker volume store)`);
    }
  }
  return out;
}

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
    const dbClient = [...APP_SERVICES, ...ADMIN_SERVICES].includes(name);
    const dbCaMount = dbClient && v.target === DB_CA_TARGET && v.source === DB_CA_VOLUME;
    if (v.type === 'volume' && !((name === 'rab-redis' && v.target === '/data') || (name === DB_SERVICE && DB_VOLUMES[v.target] === v.source) || dbCaMount)) {
      p(`${name}: unexpected named volume at ${v.target}`);
    }
    if (v.type === 'volume' && dbCaMount && v.read_only !== true) p(`${name}: the bundled db's CA volume must be mounted read-only`);
    // Owner decision 2026-11-18: the setup volume is retired; nothing is ever mounted at (or under) its path again.
    const mountTarget = String(v.target ?? '');
    if (mountTarget === DB_TARGET_DIR || mountTarget.startsWith(`${DB_TARGET_DIR}/`)) {
      p(`${name}: mounts something at ${mountTarget} (the retired ${DB_TARGET_VOLUME} path: no file carries a database credential any more)`);
    }
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
function bundledDbProblems(services, model, p, { replicas: wantReplicas = 1, expectedPassword = SENTINEL_DB_PW } = {}) {
  const db = services[DB_SERVICE];
  if (!db) { p(`${DB_SERVICE}: missing (the bundled database)`); return; }
  // Twenty's Helm db.enabled: exactly ONE bundled server (one per data volume), or none (CREWFLOW_BUNDLED_DB=0 with your
  // own database). Never `scale`, never another replica count, never 0 while db-setup's URL is the bundled db.
  if ('scale' in db) p(`${DB_SERVICE}: has scale (its replica count is deploy.replicas, from ${BUNDLED_DB_KEY} only)`);
  const replicas = db.deploy?.replicas;
  if (replicas !== wantReplicas) {
    const why = wantReplicas === 0 ? `${BUNDLED_DB_KEY}=0 with your own database` : `one bundled server; 0 only with ${BUNDLED_DB_KEY}=0 and ${ADMIN_URL_KEY} or ${URL_KEY}`;
    p(`${DB_SERVICE}: deploy.replicas is ${replicas === undefined ? 'unset' : replicas}, expected ${wantReplicas} (${why})`);
  }
  // `docker compose config` renders empty deploy.resources / deploy.placement objects; anything in them is refused.
  for (const [key, value] of Object.entries(db.deploy ?? {})) {
    if (key !== 'replicas' && JSON.stringify(value) !== '{}') p(`${DB_SERVICE}: deploy.${key} is set (only deploy.replicas)`);
  }
  hardeningProblems(DB_SERVICE, db, p, { longRunning: true });
  // PR #124's rule for every deploy service: no profile (a profile-gated db would not start with the stack, or would hide).
  if (Array.isArray(db.profiles) && db.profiles.length) p(`${DB_SERVICE}: has profiles (it would not start with the stack)`);
  if (!DB_IMAGE.test(String(db.image ?? ''))) p(`${DB_SERVICE}: image is not the official postgres repository pinned by digest (postgres@sha256:<64 hex>)`);
  for (const msg of bundledDbEnvironmentProblems(db.environment ?? {}, { expectedPassword })) p(msg);
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
  // Security review of F2, M1: ONE server per data volume (the 2026-10-15 two-servers-one-volume corruption). The kernel lock
  // on a file in the data volume is taken first, before the entrypoint touches the volume or starts postgres.
  const lockAt = entry.search(/exec 8>\/var\/lib\/postgresql\/\.crewflow-server\.lock\n\s*flock -n 8 \|\| \{[^}]*exit 1; \}/);
  // Owner decision 2026-11-17 (no dummy password): POSTGRES_PASSWORD is ${PG_DATABASE_PASSWORD:-}, so the entrypoint itself
  // refuses an empty one (exit 64), FIRST: before the lock, the volume and postgres. Fail closed while the bundled db runs.
  const pwCheckAt = entry.search(/if \[ -z "\$\{POSTGRES_PASSWORD:-\}" \]; then\n[^\n]*PG_DATABASE_PASSWORD is required[^\n]*\n\s*exit 64\n\s*fi/);
  // Review of PR #230, I-2: on a FIRST initialisation (no PG_VERSION in PGDATA yet) the password must be 32+ of A-Z a-z 0-9 _ -.
  const shapeAt = entry.search(/if \[ ! -s "\$\{PGDATA\}\/PG_VERSION" \]; then\n\s*case "\$\{POSTGRES_PASSWORD\}" in\n\s*\*\[!A-Za-z0-9_-\]\*\) crewflow_pw_ok=no ;;\n[^\n]*-ge 32 \][^\n]*\n\s*esac\n[^\n]*\n[^\n]*must be 32\+ characters[^\n]*\n\s*exit 64/);
  if (shapeAt < 0 || shapeAt > entry.indexOf('chmod') || (lockAt >= 0 && shapeAt > lockAt)) {
    p(`${DB_SERVICE}: the entrypoint does not refuse a weak ${DB_PASSWORD_KEY} (32+ of A-Z a-z 0-9 _ -) on a first initialisation, before it touches the volume`);
  }
  if (pwCheckAt < 0 || (lockAt >= 0 && pwCheckAt > lockAt) || pwCheckAt > entry.indexOf('chmod')) {
    p(`${DB_SERVICE}: the entrypoint does not refuse an empty POSTGRES_PASSWORD (${DB_PASSWORD_KEY}, exit 64) before it touches the volume (no compose \`:?\`: required only while the bundled db runs)`);
  }
  if (lockAt < 0 || lockAt > entry.indexOf('openssl') || lockAt > entry.indexOf('exec docker-entrypoint.sh')) {
    p(`${DB_SERVICE}: the entrypoint does not take the one-server lock (flock -n on /var/lib/postgresql/.crewflow-server.lock) before it touches the volume or starts postgres`);
  }
  if ((db.volumes ?? []).some((v) => String(v.target ?? '').startsWith('/docker-entrypoint-initdb.d'))) p(`${DB_SERVICE}: mounts an init script (the API creates crewflow_owner itself)`);
  if (JSON.stringify(Object.keys(db.networks ?? {})) !== JSON.stringify(['crewflow-db'])) p(`${DB_SERVICE}: must be on the internal crewflow-db network only`);
  if (model?.networks?.['crewflow-db']?.internal !== true) p('network crewflow-db is not internal');
  for (const target of Object.keys(DB_VOLUMES)) if (!(db.volumes ?? []).some((v) => v.type === 'volume' && v.target === target)) p(`${DB_SERVICE}: named volume ${DB_VOLUMES[target]} at ${target} is missing`);
  const hc = (db.healthcheck?.test ?? []).map(String).join(' ');
  if (!/pg_isready/.test(hc) || !/-h localhost/.test(hc)) p(`${DB_SERVICE}: health check is not pg_isready over TCP (the first-start init server is socket-only)`);
  // Owner instruction 2026-11-18 (Twenty's Helm wait-for-db): nothing depends on db (dbSetupStartProblems refuses
  // rab-api -> db; db-setup waits for the database itself).
  for (const [name, svc] of Object.entries(services)) {
    const deps = svc?.depends_on ?? {};
    if ((Array.isArray(deps) ? deps : Object.keys(deps)).includes(DB_SERVICE)) p(`${name}: depends on ${DB_SERVICE} (with CREWFLOW_BUNDLED_DB=0 it has no container; db-setup waits for the database itself)`);
  }
  for (const name of ['rab-api', 'rab-worker']) {
    if (!services[name]) continue;
    if (!Object.keys(services[name].networks ?? {}).includes('crewflow-db')) p(`${name}: is not on the crewflow-db network`);
    if (!(services[name].volumes ?? []).some((v) => v.type === 'volume' && v.source === DB_CA_VOLUME && v.target === DB_CA_TARGET && v.read_only === true)) {
      p(`${name}: does not mount the bundled db's CA read-only at ${DB_CA_TARGET}`);
    }
  }
  for (const [name, svc] of Object.entries(services)) {
    if (name !== DB_SERVICE && (svc.volumes ?? []).some((v) => v.type === 'volume' && v.source === 'crewflow-db-data')) p(`${name}: mounts the bundled db's data volume (its cluster and TLS key)`);
  }
}

/**
 * The one-shot db-setup service, the ONLY service that receives an admin login (PG_ADMIN_URL, or the bundled db's superuser
 * URL). Pure. `want`: its rendered database environment, exactly ({PG_ADMIN_URL, PG_DATABASE_URL, CREWFLOW_BUNDLED_DB,
 * CREWFLOW_BUNDLED_DB_ADMIN_URL}: compose.env's values, the crewflow_owner URL rab-api / rab-worker also receive, and the
 * bundled db's superuser URL); a string (the pre-2026-11-17 single URL) is never accepted.
 */
function dbSetupProblems(services, p, want) {
  const s = services[DB_SETUP_SERVICE];
  if (!s) { p(`${DB_SETUP_SERVICE}: missing (the one-shot database setup; option 2)`); return; }
  const api = services['rab-api'] ?? {};
  hardeningProblems(DB_SETUP_SERVICE, s, p, { longRunning: false });
  if (Array.isArray(s.profiles) && s.profiles.length) p(`${DB_SETUP_SERVICE}: has profiles (it would not run with the stack, and rab-api would wait for it in vain)`);
  if (s.image !== api.image) p(`${DB_SETUP_SERVICE}: image differs from rab-api (O2: one image; the same bootstrap child)`);
  // Owner instruction 2026-11-18: the wait-for-db wrapper (the block of rab/db-setup.sh, then exec ./db-setup.sh), no
  // depends_on, CREWFLOW_DB_WAIT_SECONDS as committed (rendered from sentinel env files that do not set it: the default).
  for (const msg of dbSetupStartProblems(services, { requireWait: true, renderedWait: WAIT_SECONDS_DEFAULT })) p(msg);
  if (Array.isArray(s.command) ? s.command.length > 0 : (s.command !== undefined && s.command !== null)) p(`${DB_SETUP_SERVICE}: has a command (db-setup.sh takes none)`);
  if (s.init === true) p(`${DB_SETUP_SERVICE}: init: true (no compose init: the script runs as PID 1 and exits)`);
  if (s.restart !== 'no') p(`${DB_SETUP_SERVICE}: restart is "${s.restart ?? ''}", expected "no" (a one-shot: it exits after the setup)`);
  if ((s.ports ?? []).length) p(`${DB_SETUP_SERVICE}: publishes a port`);
  if (s.user !== '1000:1000') p(`${DB_SETUP_SERVICE}: user is "${s.user ?? ''}", expected 1000:1000 (the image's non-root node user, as rab-api and rab-worker)`);
  const replicas = s.deploy?.replicas ?? s.scale;
  if (replicas !== undefined && Number(replicas) !== 1) p(`${DB_SETUP_SERVICE}: ${replicas} replicas (exactly one)`);
  if (!Object.keys(s.networks ?? {}).includes('crewflow-db')) p(`${DB_SETUP_SERVICE}: is not on the crewflow-db network`);
  const vols = s.volumes ?? [];
  if (!vols.some((v) => v.type === 'volume' && v.source === DB_CA_VOLUME && v.target === DB_CA_TARGET && v.read_only === true)) p(`${DB_SETUP_SERVICE}: does not mount the bundled db's CA read-only at ${DB_CA_TARGET}`);

  const env = s.environment ?? {};
  const expected = want && typeof want === 'object' ? want : {};
  for (const key of DB_SETUP_DB_KEYS) {
    if (!(key in env)) p(`${DB_SETUP_SERVICE}: ${key} is missing (committed: \${PG_ADMIN_URL:-}, the crewflow_owner URL expression, \${CREWFLOW_BUNDLED_DB:-1} and the bundled db's URL from \${PG_DATABASE_PASSWORD:-})`);
    else if (String(env[key]) !== String(expected[key] ?? '')) p(`${DB_SETUP_SERVICE}: ${key} is not the committed value (compose.env's, or the bundled db's URL; value not shown)`);
  }
  for (const key of RETIRED_ADMIN_URL_KEYS) if (key in env) p(`${DB_SETUP_SERVICE}: has ${key} (renamed to ${ADMIN_URL_KEY})`);
  if (env.NODE_ENV !== 'production') p(`${DB_SETUP_SERVICE}: NODE_ENV is not production`);
  if (env.RAB_RUNTIME_ENV !== 'production') p(`${DB_SETUP_SERVICE}: RAB_RUNTIME_ENV is not production`);
  // Twenty Helm model: APP_SECRET is never part of a database credential; db-setup does not receive it (db-setup.sh refuses it).
  if ('APP_SECRET' in env) p(`${DB_SETUP_SERVICE}: has APP_SECRET (never part of a database credential; db-setup must not receive it)`);
  const setupFiles = (s.env_file ?? []).map((e) => String(typeof e === 'string' ? e : e.path ?? ''));
  if (setupFiles.some((f) => /(^|\/)runtime\.env$/.test(f))) p(`${DB_SETUP_SERVICE}: reads runtime.env (it needs only database.env: no runtime secret reaches db-setup)`);
  if (api.depends_on?.[DB_SETUP_SERVICE]?.condition !== 'service_completed_successfully') p(`rab-api: does not wait for ${DB_SETUP_SERVICE} (depends_on: condition: service_completed_successfully)`);
  for (const [name, svc] of Object.entries(services)) {
    if ((svc.volumes ?? []).some((v) => v.source === DB_TARGET_VOLUME)) p(`${name}: mounts the retired ${DB_TARGET_VOLUME} volume (owner decision 2026-11-18: no file carries a database credential)`);
  }
}

/**
 * Owner decision 2026-11-18 (security review of PR #246, M1): the one-shot db-harden service. Pure. Exactly db-setup's
 * shape and database environment (`want`, the same object db-setup is checked against), with three differences: the
 * entrypoint is `./db-setup.sh harden`; it has NO depends_on at all (it polls the database and the ledger by itself, and
 * OpenShip drops depends_on conditions anyway); its bounded wait (CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS, `timeout`: the
 * rendered value, 60-7200); and db-setup's CREWFLOW_DB_WAIT_SECONDS for the database wait in db-setup.sh. And NO service
 * may depend on it: rab-api and rab-worker must never wait for the hardening.
 */
function dbHardenProblems(services, p, want, timeout = '1200') {
  const name = DB_HARDEN_SERVICE;
  for (const [other, svc] of Object.entries(services)) {
    const deps = svc?.depends_on;
    const keys = Array.isArray(deps) ? deps : Object.keys(deps ?? {});
    if (keys.includes(name)) p(`${other}: depends on ${name} (nothing may wait for the CREATEROLE hardening; it never blocks rab-api or rab-worker)`);
  }
  const s = services[name];
  if (!s) { p(`${name}: missing (the one-shot CREATEROLE hardening; owner decision 2026-11-18, M1)`); return; }
  const api = services['rab-api'] ?? {};
  hardeningProblems(name, s, p, { longRunning: false });
  if (Array.isArray(s.profiles) && s.profiles.length) p(`${name}: has profiles (it would not run with the stack, and CREATEROLE would stay)`);
  if (s.image !== api.image) p(`${name}: image differs from rab-api (one image; the same bootstrap child as db-setup)`);
  if (JSON.stringify(s.entrypoint ?? null) !== JSON.stringify(HARDEN_ENTRYPOINT)) p(`${name}: entrypoint is not exactly ./db-setup.sh harden`);
  if (Array.isArray(s.command) ? s.command.length > 0 : (s.command !== undefined && s.command !== null)) p(`${name}: has a command (the entrypoint carries its one argument)`);
  if (s.init === true) p(`${name}: init: true (no compose init: the script runs as PID 1 and exits)`);
  if (s.restart !== 'no') p(`${name}: restart is "${s.restart ?? ''}", expected "no" (a one-shot: it exits after the hardening or its bounded wait)`);
  if ((s.ports ?? []).length) p(`${name}: publishes a port`);
  if (s.user !== '1000:1000') p(`${name}: user is "${s.user ?? ''}", expected 1000:1000 (as db-setup)`);
  const replicas = s.deploy?.replicas ?? s.scale;
  if (replicas !== undefined && Number(replicas) !== 1) p(`${name}: ${replicas} replicas (exactly one)`);
  if (!Object.keys(s.networks ?? {}).includes('crewflow-db')) p(`${name}: is not on the crewflow-db network`);
  const vols = s.volumes ?? [];
  if (!vols.some((v) => v.type === 'volume' && v.source === DB_CA_VOLUME && v.target === DB_CA_TARGET && v.read_only === true)) p(`${name}: does not mount the bundled db's CA read-only at ${DB_CA_TARGET}`);
  const deps = s.depends_on;
  if (deps !== undefined && deps !== null && (Array.isArray(deps) ? deps.length : Object.keys(deps).length)) p(`${name}: has depends_on (it must not rely on depends_on conditions: it waits for the database and the ledger by itself)`);
  const env = s.environment ?? {};
  const expected = want && typeof want === 'object' ? want : {};
  for (const key of DB_SETUP_DB_KEYS) {
    if (!(key in env)) p(`${name}: ${key} is missing (the same database settings as db-setup)`);
    else if (String(env[key]) !== String(expected[key] ?? '')) p(`${name}: ${key} is not db-setup's committed value (value not shown)`);
  }
  if (!(HARDEN_TIMEOUT_KEY in env)) p(`${name}: ${HARDEN_TIMEOUT_KEY} is missing (committed as ${HARDEN_TIMEOUT_EXPR})`);
  else if (String(env[HARDEN_TIMEOUT_KEY]) !== String(timeout)) p(`${name}: ${HARDEN_TIMEOUT_KEY} is "${env[HARDEN_TIMEOUT_KEY]}", expected the committed ${HARDEN_TIMEOUT_EXPR} (rendered "${timeout}")`);
  else if (!hardenTimeoutOk(env[HARDEN_TIMEOUT_KEY])) p(`${name}: ${HARDEN_TIMEOUT_KEY} must be a whole number of seconds from ${HARDEN_TIMEOUT_MIN_S} to ${HARDEN_TIMEOUT_MAX_S}`);
  // Owner instruction 2026-11-18 (Twenty's Helm wait-for-db): db-harden waits for the database with db-setup.sh's own wait
  // block (no compose wrapper: `harden` exists only in images that have the block), bounded by db-setup's value.
  const setupWait = services[DB_SETUP_SERVICE]?.environment?.[WAIT_SECONDS_KEY];
  if (!(WAIT_SECONDS_KEY in env)) p(`${name}: ${WAIT_SECONDS_KEY} is missing (committed as \${${WAIT_SECONDS_KEY}:-${WAIT_SECONDS_DEFAULT}}, db-setup's value)`);
  else if (String(env[WAIT_SECONDS_KEY]) !== String(setupWait ?? WAIT_SECONDS_DEFAULT) || waitSecondsProblem(env[WAIT_SECONDS_KEY])) p(`${name}: ${WAIT_SECONDS_KEY} is not db-setup's committed value (0-900 whole seconds)`);
  for (const key of RETIRED_ADMIN_URL_KEYS) if (key in env) p(`${name}: has ${key} (renamed to ${ADMIN_URL_KEY})`);
  if (env.NODE_ENV !== 'production') p(`${name}: NODE_ENV is not production`);
  if (env.RAB_RUNTIME_ENV !== 'production') p(`${name}: RAB_RUNTIME_ENV is not production`);
  if ('APP_SECRET' in env) p(`${name}: has APP_SECRET (never part of a database credential)`);
  const files = (s.env_file ?? []).map((e) => String(typeof e === 'string' ? e : e.path ?? ''));
  if (files.some((f) => /(^|\/)runtime\.env$/.test(f))) p(`${name}: reads runtime.env (it needs only database.env, as db-setup)`);
}

/** A rendered db-harden timeout: a whole number of seconds within the child's bounds. */
function hardenTimeoutOk(value) {
  const v = String(value ?? '');
  return /^[0-9]{1,5}$/.test(v) && Number(v) >= HARDEN_TIMEOUT_MIN_S && Number(v) <= HARDEN_TIMEOUT_MAX_S;
}

/**
 * Owner decision 2026-11-18 (Twenty's way): rab-api and rab-worker receive PG_DATABASE_URL, the crewflow_owner URL, exactly
 * as committed (`expectedUrl`: the value the committed APP_URL_EXPR renders to, the SAME as db-setup's), and NOTHING else in
 * their whole rendered definition (environment, health check, entrypoint, command, labels, an overlay's additions) holds a
 * database credential or a postgres:// value: not the bundled db's superuser password, not an admin password, not a
 * crewflow_owner password outside PG_DATABASE_URL. PG_ADMIN_URL is pinned to "" (owner decision L-2). Pure; never prints a
 * value. Without `expectedUrl` only the shape is checked (a non-empty crewflow_owner URL that equals db-setup's).
 */
function appCredentialProblems(services, p, expectedUrl) {
  const setupUrl = services?.[DB_SETUP_SERVICE]?.environment?.[URL_KEY];
  for (const name of APP_SERVICES) {
    const s = services[name];
    if (!s) continue;
    const env = s.environment ?? {};
    // Owner requirement 2026-11-17 + owner decision L-2: PG_ADMIN_URL is pinned to the literal empty string (so an env-file
    // value can never reach the service); any other value is refused. Never the retired name, nor the bundled db's URL.
    if (!(ADMIN_URL_KEY in env)) p(`${name}: ${ADMIN_URL_KEY} is not pinned to "" (an env-file value would reach it; owner decision L-2)`);
    else if (env[ADMIN_URL_KEY] !== '') p(`${name}: has ${ADMIN_URL_KEY} with a value (the database admin URL reaches db-setup only; rab-api / rab-worker pin it to "")`);
    for (const key of [...RETIRED_ADMIN_URL_KEYS, BUNDLED_ADMIN_URL_KEY, BUNDLED_DB_KEY, APP_PASSWORD_KEY, DB_PASSWORD_KEY]) if (key in env) p(`${name}: has ${key} (db-setup's input or a compose.env value only)`);
    const url = env[URL_KEY];
    if (url === undefined || url === null || String(url) === '') p(`${name}: ${URL_KEY} is missing or empty (it is the crewflow_owner URL, committed as ${APP_URL_EXPR}; the entrypoint refuses an empty one)`);
    else {
      if (expectedUrl !== undefined && String(url) !== String(expectedUrl)) p(`${name}: ${URL_KEY} is not the committed crewflow_owner URL (compose.env's PG_DATABASE_URL, or the bundled db's built from ${APP_PASSWORD_KEY}; value not shown)`);
      if (setupUrl !== undefined && String(url) !== String(setupUrl)) p(`${name}: ${URL_KEY} differs from db-setup's (the URL db-setup creates or checks crewflow_owner for must be the one this service uses; value not shown)`);
      let login = '';
      try { login = decodeURIComponent(new URL(String(url)).username); } catch { /* reported below */ }
      if (login !== OWNER_LOGIN) p(`${name}: ${URL_KEY} does not log in as ${OWNER_LOGIN} (login not shown)`);
      if ([SENTINEL_DB_PW, SENTINEL_ADMIN_PW].some((v) => String(url).includes(v))) p(`${name}: ${URL_KEY} carries the bundled db's or the admin's password (it is always the crewflow_owner login)`);
    }
    // Everything but PG_DATABASE_URL: no credential, no postgres:// value anywhere in the definition.
    const rest = structuredClone(s);
    if (rest.environment) delete rest.environment[URL_KEY];
    const text = JSON.stringify(rest);
    if (DB_CREDENTIAL_SENTINELS.some((v) => text.includes(v))) p(`${name}: carries a database credential outside ${URL_KEY} (environment, health check, command or labels; never)`);
    if (isPgUrl(text)) p(`${name}: holds a postgres:// value outside ${URL_KEY} (a second database identity; never)`);
  }
}

/**
 * The bundled db's environment rules (PR #125 review, finding 6), shared by this gate (committed model) and
 * staging/verify-image-compose.cjs (the deployed model). Pure; names and rules only, never a value. `expectedPassword`:
 * the gate's sentinel (exact match); without it (a real deployment) the password must be present and URL-safe.
 */
function bundledDbEnvironmentProblems(env, { expectedPassword, requirePassword = true } = {}) {
  const out = [];
  const p = (m) => out.push(`${DB_SERVICE}: ${m}`);
  for (const [k, v] of Object.entries(env)) {
    if (k === URL_KEY || k === ADMIN_URL_KEY) p(`has ${k}`);
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
    if (password !== expectedPassword) p(`POSTGRES_PASSWORD must be exactly \${${DB_PASSWORD_KEY}:-} (T-2), nothing else`);
  } else if (requirePassword && !DB_PASSWORD_SHAPE.test(password)) p('POSTGRES_PASSWORD is missing or not 32+ URL-safe characters (PG_DATABASE_PASSWORD; required while the bundled db runs)');
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
  const expected = ['rab-api', 'rab-redis', 'rab-worker', DB_SERVICE, DB_SETUP_SERVICE, DB_HARDEN_SERVICE].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) p(`services are [${names.join(', ')}], expected [${expected.join(', ')}]`);
  const appServices = APP_SERVICES;
  // Owner modes (b) and (c) (the -no-db combos) render WITHOUT PG_DATABASE_PASSWORD / PG_DATABASE_APP_PASSWORD: no dummy
  // password.
  const passwordSet = combo.bundledDb !== 0;
  // The crewflow_owner URL every one of db-setup, rab-api and rab-worker must render: compose.env's (external, pass-through
  // and their -no-db forms), or the bundled db's built from PG_DATABASE_APP_PASSWORD (default, staging).
  const expectedAppUrl = combo.external ? SENTINEL_URL : BUNDLED_APP_URL;
  const setupWant = {
    [ADMIN_URL_KEY]: combo.external === 'admin' ? SENTINEL_ADMIN_URL : '',
    [URL_KEY]: expectedAppUrl,
    [BUNDLED_DB_KEY]: String(combo.bundledDb ?? 1),
    [BUNDLED_ADMIN_URL_KEY]: passwordSet ? BUNDLED_URL : BUNDLED_URL_NO_PASSWORD,
  };

  for (const name of names) {
    if (name === DB_SERVICE) continue; // bundledDbProblems
    const s = services[name] ?? {};
    if (!ADMIN_SERVICES.includes(name)) hardeningProblems(name, s, p, { longRunning: true }); // db-setup / db-harden: their own checks
    if (Array.isArray(s.profiles) && s.profiles.length) p(`${name}: has profiles (it would not start with the stack)`);
    const env = s.environment ?? {};
    for (const [key, value] of Object.entries(env)) {
      const setupKey = ADMIN_SERVICES.includes(name) && DB_SETUP_DB_KEYS.includes(key);
      const why = setupKey ? null : forbiddenReason(key);
      if (why) p(`${name}: environment has ${key} (${why})`);
      if (key !== URL_KEY && !setupKey && isPgUrl(value)) p(`${name}: environment ${key} holds a PostgreSQL URL (a second database identity)`);
    }
    if (!ADMIN_SERVICES.includes(name) && ADMIN_URL_KEY in env && !(appServices.includes(name) && env[ADMIN_URL_KEY] === '')) p(`${name}: has ${ADMIN_URL_KEY} (db-setup and db-harden only; rab-api / rab-worker pin it to "")`);
    if (name !== DB_HARDEN_SERVICE && HARDEN_TIMEOUT_KEY in env) p(`${name}: has ${HARDEN_TIMEOUT_KEY} (db-harden's own setting)`);
    const values = Object.values(env).map(String);
    if (values.some((v) => v.includes(SENTINEL_LEGACY_PW))) p(`${name}: received a value from a separated-mode env file (.env.migrate / .env.ops / per-service staging files)`);
    if (!ADMIN_SERVICES.includes(name) && !appServices.includes(name) && URL_KEY in env) p(`${name}: has ${URL_KEY} (only db-setup, db-harden, rab-api and rab-worker: the crewflow_owner URL)`);
    if (!appServices.includes(name) && values.some((v) => v.includes(SENTINEL_APP_SECRET) || v.includes(SENTINEL_REDIS_PW))) {
      p(`${name}: received a runtime secret (only rab-api and rab-worker read runtime.env; db-setup never)`);
    }
    // The crewflow_owner password: only db-setup, db-harden, rab-api and rab-worker, only inside their PG_DATABASE_URL, never another
    // key. The admin password: only db-setup, only in its PG_ADMIN_URL.
    for (const [key, value] of Object.entries(env)) {
      if (OWNER_PASSWORD_SENTINELS.some((v) => String(value ?? '').includes(v)) && !((ADMIN_SERVICES.includes(name) || appServices.includes(name)) && key === URL_KEY)) p(`${name}: received the database credential (${key})`);
      if (String(value ?? '').includes(SENTINEL_ADMIN_PW) && !(ADMIN_SERVICES.includes(name) && key === ADMIN_URL_KEY && combo.external === 'admin')) p(`${name}: received the database admin credential (${key})`);
    }
  }
  // Owner decision 2026-11-18: rab-api / rab-worker hold the committed crewflow_owner URL and no other database credential;
  // db-setup's exact shape.
  appCredentialProblems(services, p, expectedAppUrl);
  dbSetupProblems(services, p, setupWant);
  dbHardenProblems(services, p, setupWant);
  for (const msg of credentialMountProblems(services)) p(msg);
  for (const msg of topLevelVolumeProblems(model)) p(msg);
  // DB-SETUP: the bundled db's password reaches only db (POSTGRES_PASSWORD) and, inside the bundled URL, db-setup's
  // CREWFLOW_BUNDLED_DB_ADMIN_URL. Never under another key, never another service, never by its own name. Neither does
  // PG_DATABASE_APP_PASSWORD by its own name (only inside PG_DATABASE_URL).
  for (const name of names) {
    for (const [key, value] of Object.entries(services[name]?.environment ?? {})) {
      if (key === DB_PASSWORD_KEY) p(`${name}: environment has ${DB_PASSWORD_KEY} (compose.env only; it never reaches a container)`);
      if (key === APP_PASSWORD_KEY) p(`${name}: environment has ${APP_PASSWORD_KEY} (compose.env only; it reaches a container only inside ${URL_KEY})`);
      if (!String(value ?? '').includes(SENTINEL_DB_PW)) continue;
      const allowed = (name === DB_SERVICE && key === 'POSTGRES_PASSWORD') || (ADMIN_SERVICES.includes(name) && key === BUNDLED_ADMIN_URL_KEY);
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
  // Phase X3.1: every strict on/off switch the services receive is exactly true or false (or empty).
  for (const [name, svc] of [['rab-api', api], ['rab-worker', worker]]) if (svc) for (const msg of strictSwitchProblems(name, envOf(svc))) p(msg);

  // rab-api: the lifecycle.
  const apiEnv = envOf(api);
  // DB-SETUP PID 1 (lead decision 2026-11-12): api-prestart.sh is the ENTRYPOINT (PID 1); it runs the refusals (a stray admin
  // URL or second database credential) and only then execs the image's tini. No command (the script refuses none,
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
  bundledDbProblems(services, model, p, { replicas: combo.bundledDb ?? 1, expectedPassword: passwordSet ? SENTINEL_DB_PW : '' });
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
    const why = kind === 'compose' && (key === DB_PASSWORD_KEY || key === APP_PASSWORD_KEY) ? null : forbiddenReason(key);
    if (why) problems.push(`${key}: ${why}`);
    if (kind !== 'compose' && key === HARDEN_TIMEOUT_KEY) problems.push(`${key}: set it in compose.env (the interpolation file): db-harden's committed ${HARDEN_TIMEOUT_EXPR} would silently override a value here`);
    if (kind !== 'compose' && key === ADMIN_DIRECT_URL_KEY) problems.push(`${key}: set it in compose.env (the interpolation file): it belongs to db-setup and db-harden only`);
    if (kind !== 'compose' && [DB_HOST_KEY, DB_PORT_KEY, DB_NAME_KEY].includes(key)) problems.push(`${key}: set it in compose.env (the interpolation file): compose builds PG_DATABASE_URL from it`);
    if (kind !== 'compose' && key === ADMIN_URL_KEY) problems.push(`${key}: set it in compose.env (the interpolation file): it belongs to db-setup only, and rab-api / rab-worker refuse it (an env file here would hand the admin URL to them)`);
    if (COMMITTED_KEYS.includes(key)) problems.push(`${key}: committed in the compose files; never re-enter it in an env file`);
    if (kind !== 'compose' && key === WAIT_SECONDS_KEY) problems.push(`${key}: set it in compose.env (the interpolation file): db-setup's committed \${${WAIT_SECONDS_KEY}:-170} would silently override a value here`);
    if (kind === 'compose' && key === WAIT_SECONDS_KEY && waitSecondsProblem(value)) problems.push(waitSecondsProblem(value));
    if (kind !== 'compose' && key === URL_KEY) problems.push(`${key}: set it in compose.env (the interpolation file): db-setup, rab-api and rab-worker receive it from the committed \${PG_DATABASE_URL:-...} expression, which would override a value here`);
    if (kind === 'database' && !why && key !== URL_KEY && !DATABASE_ALLOWED.includes(key)) problems.push(`${key}: does not belong in the shared database file (only ${DATABASE_ALLOWED.join(', ')})`);
    if (kind === 'runtime' && DATABASE_ENV_ONLY.includes(key)) problems.push(`${key}: belongs in database.env only (so rab-api and rab-worker see the same value)`);
    // Review J2-1 (fail closed): a feature switch is exactly true or false once read the way Compose reads it.
    if (Object.hasOwn(FEATURE_SWEEPS, key) && !SWITCH_VALUES.includes(value)) problems.push(`${key}: must be exactly true or false (quotes and an inline # comment are read as Compose reads them)`);
    // Phase X3.1: the strict on/off switches (FEATURE_SWEEPS keys already checked above, empty included).
    else if (STRICT_SWITCHES.includes(key) && value !== '' && !SWITCH_VALUES.includes(value) && !(template && isPlaceholder(value))) problems.push(`${key}: ${STRICT_SWITCH_MESSAGE}`);
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
      if (key === APP_PASSWORD_KEY && value !== '' && !(template && isPlaceholder(value)) && !APP_PASSWORD_SHAPE.test(value)) {
        problems.push(`${key}: must be at least 32 characters of A-Z a-z 0-9 _ - (e.g. openssl rand -hex 32): it is interpolated unencoded into the bundled db's crewflow_owner URL (db-setup refuses anything else)`);
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
      if (key === BUNDLED_DB_KEY && !BUNDLED_DB_VALUES.includes(value)) problems.push(`${key}: must be exactly 0 or 1 (the bundled db off or on: one server per data volume)`);
      // Owner decision 2026-11-18 (M1): db-harden's bounded wait for the ledger; unset = 1200.
      if (key === HARDEN_TIMEOUT_KEY && value !== '' && !(template && isPlaceholder(value)) && !hardenTimeoutOk(value)) problems.push(`${key}: must be a whole number of seconds from ${HARDEN_TIMEOUT_MIN_S} to ${HARDEN_TIMEOUT_MAX_S} (db-harden's wait for the ledger; unset = 1200)`);
    }
    if (key !== URL_KEY && !(kind === 'compose' && (key === ADMIN_URL_KEY || key === ADMIN_DIRECT_URL_KEY)) && isPgUrl(value)) problems.push(`${key}: holds a PostgreSQL URL (a second database identity)`);
  }
  // The database CA: PG_SSL_CA_CERT (PEM text; in an env file one line with \n escapes) or PG_SSL_CA_CERT_PATH, never both
  // (pg-tls.ts refuses both at boot; the lint says so first). The value goes through the app's own rules (pg-ca-pem.cjs, the
  // parity-tested port of pg-tls.ts validatePgCaPem), so the lint refuses exactly what the boot would. Never echoed.
  const caInline = entries.find((e) => e.key === 'PG_SSL_CA_CERT' && e.value !== '');
  if (caInline && entries.some((e) => e.key === 'PG_SSL_CA_CERT_PATH' && e.value !== '')) {
    problems.push('PG_SSL_CA_CERT and PG_SSL_CA_CERT_PATH: set exactly one (the PEM text, or the path of a file holding it); both refuse to start');
  }
  if (caInline && !(template && isPlaceholder(caInline.value))) {
    const problem = pgCaPemProblem(caInline.value, 'PG_SSL_CA_CERT');
    if (problem) problems.push(`${problem} (in an env file: the PEM text on one line with \\n escapes; value not shown)`);
  }
  if (kind === 'runtime' && !entries.some((e) => e.key === AUDIT_SINK_KEY)) {
    problems.push(`${AUDIT_SINK_KEY}: missing (BC-07: production refuses to start without an external audit sink; set stdout with an off-host append-only log shipper)`);
  }
  // The three modes and every URL rule, compose.env (owner decisions 2026-11-17 and 2026-11-18; dbSettingsProblems, the SAME
  // rule as the --environment preflight). PG_ADMIN_URL is your database's ADMIN URL (T-1 accepts a provider admin login;
  // db-setup only); PG_DATABASE_URL is ALWAYS crewflow_owner (db-setup, rab-api and rab-worker).
  if (kind === 'compose') {
    const value = (key) => entries.find((e) => e.key === key)?.value;
    const bundled = value(BUNDLED_DB_KEY) ?? '1';
    problems.push(...dbSettingsProblems({
      adminUrl: value(ADMIN_URL_KEY),
      adminDirectUrl: value(ADMIN_DIRECT_URL_KEY),
      appUrl: value(URL_KEY),
      dbHost: value(DB_HOST_KEY),
      dbPort: value(DB_PORT_KEY),
      dbName: value(DB_NAME_KEY),
      bundled: BUNDLED_DB_VALUES.includes(bundled) ? bundled : '1',
      passwordSet: (value(DB_PASSWORD_KEY) ?? '') !== '',
      appPasswordSet: (value(APP_PASSWORD_KEY) ?? '') !== '',
      template,
    }));
  }
  return problems;
}

/**
 * Owner decision 2026-11-18 (Twenty's way), raw text of a deploy compose file (the image file, its overlays, and
 * docker-compose.production.yml): the database expression and the retired setup volume. Pure; never prints a value.
 */
function databaseExpressionProblems(rel, text) {
  // Owner decision 2026-11-18 (Twenty's way): ${PG_DATABASE_URL...} and ${PG_DATABASE_APP_PASSWORD...} are interpolated ONLY
  // as the one committed crewflow_owner expression (APP_URL_EXPR), on a `PG_DATABASE_URL:` line, so db-setup, rab-api and
  // rab-worker always receive the same URL (the rendered models then prove which services carry it, and that it is equal).
  const problems = [];
  const lines = text.split('\n').filter((l) => !/^\s*#/.test(l));
  const urlLine = new RegExp(`^\\s*-?\\s*PG_DATABASE_URL\\s*:\\s*${APP_URL_EXPR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  for (const l of lines) {
    // `$$` is Compose's escape for a literal `$` (db-setup's wait-for-db wrapper reads PG_DATABASE_URL in its own shell):
    // only an unescaped `${...}` is an interpolation.
    const u = l.split('$$').join('');
    if ((u.includes('${PG_DATABASE_URL') || u.includes('${PG_DATABASE_APP_PASSWORD')) && !urlLine.test(l)) {
      problems.push(`${rel}: interpolates \${PG_DATABASE_URL...} or \${PG_DATABASE_APP_PASSWORD...} other than as the committed line PG_DATABASE_URL: ${APP_URL_EXPR}`);
    }
  }
  // The retired setup volume (owner decision 2026-11-18): never declared or mounted again.
  if (lines.some((l) => l.includes(DB_TARGET_VOLUME) || l.includes(DB_TARGET_DIR))) problems.push(`${rel}: names the retired ${DB_TARGET_VOLUME} volume or ${DB_TARGET_DIR} (no file carries a database credential any more)`);
  return problems;
}

/** Problems in raw compose text that rendering cannot show. */
function lintComposeText(rel, text) {
  const problems = [];
  if (/^\s*build\s*:/m.test(text)) problems.push(`${rel}: has a build: key`);
  if (/^\s*-?\s*CREWFLOW_MIGRATION_APPROVED\s*[:=]/m.test(text)) problems.push(`${rel}: sets CREWFLOW_MIGRATION_APPROVED`);
  if (/^\s*-?\s*CREWFLOW_DB_MODE\s*[:=]/m.test(text)) problems.push(`${rel}: sets CREWFLOW_DB_MODE (there is no mode switch)`);
  problems.push(...databaseExpressionProblems(rel, text));
  // Owner decision 2026-11-17: no compose `:?` on PG_DATABASE_PASSWORD (it would demand it with your own database too);
  // db, db-setup and the lints require it exactly while the bundled db runs. The same for PG_DATABASE_APP_PASSWORD.
  if (/\$\{PG_DATABASE_PASSWORD:\?/.test(text)) problems.push(`${rel}: \${PG_DATABASE_PASSWORD:?...} demands the bundled db's password with your own database too (use \${PG_DATABASE_PASSWORD:-}; the db entrypoint and db-setup refuse an empty one)`);
  if (/\$\{PG_DATABASE_APP_PASSWORD:\?/.test(text)) problems.push(`${rel}: \${PG_DATABASE_APP_PASSWORD:?...} demands the bundled crewflow_owner password with your own database too (use \${PG_DATABASE_APP_PASSWORD:-} inside the committed expression; db-setup and the entrypoints refuse an empty one)`);
  problems.push(...adminUrlPlacementProblems(rel, text));
  for (const m of text.matchAll(/^\s*-?\s*CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS\s*[:=]\s*(.*?)\s*$/gm)) {
    if (m[1] !== HARDEN_TIMEOUT_EXPR) problems.push(`${rel}: ${HARDEN_TIMEOUT_KEY} must be exactly ${HARDEN_TIMEOUT_EXPR} (an optional compose.env value, 60-7200)`);
  }
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
// The same for PG_ADMIN_URL: a database.env (or runtime.env) that held it must never reach rab-api / rab-worker (they have no
// such key, so an env-file value WOULD reach them: appCredentialProblems fails on any PG_ADMIN_URL key there), nor override
// db-setup's committed ${PG_ADMIN_URL:-}.
const DATABASE_ENV_TEXT = [
  `${URL_KEY}=postgresql://crewflow_owner:${SENTINEL_LEGACY_PW}@db-direct.example:5432/crewflow?sslmode=verify-full`, 'PG_EXPECTED_DATABASE_NAME=crewflow', '',
].join('\n');
const RUNTIME_ENV_TEXT = [`APP_SECRET=${SENTINEL_APP_SECRET}`, `REDIS_URL=redis://crewflow:${SENTINEL_REDIS_PW}@rab-redis:6379`, 'APP_URL=https://crewflow.example', 'CREWFLOW_AUDIT_SINK=stdout', ''].join('\n');
/** Separated-mode env files a compose file must no longer read: their marker value must never reach a service. */
const LEGACY_ENV_TEXT = `PG_DATABASE_URL=postgresql://crewflow_migrator:${SENTINEL_LEGACY_PW}@db-direct.example:5432/rab?sslmode=verify-full\nLEGACY_MARKER=${SENTINEL_LEGACY_PW}\n`;

/** Renders the given combos; returns { [comboName]: model }. Throws when docker compose fails. */
function renderModels(combos = COMBOS, extraComposeEnv = [], extraRuntimeEnv = [], extraDatabaseEnv = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-owner-login-'));
  try {
    const secrets = path.join(tmp, 'secrets');
    const project = path.join(tmp, 'project');
    fs.mkdirSync(secrets);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(secrets, 'database.env'), DATABASE_ENV_TEXT + extraDatabaseEnv.map((l) => `${l}\n`).join(''), { mode: 0o600 });
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
      // DB-SETUP: the bundled db's two passwords; the db image and CREWFLOW_PG_CA_FILE keep their committed defaults.
      `${DB_PASSWORD_KEY}=${SENTINEL_DB_PW}`,
      `${APP_PASSWORD_KEY}=${SENTINEL_APP_PW}`,
      ...extraComposeEnv,
      '',
    ].join('\n'), { mode: 0o600 });
    // The external combination (mode b): the operator's own database ADMIN URL in compose.env's PG_ADMIN_URL plus the
    // crewflow_owner URL in PG_DATABASE_URL; pass-through (mode c): only the crewflow_owner URL.
    const envFor = { admin: path.join(tmp, 'compose.external.env'), owner: path.join(tmp, 'compose.pass-through.env') };
    fs.writeFileSync(envFor.admin, `${fs.readFileSync(composeEnv, 'utf8')}${ADMIN_URL_KEY}=${SENTINEL_ADMIN_URL}\n${URL_KEY}=${SENTINEL_URL}\n`, { mode: 0o600 });
    fs.writeFileSync(envFor.owner, `${fs.readFileSync(composeEnv, 'utf8')}${URL_KEY}=${SENTINEL_URL}\n`, { mode: 0o600 });
    // The same two with the bundled db switched off (CREWFLOW_BUNDLED_DB=0, like Twenty's Helm db.enabled=false), and
    // WITHOUT PG_DATABASE_PASSWORD / PG_DATABASE_APP_PASSWORD (owner modes b and c: no dummy password): compose must
    // render without them.
    for (const k of ['admin', 'owner']) {
      envFor[`${k}-no-db`] = path.join(tmp, `compose.${k}-no-db.env`);
      const withoutPassword = fs.readFileSync(envFor[k], 'utf8').split('\n').filter((l) => !l.startsWith(`${DB_PASSWORD_KEY}=`) && !l.startsWith(`${APP_PASSWORD_KEY}=`)).join('\n');
      fs.writeFileSync(envFor[`${k}-no-db`], `${withoutPassword}${BUNDLED_DB_KEY}=0\n`, { mode: 0o600 });
    }
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CREWFLOW_|COMPOSE_|PG_DATABASE_|PG_ADMIN_)/i.test(k)));
    const models = {};
    for (const combo of combos) {
      // --project-directory: relative env_file / bind paths resolve in the throw-away directory, never this checkout.
      const envKey = combo.external ? `${combo.external}${combo.bundledDb === 0 ? '-no-db' : ''}` : null;
      const args = ['compose', '--env-file', envKey ? envFor[envKey] : composeEnv, '--project-directory', project];
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
  // The database expression and the retired setup volume on docker-compose.production.yml too (its other rules are
  // compose-one-image.cjs's and compose-credential-isolation.cjs's).
  if (fs.existsSync(PRODUCTION_FILE)) problems.push(...databaseExpressionProblems('docker-compose.production.yml', fs.readFileSync(PRODUCTION_FILE, 'utf8')));
  // ADMIN_URL_PLACEMENT, every compose file of the repository (dev, QA, test overlays included), not only the deploy files.
  for (const file of composeFilesInRepo()) {
    problems.push(...adminUrlPlacementProblems(path.relative(path.resolve(DOCKER_DIR, '../..'), file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')));
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
  ACCEPTED_SSLMODES, sslmodeProblem, ADMIN_URL_KEY, ADMIN_DIRECT_URL_KEY, DB_HOST_KEY, DB_PORT_KEY, DB_NAME_KEY, RETIRED_ADMIN_URL_KEYS, BUNDLED_ADMIN_URL_KEY, BUNDLED_URL_NO_PASSWORD, DB_SETUP_DB_KEYS, dbSettingsProblems,
  APP_PASSWORD_KEY, APP_URL_EXPR, APP_PASSWORD_SHAPE, SENTINEL_APP_PW, BUNDLED_APP_URL, OWNER_PASSWORD_SENTINELS,
  adminUrlPlacementProblems, composeFilesInRepo, ADMIN_URL_SCAN_ROOTS,
  DB_HARDEN_SERVICE, ADMIN_SERVICES, HARDEN_TIMEOUT_KEY, HARDEN_TIMEOUT_EXPR, HARDEN_ENTRYPOINT, dbHardenProblems, hardenTimeoutOk,
  FILES, TEMPLATES, COMBOS, STATIC_COMBO, DB_SERVICE, DB_SETUP_SERVICE, DB_TARGET_VOLUME, DB_TARGET_DIR, SENTINEL_ADMIN_PW, SENTINEL_ADMIN_URL, dbSetupProblems, appCredentialProblems, credentialMountProblems, topLevelVolumeProblems, bundledDbEnvironmentProblems, DB_INITDB_ARGS, DB_ENV_KEYS, DB_PASSWORD_KEY, BUNDLED_DB_KEY, bundledDbProblems, SENTINEL_DB_PW, BUNDLED_URL, NOT_THE_APP_LOGIN, NOTIFICATION_DELIVERY, PHASE_D_SWITCHES, PHASE_D_UNCHANGED, STATEMENT_DISPATCH, FEATURE_SWEEPS, SWITCH_VALUES, STRICT_SWITCHES, X31_SWITCHES, scanStrictSwitches, ENVIRONMENT_VARIABLES_TS, strictSwitchProblems, featureSweepProblems, composeEnvValue, AUDIT_SINK_MODES, AUDIT_SINK_PRODUCTION_MODES, AUDIT_SINK_FAILURES,
  AUDIT_SINK_PRODUCTION_FAILURES, SENTINEL_URL, SENTINEL_OWNER_PW, SENTINEL_APP_SECRET,
  SENTINEL_REDIS_PW, SENTINEL_LEGACY_PW, forbiddenReason, durationSeconds, checkModel, checkStaticModel, parseEnvText,
  lintEnvText, lintComposeText, databaseExpressionProblems, PRODUCTION_FILE, renderModels, staticProblems, main,
};
