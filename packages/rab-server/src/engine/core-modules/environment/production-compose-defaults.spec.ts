import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { resolvePgEnvironment } from '../../../database/postgres/pg-config';
import { readDeploymentShape } from '../../../database/runtime/connection-budget';
import {
  WORKER_SHUTDOWN_TIMEOUT_MS_DEFAULT,
  parseWorkerShutdownTimeoutMs,
} from '../../worker-shared/worker-shutdown-timeout.contract';
import { validate } from './env.validation';

/**
 * 2026-11-19 (owner request, "list only what each service needs, like Twenty"): docker-compose.production.yml no longer
 * lists optional settings. Every line below was a `${KEY:-<value>}` on rab-api and/or rab-worker there; removing it is a
 * no-op ONLY if the code's own default equals <value>. This spec proves that, key by key, with the code's real readers:
 * for each key, the effective value with the key UNSET equals the effective value with the key set to the old compose
 * value. A removed key whose default ever drifts from what production ran with fails here.
 *
 * The values are the exact text the compose file carried (git show <base>:packages/rab-docker/docker-compose.production.yml).
 */
const REMOVED_SHARED: Readonly<Record<string, string>> = Object.freeze({
  // EnvironmentVariables (env.validation.ts validate(), read by both rab-api and rab-worker)
  APP_JWT_LEGACY_VERIFY_ENABLED: 'true',
  APP_KEY_SEPARATION_REQUIRED: 'false',
  AUTH_COOKIE_HOST_PREFIX_ENABLED: 'false',
  AUTH_COOKIE_LEGACY_MIGRATION_ENABLED: 'true',
  APP_VERSION: 'dev',
  EMAIL_SMTP_PORT: '587',
  EMAIL_SMTP_NO_TLS: 'false',
  EMAIL_FROM_ADDRESS: 'rab <no-reply@example.com>',
  EMAIL_DELIVERY_ENABLED: 'true',
  S3_SIGNED_URL_TTL_SECONDS: '120',
  S3_MAX_UPLOAD_BYTES: '20971520',
  STORAGE_CLEANUP_PURGE_DELETED_IMAGES_AFTER_DAYS: '30',
  STORAGE_RECONCILE_METHOD: 'list',
  STORAGE_CLEANUP_MIN_SPACING_MINUTES: '720',
  AUTH_PASSWORD_ENABLED: 'true',
  AUTH_GOOGLE_ENABLED: 'false',
  AUTH_MICROSOFT_ENABLED: 'false',
  AUTH_OAUTH_HANDOFF_ENABLED: 'false',
  USER_SESSION_ENFORCEMENT_CUTOVER: 'false',
  AUTH_LOGIN_EMAIL_IP_BURST: '5',
  AUTH_LOGIN_EMAIL_IP_WINDOW_SECONDS: '900',
  AUTH_LOGIN_EMAIL_IP_DAILY_LIMIT: '30',
  AUTH_LOGIN_ACCOUNT_BURST: '50',
  AUTH_LOGIN_ACCOUNT_WINDOW_SECONDS: '900',
  AUTH_LOGIN_KNOWN_IP_TTL_DAYS: '30',
  AUTH_MFA_ENROLMENT_ENABLED: 'true',
  AUTH_MFA_ENFORCE_PLATFORM_ADMIN: 'false',
  AUTH_MFA_ENFORCE_ORGANISATION_OWNER: 'false',
  AUTH_MFA_ENFORCE_INITIAL_MANAGER: 'false',
  AUTH_MFA_ENFORCE_OTHER_WEB_USERS: 'false',
  AUTH_MFA_MOBILE_POLICY: 'exempt',
  AUTH_MFA_CHALLENGE_TTL_SECONDS: '300',
  AUTH_MFA_CHALLENGE_MAX_ATTEMPTS: '5',
  AUTH_MFA_USER_ATTEMPTS_BURST: '10',
  AUTH_MFA_USER_ATTEMPTS_WINDOW_SECONDS: '900',
  AUTH_MFA_ISSUER: 'Crewflow',
  AUTH_STEP_UP_WINDOW_SECONDS: '300',
  AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS: 'false',
  WORKSPACE_HOST_ROUTING_ENABLED: 'false',
  AUTH_CONTEXT_CACHE_ENABLED: 'false',
  USER_SESSION_CACHE_ENABLED: 'false',
  CORE_ENTITY_CACHE_ENABLED: 'false',
  WORKSPACE_METADATA_CACHE_ENABLED: 'false',
  METADATA_L1_CACHE_ENABLED: 'false',
  METADATA_L1_CACHE_TTL_MS: '2000',
  METADATA_L1_CACHE_MAX_ENTRIES: '5000',
  METADATA_L1_CACHE_MAX_BYTES: '8388608',
  REALTIME_ENABLED: 'false',
  REALTIME_HEARTBEAT_INTERVAL_MS: '30000',
  REALTIME_MAX_CONNECTIONS_PER_USER: '3',
  WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS: '2',
  PUSH_ENABLED: 'false',
  PUSH_PROVIDER: 'FAKE',
  APNS_ENVIRONMENT: 'sandbox',
  PUSH_DELIVERY_MAX_ATTEMPTS: '5',
  WORKER_ACCOUNT_INVITE_CLEANUP_INTERVAL_SECONDS: '900',
  WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS: '300',
  WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS: '60',
  WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS: '120',
  WORKER_TOKEN_CLEANUP_INTERVAL_SECONDS: '86400',
  WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS: '86400',
  WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS: '300',
  WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS: '300',
  WORKER_PAYROLL_PERIOD_ATTENTION_INTERVAL_SECONDS: '1800',
  WORKER_SCHEDULER_RECONCILE_SECONDS: '60',
  OUTBOX_RETENTION_ENABLED: 'false',
  OUTBOX_RETENTION_MODE: 'report',
  OUTBOX_RETENTION_EMAIL_DAYS: '90',
  OUTBOX_RETENTION_PUSH_DAYS: '30',
  OUTBOX_RETENTION_REALTIME_DAYS: '7',
  OUTBOX_RETENTION_WORKER_EVENT_DAYS: '30',
  OUTBOX_RETENTION_BATCH_SIZE: '1000',
  OUTBOX_RETENTION_MAX_BATCHES_PER_SCOPE: '20',
  OUTBOX_RETENTION_INTERVAL_MINUTES: '60',
  LOGIN_HANDOFF_CLEANUP_ENABLED: 'true',
  LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES: '15',
  CLOCK_IN_EARLY_MINUTES: '15',
  QR_POST_SHIFT_GRACE_MINUTES: '120',
  QR_MAX_AGE_DAYS: '14',
  REPORT_AVAILABLE_BEFORE_MINUTES: '180',
  GEOFENCE_MAX_ACCURACY_M: '100',
  LOCATION_EVIDENCE_MAX_AGE_SECONDS: '120',
  LOCATION_EVIDENCE_MAX_FUTURE_SKEW_SECONDS: '30',
  LATE_CLOCK_IN_GRACE_MINUTES: '10',
  MEMBER_INVITE_RATE_RECIPIENT_PER_DAY: '6',
  MEMBER_INVITE_RATE_ACTOR_PER_HOUR: '60',
  MEMBER_INVITE_RATE_ORGANISATION_PER_DAY: '500',
  MEMBER_INVITE_RATE_REDEEM_PER_IP_PER_HOUR: '30',
  AI_AGENTS_ENABLED: 'false',
  AI_DAILY_BUDGET_USD: '2',
  AI_USER_DAILY_BUDGET_USD: '1',
  AI_ORG_DAILY_TOKEN_BUDGET: '200000',
  AI_MAX_OUTPUT_TOKENS: '1500',
  AI_MAX_STEPS: '8',
  AI_MAX_INPUT_CHARS: '4000',
  AI_USER_RATE_PER_MIN: '10',
  AI_ORG_RATE_PER_MIN: '60',
  AI_USER_TURNS_PER_DAY: '100',
  AI_ORG_MAX_ACTIVE_TURNS: '2',
  AI_TURN_TIMEOUT_SECONDS: '90',
  AI_TITLE_GENERATION: 'true',
  AI_RETENTION_DAYS: '90',
  AI_RETENTION_MODE: 'off',
  AI_RETENTION_INTERVAL_MINUTES: '60',
  AI_STALE_TURN_SWEEP: 'false',
  AI_STALE_TURN_THRESHOLD_MINUTES: '15',
  AI_STALE_TURN_SWEEP_INTERVAL_MINUTES: '5',
});

/** Read by src/database/postgres/pg-config.ts resolvePgEnvironment (both processes), not by EnvironmentVariables. */
const REMOVED_PG_POOL: Readonly<Record<string, string>> = Object.freeze({
  PG_POOL_IDLE_TIMEOUT_MS: '600000',
  PG_POOL_ALLOW_EXIT_ON_IDLE: 'false',
  PG_DATABASE_PRIMARY_TIMEOUT_MS: '30000',
});

/** Read by src/database/runtime/connection-budget.ts readDeploymentShape (both processes). */
const REMOVED_CONNECTION_BUDGET: Readonly<Record<string, string>> = Object.freeze({
  PG_EXPECTED_MIGRATE_CONNECTIONS: '5',
  PG_PROVIDER_RESERVED_CONNECTIONS: '0',
});

/**
 * Read outside TypeScript this package can import: the start scripts (shell) and rab-worker's own runtime files. Each
 * entry names the file and the exact default expression that must be in it. `CREWFLOW_RUNTIME_ISOLATION` is read by both
 * (api-prestart.sh and rab-worker's runtime-isolation.ts; the compose default was `warn` on both).
 */
const REMOVED_READ_ELSEWHERE: ReadonlyArray<{ key: string; value: string; file: string; expect: RegExp }> = Object.freeze([
  { key: 'CREWFLOW_RUNTIME_ISOLATION', value: 'warn', file: 'rab-docker/rab/api-prestart.sh', expect: /"\$\{CREWFLOW_RUNTIME_ISOLATION:-warn\}"/ },
  {
    key: 'CREWFLOW_RUNTIME_ISOLATION',
    value: 'warn',
    file: 'rab-worker/src/core/runtime/runtime-isolation.ts',
    expect: /const raw = env\[RUNTIME_ISOLATION_ENV\] \?\? '';\s*const mode = raw === '' \|\| raw === 'warn' \? 'warn'/,
  },
  // rab-api only.
  { key: 'CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS', value: '15', file: 'rab-docker/rab/api-prestart.sh', expect: /FAILURE_DELAY="\$\{CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS:-15\}"/ },
  // rab-worker only.
  { key: 'CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS', value: '120', file: 'rab-worker/src/core/runtime/event-loop-watchdog.ts', expect: /WATCHDOG_STALE_SECONDS_DEFAULT = 120;/ },
]);

/** The REQUIRED list and the pinned values of docker-compose.production.yml, with dummies: a production environment. */
const PRODUCTION_BASE: Readonly<Record<string, string>> = Object.freeze({
  NODE_ENV: 'production',
  RAB_RUNTIME_ENV: 'production',
  PG_DATABASE_URL: 'postgresql://crewflow_owner:dummy-password-for-a-unit-test-0000@db.example:5432/crewflow?sslmode=verify-full',
  APP_SECRET: 'unit-test-dummy-app-secret-abcdefghijklmnopqrstuvwxyz-0123456789',
  APP_URL: 'https://app.example.com',
  ACCOUNTS_URL: 'https://app.example.com',
  CORS_ORIGINS: 'https://app.example.com',
  TRUSTED_PROXY_CIDRS: '10.0.0.1/32',
  EMAIL_DRIVER: 'SMTP',
  EMAIL_SMTP_HOST: 'smtp.example.com',
  STORAGE_DRIVER: 'S3',
  STORAGE_KEY_PREFIX: 'production',
  S3_BUCKET: 'bucket',
  S3_REGION: 'auto',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_FORCE_PATH_STYLE: 'true',
  S3_SERVER_SIDE_ENCRYPTION: 'NONE',
  CREWFLOW_AUDIT_SINK: 'stdout',
  AI_ENABLED: 'false',
  HWS_RUNTIME_ENABLED: 'false',
  REDIS_URL: 'redis://rab-redis:6379',
});

const repoPackages = resolve(__dirname, '../../../../..');

describe('docker-compose.production.yml: every removed `${KEY:-default}` equals the code default (2026-11-19)', () => {
  const unset = validate({ ...PRODUCTION_BASE }) as unknown as Record<string, unknown>;

  it.each(Object.entries(REMOVED_SHARED))('%s: unset behaves exactly as the old compose value %p', (key, value) => {
    expect(key in PRODUCTION_BASE).toBe(false);
    const set = validate({ ...PRODUCTION_BASE, [key]: value }) as unknown as Record<string, unknown>;
    expect(unset[key]).toBeDefined();
    expect(unset[key]).toEqual(set[key]);
    expect(String(unset[key])).toBe(value);
  });

  it.each(Object.entries(REMOVED_PG_POOL))('%s: the pool settings are unchanged when unset (%p)', (key, value) => {
    const pick = (env: Record<string, string>) => {
      const r = resolvePgEnvironment(env, { enforceProcessPolicy: false });
      return { pool: r.pool, queryTimeoutMs: r.queryTimeoutMs };
    };
    expect(pick({ ...PRODUCTION_BASE })).toEqual(pick({ ...PRODUCTION_BASE, [key]: value }));
  });

  it.each(Object.entries(REMOVED_CONNECTION_BUDGET))('%s: the connection budget is unchanged when unset (%p)', (key, value) => {
    const declared = { ...PRODUCTION_BASE, PG_EXPECTED_API_INSTANCES: '1', PG_EXPECTED_WORKER_INSTANCES: '1' };
    expect(readDeploymentShape(declared)).toEqual(readDeploymentShape({ ...declared, [key]: value }));
  });

  it('WORKER_SHUTDOWN_TIMEOUT_MS (rab-worker): unset is the old compose value 30000', () => {
    expect(parseWorkerShutdownTimeoutMs(undefined)).toBe(30000);
    expect(parseWorkerShutdownTimeoutMs('')).toBe(parseWorkerShutdownTimeoutMs('30000'));
    expect(WORKER_SHUTDOWN_TIMEOUT_MS_DEFAULT).toBe(30000);
  });

  it.each(REMOVED_READ_ELSEWHERE.map((e) => [e.key, e.file, e]))('%s: %s defaults to the old compose value', (_key, file, entry) => {
    const source = readFileSync(join(repoPackages, file as string), 'utf8');
    expect(source).toMatch((entry as { expect: RegExp }).expect);
  });

  it('none of the removed keys is still listed on rab-api or rab-worker in docker-compose.production.yml', () => {
    const compose = readFileSync(join(repoPackages, 'rab-docker/docker-compose.production.yml'), 'utf8');
    const removed = [
      ...Object.keys(REMOVED_SHARED),
      ...Object.keys(REMOVED_PG_POOL),
      ...Object.keys(REMOVED_CONNECTION_BUDGET),
      'WORKER_SHUTDOWN_TIMEOUT_MS',
      ...REMOVED_READ_ELSEWHERE.map((e) => e.key),
    ];
    const listed = removed.filter((key) => new RegExp(`^\\s+${key}:`, 'm').test(compose));
    expect(listed).toEqual([]);
  });
});
