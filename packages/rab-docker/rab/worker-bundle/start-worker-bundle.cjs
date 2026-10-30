'use strict';
/**
 * Crewflow Worker bundle supervisor — ONE deployment service, TWO existing entrypoints, two OS identities.
 *
 *   jobs         packages/rab-worker/dist/main.js                    uid/gid 1000  (restricted crewflow_app only)
 *   provisioner  packages/rab-worker/dist/workspace-provisioner.main.js  uid/gid 10001 (privileged crewflow, direct)
 *
 * Phase A (pa-provisioner): CREWFLOW_PROVISIONER_ENABLED switches the provisioner child. Strict values:
 *   "true"        explicit opt-in: jobs + provisioner (CREWFLOW_PROVISIONER_DATABASE_URL required), default interval 60 s.
 *   "false"       explicit opt-out: the jobs child alone, and the launcher REFUSES to start if
 *                 CREWFLOW_PROVISIONER_DATABASE_URL is present (the privileged URL must not sit in a container that does
 *                 not use it).
 *   unset / empty LEGACY (integration hardening): every environment configured before Phase A keeps exactly its old
 *                 behaviour — jobs + provisioner, the URL required ("Missing CREWFLOW_PROVISIONER_DATABASE_URL"
 *                 otherwise, as before), default interval 5 s — so an existing deployment can neither lose provisioning
 *                 nor stop starting because it lacks the new switch.
 *   anything else refuses to start.
 * HWS_RUNTIME_ENABLED is passed through to both children unchanged (it is no longer forced to "true" for the provisioner
 * child); the provisioner child is always told CREWFLOW_PROVISIONER_ENABLED=true, which is what makes it provision — see
 * workspace-provisioner.config.ts for the enabled-but-HWS-off rule. WORKSPACE_PROVISIONER_INTERVAL_SECONDS (integer
 * 5..120) is validated here and forwarded to the provisioner child only.
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
 * (instrument.ts, the connection factory src/database/postgres, runtime-database-guard.ts, render-pdf.util.ts, main.ts).
 *
 * Phase B: the database settings are the PG_* family (the connection factory, pg-config.ts) plus the deployment identity
 * (CREWFLOW_DEPLOYMENT_ENVIRONMENT / CREWFLOW_DEPLOYMENT_ID / PG_EXPECTED_DATABASE_NAME, checked against the database's
 * marker by every process). The legacy DATABASE_URL / DATABASE_DIRECT_URL / DB_POOL_MAX are still forwarded for
 * non-production stacks; a production Worker service refuses them (makePlan) and so does the jobs child itself.
 *
 * Deliberately absent: DATABASE_URL_UNPOOLED (the jobs guard refuses it), CREWFLOW_* (provisioning/migration/bootstrap;
 * CREWFLOW_DEPLOYMENT_ENVIRONMENT/ID are identity declarations, not authority),
 * DB_TARGET / ALLOW_PRODUCTION_DB_COMMANDS (command authority), BOOTSTRAP_ADMIN_* / SEED_*, TEST_* / RAB_TEST_*,
 * AUTH_*_ISSUER_URL (test-only, refused in production), PORT (no listener), NODE_OPTIONS (would allow --inspect/--require),
 * DOTENV_CONFIG_* (would redirect dotenv). Unknown variables are never forwarded. When the validator gains a variable
 * the Worker needs, add it here in the same change.
 */
const JOBS_ENV_KEYS = Object.freeze([
  // Runtime identity / process
  'NODE_ENV', 'RAB_RUNTIME_ENV', 'TZ', 'APP_VERSION', 'SENTRY_DSN', 'WORKER_SHUTDOWN_TIMEOUT_MS',
  // Restricted database (Phase B: one PG_DATABASE_URL, the restricted crewflow_app login; pool and timeout settings; TLS)
  // + deployment identity + queue. The read-replica keys (PG_DATABASE_REPLICA_*) are API-only and never forwarded.
  'PG_DATABASE_URL', 'PG_POOL_MAX_CONNECTIONS', 'PG_POOL_IDLE_TIMEOUT_MS', 'PG_POOL_ALLOW_EXIT_ON_IDLE',
  'PG_DATABASE_PRIMARY_TIMEOUT_MS', 'PG_SSL_ALLOW_SELF_SIGNED',
  'PG_SSL_CA_CERT_PATH', 'PG_DATABASE_URL_IS_DIRECT',
  // Phase B (B5): the declared deployment shape the startup connection-budget check reads (src/database/runtime/
  // connection-budget.ts); identical on every service of one deployment.
  'PG_EXPECTED_API_INSTANCES', 'PG_EXPECTED_WORKER_INSTANCES', 'PG_EXPECTED_API_POOL_MAX', 'PG_EXPECTED_WORKER_POOL_MAX',
  'PG_EXPECTED_MIGRATE_CONNECTIONS', 'PG_PROVIDER_RESERVED_CONNECTIONS',
  'CREWFLOW_DEPLOYMENT_ENVIRONMENT', 'CREWFLOW_DEPLOYMENT_ID', 'PG_EXPECTED_DATABASE_NAME',
  // Deprecated (non-production only; a production Worker service refuses them)
  'DATABASE_URL', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX',
  'REDIS_URL',
  // Encryption / signing (push credentials, QR tokens, report links)
  'APP_SECRET', 'APP_ENCRYPTION_KEYRING', 'APP_ENCRYPTION_ACTIVE_KID', 'APP_JWT_SIGNING_KEYRING', 'APP_JWT_ACTIVE_KID',
  // Wave 1 lane A: legacy APP_SECRET JWT-key cut-off (validated together with the keyring above)
  'APP_JWT_LEGACY_VERIFY_ENABLED',
  // Wave 2 lane A2: key separation (validated together with the keyrings above: reuse refusal, strict mode) and the
  // browser-cookie flags (declared by the shared validator; the Worker sets no cookies)
  'APP_AUTH_CACHE_HMAC_KEY', 'APP_KEY_SEPARATION_REQUIRED', 'AUTH_COOKIE_HOST_PREFIX_ENABLED', 'AUTH_COOKIE_LEGACY_MIGRATION_ENABLED',
  // URLs and production-config validation (the Worker validates the same production rules as the API)
  'APP_URL', 'ACCOUNTS_URL', 'CORS_ORIGINS', 'TRUSTED_PROXY_CIDRS', 'WORKSPACE_BASE_DOMAIN',
  // Wave 1 lane A: workspace-subdomain origin trust (validated together with WORKSPACE_BASE_DOMAIN)
  'WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED',
  // Wave 3 lane H: origin trust now requires host routing at boot (env.validation) — the pair must travel together
  'WORKSPACE_HOST_ROUTING_ENABLED',
  // Feature switches / cutovers read by shared services
  'HWS_RUNTIME_ENABLED', 'AUTH_CONTEXT_CACHE_ENABLED', 'USER_SESSION_CACHE_ENABLED', 'CORE_ENTITY_CACHE_ENABLED',
  'WORKSPACE_METADATA_CACHE_ENABLED', 'USER_SESSION_ENFORCEMENT_CUTOVER',
  // Wave 5 lane OPS: in-process L1 for non-authorisation metadata (validated by the shared EnvironmentVariables class)
  'METADATA_L1_CACHE_ENABLED', 'METADATA_L1_CACHE_TTL_MS', 'METADATA_L1_CACHE_MAX_ENTRIES', 'METADATA_L1_CACHE_MAX_BYTES',
  // Wave 5 lane OPS (G6): terminal outbox retention job (rab-worker outbox-retention.job.ts) — off / report by default
  'OUTBOX_RETENTION_ENABLED', 'OUTBOX_RETENTION_MODE', 'OUTBOX_RETENTION_EMAIL_DAYS', 'OUTBOX_RETENTION_PUSH_DAYS',
  'OUTBOX_RETENTION_REALTIME_DAYS', 'OUTBOX_RETENTION_WORKER_EVENT_DAYS', 'OUTBOX_RETENTION_BATCH_SIZE',
  'OUTBOX_RETENTION_MAX_BATCHES_PER_SCOPE', 'OUTBOX_RETENTION_INTERVAL_MINUTES',
  // Wave 4/5 (MFA-lane request): login-handoff cleanup job (on by default)
  'LOGIN_HANDOFF_CLEANUP_ENABLED', 'LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES',
  // Lane A (BullMQ worker migration): scheduler mode, scan-queue prefix and reconcile period (validated by the shared
  // EnvironmentVariables class: an invalid mode/prefix refuses to boot; interval is the default).
  'WORKER_SCHEDULER', 'BULLMQ_PREFIX', 'WORKER_SCHEDULER_RECONCILE_SECONDS',
  // Phase A pa-intervals: per-scan polling intervals in seconds (environment/worker-scan-intervals.ts; defaults = the
  // historical cadences, bounded, out-of-range refuses to boot).
  'WORKER_ACCOUNT_INVITE_CLEANUP_INTERVAL_SECONDS', 'WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS', 'WORKER_PUSH_DISPATCH_INTERVAL_SECONDS',
  'WORKER_SHIFT_MONITOR_INTERVAL_SECONDS', 'WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS', 'WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS',
  'WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS', 'WORKER_OFFER_EXPIRY_INTERVAL_SECONDS',
  'WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS', 'WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS', 'WORKER_TOKEN_CLEANUP_INTERVAL_SECONDS',
  'WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS', 'WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS', 'WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS',
  'WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS', 'WORKER_PAYROLL_PERIOD_ATTENTION_INTERVAL_SECONDS',
  'WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS',
  // AI Phase 1 (docs/ai/PHASE1_PLAN.md, PHASE1_TWENTY_PLAN.md): the rab-ai consumer + ai-retention scan. Provider keys are
  // jobs-only, never the provisioner. The retired AI_PROVIDER / AI_MODEL / AI_PROVIDER_API_KEY are NOT forwarded.
  'AI_ENABLED', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY', 'AI_DEV_ALLOW_REAL_PROVIDERS', 'AI_DAILY_BUDGET_USD', 'AI_MODELS_DEFAULT_FAST', 'AI_MODELS_DEFAULT_SMART', 'AI_MODELS_DEFAULT_DISABLED', 'AI_MAX_OUTPUT_TOKENS', 'AI_MAX_STEPS', 'AI_MAX_INPUT_CHARS', 'AI_ORG_DAILY_TOKEN_BUDGET', 'AI_USER_RATE_PER_MIN', 'AI_ORG_MAX_ACTIVE_TURNS', 'AI_TURN_TIMEOUT_SECONDS', 'AI_RETENTION_DAYS', 'AI_RETENTION_MODE', 'AI_RETENTION_INTERVAL_MINUTES',
  // AI Phase 2 (PHASE2_TWENTY_PLAN §2.5): the thread-title switch, read by the rab-ai consumer's title service.
  'AI_TITLE_GENERATION',
  // AI Phase 6a (PHASE6_TWENTY_PLAN §4): the agents platform switch (default false; storage only until EX-3). Forwarded so
  // the jobs child never silently takes a different value from the API when 6b adds the agent scan.
  'AI_AGENTS_ENABLED',
  // AI Phase 7b (PHASE7_TWENTY_PLAN, owner decision 2026-10-25): the per-user cost ceiling and the rate limits. The Worker
  // reads AI_USER_DAILY_BUDGET_USD for every step reservation; the rate names keep the jobs child on the API's values.
  'AI_USER_DAILY_BUDGET_USD', 'AI_ORG_RATE_PER_MIN', 'AI_USER_TURNS_PER_DAY',
  // Sign-in provider configuration: the validator refuses to boot when no provider is enabled, and requires an enabled
  // provider's client id/secret/callback — so a deployment that disables password sign-in needs these here too.
  'AUTH_PASSWORD_ENABLED', 'AUTH_GOOGLE_ENABLED', 'AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET', 'AUTH_GOOGLE_CALLBACK_URL',
  'AUTH_MICROSOFT_ENABLED', 'AUTH_MICROSOFT_CLIENT_ID', 'AUTH_MICROSOFT_CLIENT_SECRET', 'AUTH_MICROSOFT_CALLBACK_URL',
  'AUTH_MICROSOFT_TENANT', 'AUTH_OAUTH_HANDOFF_ENABLED',
  // Wave 1 lane A: password sign-in attempt limits (validated by the same EnvironmentVariables class)
  'AUTH_LOGIN_EMAIL_IP_BURST', 'AUTH_LOGIN_EMAIL_IP_WINDOW_SECONDS', 'AUTH_LOGIN_EMAIL_IP_DAILY_LIMIT', 'AUTH_LOGIN_ACCOUNT_BURST',
  'AUTH_LOGIN_ACCOUNT_WINDOW_SECONDS', 'AUTH_LOGIN_KNOWN_IP_TTL_DAYS',
  // Wave 4 lane MFA: second-factor policy, step-up and login handoff (declared by the shared validator; the Worker signs
  // nobody in, but AUTH_LOGIN_HANDOFF_ENABLED is cross-validated with WORKSPACE_HOST_ROUTING_ENABLED at boot)
  'AUTH_MFA_ENROLMENT_ENABLED', 'AUTH_MFA_ENFORCE_PLATFORM_ADMIN', 'AUTH_MFA_ENFORCE_ORGANISATION_OWNER', 'AUTH_MFA_ENFORCE_INITIAL_MANAGER',
  'AUTH_MFA_ENFORCE_OTHER_WEB_USERS', 'AUTH_MFA_MOBILE_POLICY', 'AUTH_MFA_CHALLENGE_TTL_SECONDS', 'AUTH_MFA_CHALLENGE_MAX_ATTEMPTS',
  'AUTH_MFA_USER_ATTEMPTS_BURST', 'AUTH_MFA_USER_ATTEMPTS_WINDOW_SECONDS', 'AUTH_MFA_ISSUER', 'AUTH_STEP_UP_WINDOW_SECONDS',
  'AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS', 'AUTH_LOGIN_HANDOFF_ENABLED', 'AUTH_LOGIN_HANDOFF_TTL_SECONDS',
  // Email
  'EMAIL_DRIVER', 'EMAIL_DELIVERY_ENABLED', 'EMAIL_SMTP_HOST', 'EMAIL_SMTP_PORT', 'EMAIL_SMTP_USER', 'EMAIL_SMTP_PASSWORD',
  'EMAIL_SMTP_NO_TLS', 'RESEND_API_KEY', 'EMAIL_FROM_ADDRESS', 'EMAIL_REPLY_TO',
  // Storage
  'STORAGE_DRIVER', 'STORAGE_LOCAL_ROOT', 'STORAGE_KEY_PREFIX', 'S3_BUCKET', 'S3_REGION', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE', 'S3_SIGNED_URL_TTL_SECONDS', 'S3_MAX_UPLOAD_BYTES', 'S3_SERVER_SIDE_ENCRYPTION',
  'S3_KMS_KEY_ID', 'STORAGE_CLEANUP_PURGE_DELETED_IMAGES_AFTER_DAYS',
  // Phase A pa-storage: reconciliation method (list, or head = rollback) and the storage-cleanup minimum spacing
  'STORAGE_RECONCILE_METHOD', 'STORAGE_CLEANUP_MIN_SPACING_MINUTES',
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
 * (runtime guard), REDIS_URL (its own heartbeat/stats only), SENTRY_DSN (instrument.ts), HWS_RUNTIME_ENABLED (passed
 * through unchanged, Phase A — no longer forced), the TLS settings (PG_SSL_CA_CERT_PATH, PG_SSL_ALLOW_SELF_SIGNED) and the
 * deployment identity its runtime guard checks against the marker (CREWFLOW_DEPLOYMENT_ENVIRONMENT, CREWFLOW_DEPLOYMENT_ID,
 * PG_EXPECTED_DATABASE_NAME), and — set by the launcher, never forwarded — PG_DATABASE_URL (Phase B: the provisioner
 * credential, taken from CREWFLOW_PROVISIONER_DATABASE_URL; the child never receives DATABASE_URL or DATABASE_URL_UNPOOLED),
 * CREWFLOW_PROVISIONER_ENABLED ("true") and WORKSPACE_PROVISIONER_INTERVAL_SECONDS (the validated effective value). The
 * provisioner child is left out of the plan only when CREWFLOW_PROVISIONER_ENABLED=false.
 */
const PROVISIONER_ENV_KEYS = Object.freeze([
  'NODE_ENV', 'RAB_RUNTIME_ENV', 'TZ', 'REDIS_URL', 'SENTRY_DSN', 'HWS_RUNTIME_ENABLED',
  'PG_SSL_CA_CERT_PATH', 'PG_SSL_ALLOW_SELF_SIGNED',
  'CREWFLOW_DEPLOYMENT_ENVIRONMENT', 'CREWFLOW_DEPLOYMENT_ID', 'PG_EXPECTED_DATABASE_NAME',
]);

/**
 * Phase A (pa-provisioner): provisioner polling interval bounds, in seconds. MUST equal the constants in
 * packages/rab-worker/src/workspace-provisioner.config.ts (launcher.test.cjs reconciles the two from a repo checkout).
 * The upper bound keeps a settled cycle inside the bundle health check's 5-minute provisioner window
 * (worker-bundle-health.cjs ROLES.provisioner.settledMaxAgeMs) with room for a slow batch. legacyDefaultSeconds is the
 * pre-Phase-A fixed cadence, kept for a switch-unset (legacy) environment.
 */
const PROVISIONER_INTERVAL = Object.freeze({ defaultSeconds: 60, legacyDefaultSeconds: 5, minSeconds: 5, maxSeconds: 120 });

/**
 * Present on the Worker service at all (non-empty) → refuse: this service never holds migration, bootstrap, command or
 * operations authority. Security review L-4: this is a literal copy of the shared list in
 * packages/rab-server/src/database/typeorm/core/never-in-runtime-env.ts (forbiddenWorkerServiceEnvNames: every name
 * except CREWFLOW_PROVISIONER_DATABASE_URL, which this launcher holds and hands to the provisioner child as its
 * PG_DATABASE_URL). This file ships standalone in the Worker image, so it cannot import that module;
 * never-in-runtime-env.spec.ts fails the server build when the two drift.
 */
const FORBIDDEN_SERVICE_KEYS = Object.freeze([
  'DATABASE_URL_UNPOOLED',
  'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL',
  'CREWFLOW_MIGRATION_APPROVED',
  'CREWFLOW_MIGRATION_DATABASE_URL',
  'CREWFLOW_MIGRATION_PHASE',
  'CREWFLOW_MIGRATOR_PASSWORD',
  'CREWFLOW_BOOTSTRAP_PASSWORD',
  'CREWFLOW_APP_BOOTSTRAP_PASSWORD',
  'ALLOW_PRODUCTION_DB_COMMANDS',
  // Command authority (migrations and CLI commands only); the launcher never forwarded it, now it refuses it outright.
  // Strict by name, whatever its value: the in-process guard alone tolerates DB_TARGET=local|test in a non-production
  // runtime (local `yarn start`); this launcher only runs in the Worker image, where docker-compose.yml blanks it.
  'DB_TARGET',
  // Phase B / B3: the one-time bootstrap of an unbound production database is a migration-command action only.
  'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP',
  // Phase B (ops): the one-off operations container's variables (its crewflow_app URL, its marker, the operator label).
  // They belong to `docker compose --profile ops run --rm rab-ops ...` only (pg-config.ts refuses them in every child too).
  'CREWFLOW_OPS_RUN',
  'PG_OPS_APP_DATABASE_URL',
  'CREWFLOW_OPS_ACTOR_SOURCE',
  'CREWFLOW_OPS_ACTOR_ID',
  'CREWFLOW_OPS_CHANGE_REF',
]);

/** Phase B: deprecated database names a PRODUCTION Worker service must not carry (production takes PG_DATABASE_URL only). */
const LEGACY_DATABASE_KEYS = Object.freeze(['DATABASE_URL', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX']);

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
  return {
    user: decodeURIComponent(url.username),
    host: url.hostname.toLowerCase(),
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.slice(1)),
  };
}

/**
 * Documented transaction-pooler shapes (the same denylist as the connection factory, pg-url-policy.ts
 * detectTransactionPooler): a pooler cannot carry session advisory locks or the provisioner's own BEGIN/COMMIT pairs.
 * Defence in depth only — the children refuse these too, and the jobs child runs a live session probe.
 */
const isPoolerHost = ({ host, port }) =>
  /-pooler\./.test(host) ||
  (host.endsWith('.pooler.supabase.com') && port === 6543) ||
  (host.endsWith('.ondigitalocean.com') && port === 25061) ||
  /\.proxy-[a-z0-9]+\.[a-z0-9-]+\.rds\.amazonaws\.com$/.test(host);

/**
 * Phase A (pa-provisioner): strict switch. Returns 'on' / 'off' / 'legacy' (unset or empty), or throws
 * BundleConfigError (name only) for any other value, so a typo such as "ture" or "1" refuses to start instead of
 * silently choosing a mode.
 */
function provisionerMode(env) {
  const mode = health.provisionerMode(env);
  if (mode === null) {
    throw new BundleConfigError('CREWFLOW_PROVISIONER_ENABLED must be "true" or "false" (unset or empty = the pre-Phase-A behaviour: provisioner on)');
  }
  return mode;
}

/**
 * Phase A: validates WORKSPACE_PROVISIONER_INTERVAL_SECONDS. Unset/empty = 60 s for an explicit opt-in, the old fixed
 * 5 s for a legacy (switch-unset) environment. Errors name the variable only.
 */
function provisionerIntervalSeconds(env, mode) {
  const raw = env.WORKSPACE_PROVISIONER_INTERVAL_SECONDS;
  if (raw === undefined || String(raw).trim() === '') {
    return mode === 'legacy' ? PROVISIONER_INTERVAL.legacyDefaultSeconds : PROVISIONER_INTERVAL.defaultSeconds;
  }
  const text = String(raw).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < PROVISIONER_INTERVAL.minSeconds || n > PROVISIONER_INTERVAL.maxSeconds) {
    throw new BundleConfigError(
      `WORKSPACE_PROVISIONER_INTERVAL_SECONDS must be a whole number of seconds from ${PROVISIONER_INTERVAL.minSeconds} to ${PROVISIONER_INTERVAL.maxSeconds}`,
    );
  }
  return n;
}

const nonEmpty = (env, key) => typeof env[key] === 'string' && env[key].trim() !== '';

/**
 * Pure: validates the service environment and builds the child specs — [jobs] when CREWFLOW_PROVISIONER_ENABLED=false,
 * [jobs, provisioner] when it is "true" or unset (legacy). Throws BundleConfigError (names only).
 */
function makePlan(env, layout = DEFAULT_LAYOUT) {
  for (const key of FORBIDDEN_SERVICE_KEYS) {
    if (nonEmpty(env, key)) {
      throw new BundleConfigError(`${key} must not be configured on the Worker service (no migration or bootstrap authority here)`);
    }
  }
  const mode = provisionerMode(env);
  const withProvisioner = mode !== 'off';
  if (!withProvisioner && nonEmpty(env, 'CREWFLOW_PROVISIONER_DATABASE_URL')) {
    // Fail closed: a privileged credential the service does not use must not sit in its environment (the root launcher
    // would hold it for nothing). Remove it, or opt in explicitly. Only an explicit "false" gets here.
    throw new BundleConfigError(
      'CREWFLOW_PROVISIONER_DATABASE_URL is set but the workspace provisioner is disabled: remove it from the Worker service, or set CREWFLOW_PROVISIONER_ENABLED=true',
    );
  }
  // Phase B: the jobs child's one connection is PG_DATABASE_URL (crewflow_app, direct: it is also the session-lock
  // connection). Outside production the deprecated DATABASE_URL (+ an optional DATABASE_DIRECT_URL for the locks) is still
  // accepted; a production service must not carry the legacy names at all.
  const production = env.NODE_ENV === 'production' || env.RAB_RUNTIME_ENV === 'production';
  if (production) {
    for (const key of LEGACY_DATABASE_KEYS) {
      if (nonEmpty(env, key)) throw new BundleConfigError(`${key} is a deprecated name a production Worker service must not carry; use PG_DATABASE_URL (and PG_POOL_MAX_CONNECTIONS)`);
    }
  }
  const appName = nonEmpty(env, 'PG_DATABASE_URL') || production ? 'PG_DATABASE_URL' : 'DATABASE_URL';
  if (appName === 'DATABASE_URL' && !nonEmpty(env, 'DATABASE_URL')) throw new BundleConfigError('Missing PG_DATABASE_URL');
  const appUrl = required(env, appName);
  const directName = nonEmpty(env, 'DATABASE_DIRECT_URL') ? 'DATABASE_DIRECT_URL' : null;
  const provisionerUrl = withProvisioner ? required(env, 'CREWFLOW_PROVISIONER_DATABASE_URL') : null;
  required(env, 'REDIS_URL');
  const app = pgUrl(appUrl, appName);
  if (appName === 'PG_DATABASE_URL' && nonEmpty(env, 'DATABASE_URL')) {
    const legacy = pgUrl(env.DATABASE_URL.trim(), 'DATABASE_URL');
    if (legacy.user !== app.user || legacy.host !== app.host || legacy.port !== app.port || legacy.database !== app.database) {
      throw new BundleConfigError('PG_DATABASE_URL and the deprecated DATABASE_URL name different targets; remove DATABASE_URL');
    }
  }
  const direct = directName ? pgUrl(env[directName].trim(), directName) : null;
  const provisioner = provisionerUrl ? pgUrl(provisionerUrl, 'CREWFLOW_PROVISIONER_DATABASE_URL') : null;
  if (app.user !== 'crewflow_app' || (direct && direct.user !== 'crewflow_app')) {
    throw new BundleConfigError(`${appName}${direct ? ` and ${directName}` : ''} must log in as crewflow_app (the live role guards still run too)`);
  }
  if (provisioner && provisioner.user !== 'crewflow') throw new BundleConfigError('CREWFLOW_PROVISIONER_DATABASE_URL must log in as crewflow');
  if ((direct && app.database !== direct.database) || (provisioner && app.database !== provisioner.database)) {
    throw new BundleConfigError(
      `${[appName, direct && directName, provisioner && 'CREWFLOW_PROVISIONER_DATABASE_URL'].filter(Boolean).join(', ')} name different databases`,
    );
  }
  // The session-lock connection: the deprecated DATABASE_DIRECT_URL when set, otherwise PG_DATABASE_URL itself.
  const lockName = direct ? directName : appName;
  if (isPoolerHost(direct ?? app)) throw new BundleConfigError(`${lockName} is a transaction-pooler host; the Worker needs a direct (session) connection`);
  if (provisioner && isPoolerHost(provisioner)) throw new BundleConfigError('CREWFLOW_PROVISIONER_DATABASE_URL is a pooled (-pooler) host; use the direct host');
  // Validated only where it is used; a disabled provisioner ignores it (it is never forwarded to the jobs child).
  const intervalSeconds = withProvisioner ? provisionerIntervalSeconds(env, mode) : null;
  if (production) {
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
  const jobs = {
    name: 'jobs',
    entry: path.join(layout.root, 'packages/rab-worker/dist/main.js'),
    cwd: layout.root,
    env: jobsEnv,
    uid: layout.jobs.uid,
    gid: layout.jobs.gid,
    healthFile: layout.jobs.healthFile,
    expectGuard: { process: 'worker', role: 'crewflow_app' },
  };
  if (!withProvisioner) return [jobs];

  const provisionerEnv = {
    // HWS_RUNTIME_ENABLED is passed through exactly as the service has it (Phase A — no longer forced to "true").
    ...own(env, PROVISIONER_ENV_KEYS),
    // Phase B: the provisioner credential under the one variable name every process uses. Never DATABASE_URL /
    // DATABASE_URL_UNPOOLED (production refuses the legacy names; the child's runtime guard and factory read this one).
    PG_DATABASE_URL: provisionerUrl,
    // The explicit opt-in is what makes the child provision (workspace-provisioner.config.ts); the validated interval.
    CREWFLOW_PROVISIONER_ENABLED: 'true',
    WORKSPACE_PROVISIONER_INTERVAL_SECONDS: String(intervalSeconds),
    PATH: SAFE_PATH,
    HOME: layout.provisioner.home,
    TMPDIR: layout.provisioner.home,
    CREWFLOW_INSTANCE_HEALTH_FILE: layout.provisioner.healthFile,
  };
  return [
    jobs,
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
  // Both bundle identities, even when the provisioner is disabled (Phase A): image code must never be writable by either.
  const childUids = new Set([...plan.map((s) => s.uid), layout.jobs.uid, layout.provisioner.uid]);
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
  // Only the roles that will actually start (Phase A: a disabled provisioner needs no temp/health directory).
  const roles = new Set(plan.map((s) => s.name));
  for (const [name, spec] of Object.entries({ jobs: layout.jobs, provisioner: layout.provisioner })) {
    if (!roles.has(name)) continue;
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
 * not requested — INCLUDING exit code 0 — fails the whole service: every planned process is mandatory and long-running.
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
  if (plan.some((s) => s.name === 'provisioner')) {
    const interval = plan.find((s) => s.name === 'provisioner').env.WORKSPACE_PROVISIONER_INTERVAL_SECONDS;
    if (health.provisionerMode(env) === 'legacy') {
      console.error(`[worker-bundle] starting jobs + provisioner (CREWFLOW_PROVISIONER_ENABLED unset: pre-Phase-A behaviour, interval ${interval}s; set it to "true" or "false" explicitly; shutdown grace ${graceMs}ms)`);
    } else {
      console.error(`[worker-bundle] starting jobs + provisioner (CREWFLOW_PROVISIONER_ENABLED=true, interval ${interval}s; shutdown grace ${graceMs}ms)`);
    }
  } else {
    // Phase A: no privileged child, no privileged credential in this container. New workspaces are built only where the
    // API's server-path provisioning (core.provision_workspace) exists; elsewhere they stay CREATING.
    console.error(`[worker-bundle] starting jobs only — workspace provisioner disabled (CREWFLOW_PROVISIONER_ENABLED=false); shutdown grace ${graceMs}ms`);
  }
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
  PROVISIONER_INTERVAL,
  DEFAULT_LAYOUT,
  BundleConfigError,
  makePlan,
  preflight,
  main,
  supervise,
  processesOwnedBy,
  GUARD_LINE,
};
