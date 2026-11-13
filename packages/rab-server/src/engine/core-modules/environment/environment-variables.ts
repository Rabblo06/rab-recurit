import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsUrl, IsString, Matches, Max, MaxLength, Min, MinLength, IsNotEmpty, ValidateIf } from 'class-validator';

// Phase A pa-intervals
import { WORKER_SCAN_INTERVAL_SETTINGS as SCAN_INTERVALS } from './worker-scan-intervals';
import { TIMER_TRIGGER_KINDS_PATTERN } from '../../worker-shared/timer-trigger.contract';
// Phase B (B3): the deployment identity's accepted values, from their one definition.
import { DEPLOYMENT_ENVIRONMENTS, IDENTITY_BOOTSTRAP_VALUE } from '../../../database/deployment-identity/deployment-identity';

/**
 * Wave 1 lane A: a security flag accepts exactly `true`/`false`. Anything else is left as the raw
 * string, so `@IsBoolean()` rejects it and the process refuses to boot (fail closed on a typo such as
 * `APP_JWT_LEGACY_VERIFY_ENABLED=flase`, instead of silently picking either behaviour).
 */
function strictBoolean(value: unknown): unknown {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}

export class EnvironmentVariables {
  @IsOptional()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  /**
   * Phase B (B1) / DB-SETUP: the database connection. `PG_DATABASE_URL` is the one primary variable. In a deployment it is
   * the database ADMIN URL; api-prestart.sh (after the bootstrap child) and worker-start.sh replace it, before any runtime
   * process starts, with the derived crewflow_owner URL (database/owner-login/owner-credential.ts), so every runtime process
   * sees ONLY the crewflow_owner login: in production the API, the Worker and the migrate child refuse any other login
   * before connecting (database/owner-login/runtime-db-config.ts checkRuntimeLogin). A crewflow_owner URL is passed through
   * unchanged. The full rules — legacy names accepted only outside production (with a deprecation warning), conflicts
   * refused, URL parameter policy, TLS, strict numbers — live in src/database/postgres/pg-config.ts, which
   * env.validation.ts runs. The declarations below only give the keys a shape.
   */
  @IsOptional()
  @IsString()
  PG_DATABASE_URL?: string;

  /** Deprecated (non-production only; production refuses it). Superseded by PG_DATABASE_URL. */
  @IsOptional()
  @IsString()
  DATABASE_URL?: string;

  /** Runtime pool ceiling per process (default 10). Strictly validated in pg-config.ts (digits only, 1-100). */
  @IsOptional()
  @Type(() => String)
  @Matches(/^\d+$/, { message: 'PG_POOL_MAX_CONNECTIONS must be a whole number' })
  PG_POOL_MAX_CONNECTIONS?: string;

  /** Idle pooled connections are closed after this long (default 600000 ms; 0 = never). */
  @IsOptional()
  @Type(() => String)
  @Matches(/^\d+$/, { message: 'PG_POOL_IDLE_TIMEOUT_MS must be a whole number of milliseconds' })
  PG_POOL_IDLE_TIMEOUT_MS?: string;

  /** pg-pool allowExitOnIdle (default false). */
  @IsOptional()
  @Type(() => String)
  @IsIn(['true', 'false'], { message: 'PG_POOL_ALLOW_EXIT_ON_IDLE must be exactly true or false' })
  PG_POOL_ALLOW_EXIT_ON_IDLE?: string;

  /** Client-side query timeout (pg query_timeout) for runtime connections (default 30000 ms; at least the 30 s statement timeout). */
  @IsOptional()
  @Type(() => String)
  @Matches(/^\d+$/, { message: 'PG_DATABASE_PRIMARY_TIMEOUT_MS must be a whole number of milliseconds' })
  PG_DATABASE_PRIMARY_TIMEOUT_MS?: string;

  /** Accept a self-signed server certificate (default false). Refused in production. */
  @IsOptional()
  @Type(() => String)
  @IsIn(['true', 'false'], { message: 'PG_SSL_ALLOW_SELF_SIGNED must be exactly true or false' })
  PG_SSL_ALLOW_SELF_SIGNED?: string;

  /** PEM CA bundle that verifies the database server (default: the system CA store). Read at boot. */
  @IsOptional()
  @IsString()
  PG_SSL_CA_CERT_PATH?: string;

  /** Declares PG_DATABASE_URL a direct (non-pooled) connection. Never skips the Worker's session probe. */
  @IsOptional()
  @Type(() => String)
  @IsIn(['true', 'false'], { message: 'PG_DATABASE_URL_IS_DIRECT must be exactly true or false' })
  PG_DATABASE_URL_IS_DIRECT?: string;

  /**
   * Phase B (B4): optional read replica (a physical standby). Validated in pg-config.ts by the primary's URL policy and TLS
   * rules (verify-full in production) and refused when it names the primary. Reads opt in explicitly (src/database/replica).
   */
  @IsOptional()
  @IsString()
  PG_DATABASE_REPLICA_URL?: string;

  /** Client-side query timeout on the replica (default 30000 ms; same bounds as PG_DATABASE_PRIMARY_TIMEOUT_MS). */
  @IsOptional()
  @Type(() => String)
  @Matches(/^\d+$/, { message: 'PG_DATABASE_REPLICA_TIMEOUT_MS must be a whole number of milliseconds' })
  PG_DATABASE_REPLICA_TIMEOUT_MS?: string;

  /** Replica lag beyond which reads go back to the primary (default 5000 ms; 100..600000). */
  @IsOptional()
  @Type(() => String)
  @Matches(/^\d+$/, { message: 'PG_DATABASE_REPLICA_MAX_LAG_MS must be a whole number of milliseconds' })
  PG_DATABASE_REPLICA_MAX_LAG_MS?: string;

  /**
   * Phase B (B5): the declared deployment shape for the startup connection-budget check
   * (src/database/runtime/connection-budget.ts, which enforces the ranges and refuses a configured total above the
   * server's capacity). Identical on every service of one deployment. Instance counts unset → the check warns and skips.
   */
  @IsOptional()
  @Type(() => String)
  @Matches(/^\d{1,6}$/, { message: 'PG_EXPECTED_API_INSTANCES must be a whole number' })
  PG_EXPECTED_API_INSTANCES?: string;

  @IsOptional()
  @Type(() => String)
  @Matches(/^\d{1,6}$/, { message: 'PG_EXPECTED_WORKER_INSTANCES must be a whole number' })
  PG_EXPECTED_WORKER_INSTANCES?: string;

  @IsOptional()
  @Type(() => String)
  @Matches(/^\d{1,6}$/, { message: 'PG_EXPECTED_API_POOL_MAX must be a whole number' })
  PG_EXPECTED_API_POOL_MAX?: string;

  @IsOptional()
  @Type(() => String)
  @Matches(/^\d{1,6}$/, { message: 'PG_EXPECTED_WORKER_POOL_MAX must be a whole number' })
  PG_EXPECTED_WORKER_POOL_MAX?: string;

  @IsOptional()
  @Type(() => String)
  @Matches(/^\d{1,6}$/, { message: 'PG_EXPECTED_MIGRATE_CONNECTIONS must be a whole number' })
  PG_EXPECTED_MIGRATE_CONNECTIONS?: string;

  @IsOptional()
  @Type(() => String)
  @Matches(/^\d{1,6}$/, { message: 'PG_PROVIDER_RESERVED_CONNECTIONS must be a whole number' })
  PG_PROVIDER_RESERVED_CONNECTIONS?: string;

  /**
   * Phase B (B3, Agent A2's deployment identity): shape only here; the full rules (both-or-neither, the bound marker, the
   * bootstrap flag honoured only by production commands) live in src/database/deployment-identity/deployment-identity.ts.
   */
  @IsOptional()
  @IsIn([...DEPLOYMENT_ENVIRONMENTS], { message: `CREWFLOW_DEPLOYMENT_ENVIRONMENT must be one of: ${DEPLOYMENT_ENVIRONMENTS.join(', ')}` })
  CREWFLOW_DEPLOYMENT_ENVIRONMENT?: string;

  @IsOptional()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: 'CREWFLOW_DEPLOYMENT_ID must be a uuid' })
  CREWFLOW_DEPLOYMENT_ID?: string;

  /** Option A secondary check: must equal current_database() when set. */
  @IsOptional()
  @IsString()
  @MaxLength(63, { message: 'PG_EXPECTED_DATABASE_NAME must be a PostgreSQL identifier (at most 63 characters)' })
  PG_EXPECTED_DATABASE_NAME?: string;

  /** One-time bootstrap of an unbound production database; only this exact value is meaningful. */
  @IsOptional()
  @IsIn([IDENTITY_BOOTSTRAP_VALUE], { message: `CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP accepts only "${IDENTITY_BOOTSTRAP_VALUE}"` })
  CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP?: string;

  @IsNotEmpty({ message: 'REDIS_URL is required — the process must not start without it' })
  @IsString()
  REDIS_URL!: string;

  /**
   * Root secret. Refusing to boot without it is deliberate — see
   * rab-workforce-architecture.md §5.5. Wave 2 lane A2: it is never used
   * directly as a signing/MAC key any more, only as HKDF input with a purpose
   * label (keyring.util.ts): the default JWT kid `derived-v1`, the default
   * auth-cache MAC key, the legacy encryption key (`rab-secret-encryption`,
   * kept for existing ciphertext) and QR tokens. Raw APP_SECRET still VERIFIES
   * old `legacy`/kid-less access tokens while APP_JWT_LEGACY_VERIFY_ENABLED is
   * true. Production refuses a weak value (keyring.util.ts weakKeyMaterialReason).
   */
  @IsNotEmpty({ message: 'APP_SECRET is required — the process must not start without it' })
  @IsString()
  @MinLength(32, { message: 'APP_SECRET must be at least 32 characters' })
  APP_SECRET!: string;

  /**
   * Checkpoint 3 — versioned encryption keyring (SecretEncryptionService). Optional JSON array
   * string, e.g. `[{"kid":"2026-11","secret":"<32+ chars>"}]`. Structural/length validation happens
   * in SecretEncryptionService's constructor (fail closed at boot), not here, matching this file's
   * existing pattern for CORS_ORIGINS/TRUSTED_PROXY_CIDRS (base IsString here, real parsing in the
   * consumer). Unset means "no rotation has happened yet" — SecretEncryptionService then behaves
   * exactly as it did before this var existed: one implicit `legacy` key derived from APP_SECRET.
   * Never put APP_SECRET itself in this list — it is always implicitly present as `legacy`.
   */
  @IsOptional()
  @IsString()
  APP_ENCRYPTION_KEYRING?: string;

  /**
   * Which `kid` in APP_ENCRYPTION_KEYRING newly-encrypted values are written under. Required if
   * APP_ENCRYPTION_KEYRING is set (ambiguous otherwise which key is "active" for new writes);
   * ignored if it isn't (active key is always the implicit `legacy` one).
   */
  @IsOptional()
  @IsString()
  APP_ENCRYPTION_ACTIVE_KID?: string;

  /**
   * Checkpoint 3 — versioned JWT signing keyring (AccessTokenService). Same shape and the same
   * "byte-for-byte unchanged until configured" guarantee as APP_ENCRYPTION_KEYRING above, but kept
   * as a SEPARATE env var deliberately — rab-workforce-architecture.md's own instruction not to
   * confuse encryption keys with JWT-signing keys applies to configuration, not just code: rotating
   * one must never require touching the other, and a key compromised in one role should never also
   * be live in the other.
   */
  @IsOptional()
  @IsString()
  APP_JWT_SIGNING_KEYRING?: string;

  @IsOptional()
  @IsString()
  APP_JWT_ACTIVE_KID?: string;

  /**
   * Wave 1 lane A (B2), revised wave 2 lane A2: whether `AccessTokenService` still VERIFIES access
   * tokens under APP_SECRET-rooted kids it no longer signs with — `legacy` (raw APP_SECRET, also every
   * kid-less token) always, and `derived-v1` (HKDF of APP_SECRET) once a dedicated
   * APP_JWT_SIGNING_KEYRING is active. Default `true` — unchanged verification. Since wave 2 the
   * signing key is never raw APP_SECRET (`derived-v1` without a keyring), so `false` no longer needs a
   * keyring. Cut-over: deploy, wait one access-token TTL (15 min), then set this to false.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  APP_JWT_LEGACY_VERIFY_ENABLED: boolean = true;

  /**
   * Wave 2 lane A2 (key separation): dedicated secret for the auth-context cache HMAC
   * (`AuthContextCacheService`, F-06), 32+ characters, never shared with APP_SECRET or any keyring
   * secret (boot refuses reuse). Unset: the MAC key is HKDF-derived from APP_SECRET under its own
   * purpose label. Rotating it only turns cached entries into misses (rebuilt from PostgreSQL).
   */
  @IsOptional()
  @IsString()
  APP_AUTH_CACHE_HMAC_KEY?: string;

  /**
   * Wave 2 lane A2: end-state switch. `true` refuses to boot unless APP_JWT_SIGNING_KEYRING +
   * APP_JWT_ACTIVE_KID, APP_JWT_LEGACY_VERIFY_ENABLED=false and APP_AUTH_CACHE_HMAC_KEY are all set, i.e.
   * APP_SECRET is no longer the root of any JWT or cache-MAC key. Default `false` (owner decision per
   * environment). Strict boolean.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  APP_KEY_SEPARATION_REQUIRED: boolean = false;

  /**
   * Wave 2 lane A2 (B3): issue the browser auth cookies with the `__Host-` prefix (`__Host-crewflow_session`,
   * `__Host-rab_rt`, `__Host-crewflow_oauth_tx`, `__Host-crewflow_oauth_handoff`): Secure, Path=/, no
   * Domain, so a sibling subdomain can never set or overwrite them (cookie tossing). Default `false` —
   * byte-identical to the legacy names. Needs an https API origin (browsers drop Secure cookies on plain
   * http, except Chrome/Firefox on localhost). See auth-cookie-policy.ts for the migration rules.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  AUTH_COOKIE_HOST_PREFIX_ENABLED: boolean = false;

  /**
   * Wave 2 lane A2: only read when AUTH_COOKIE_HOST_PREFIX_ENABLED=true. `true` (default): `/auth/refresh`
   * still accepts a legacy-named refresh cookie when no `__Host-` one is present, rotates it into the
   * `__Host-` name, promotes the matching legacy session cookie and clears both legacy cookies (no forced
   * re-login). `false`: legacy names are never read (sessions that never migrated must sign in again).
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  AUTH_COOKIE_LEGACY_MIGRATION_ENABLED: boolean = true;

  @IsOptional()
  @IsUrl({ require_tld: false })
  SENTRY_DSN?: string;

  /** Comma-separated allowlist, e.g. "http://localhost:5173,https://console.rab.app" — never "*". */
  @IsOptional()
  @IsString()
  CORS_ORIGINS: string = 'http://localhost:5173';

  /**
   * PHASE 11 / EDGE-01 — comma-separated CIDR ranges (e.g.
   * "10.0.0.0/8,127.0.0.1/32,::1/128") naming the ONLY immediate socket
   * peers this process treats as a trusted reverse proxy. Both Express's
   * own `trust proxy` resolution (main.ts) and `resolveClientIp`'s
   * `CF-Connecting-IP` preference (client-ip.util.ts) are driven by this
   * SAME list — one canonical trust boundary, not two.
   *
   * Defaults to empty — fail closed. An unconfigured deployment trusts NO
   * forwarding header at all and uses the raw socket address for every
   * caller; this is always safe (never lets a direct client choose its own
   * rate-limit/audit IP) even though it collapses every real caller behind
   * an actual, still-unconfigured proxy into one shared address. Set this
   * to the verified immediate-peer range for your deployment (e.g. the
   * hosting platform's own internal edge network) once it is known — see
   * this phase's EDGE-01 production follow-up note.
   */
  @IsOptional()
  @IsString()
  TRUSTED_PROXY_CIDRS: string = '';

  /**
   * Selects the email transport driver — see EmailDriverFactory. Defaults
   * to LOGGER so local dev never sends real email unless explicitly
   * configured. SMTP requires EMAIL_SMTP_HOST; RESEND requires
   * RESEND_API_KEY (both checked by the factory at first send, not at
   * boot, since each is only required for its own driver).
   */
  @IsIn(['LOGGER', 'SMTP', 'RESEND'])
  EMAIL_DRIVER: string = 'LOGGER';

  /**
   * Gates ONE thing: whether StaffService/ManagerService.create() queues a
   * Staff/Manager account invite at creation
   * (AccountLifecycleService.isEmailDeliveryEnabled()); `false` creates the
   * account with no invite (a Manager can send one later). It is NOT a global
   * email kill switch: Resend invite, change-pending-email, password reset,
   * welcome, MFA notices, member/organisation invitations and notify() emails
   * do not read it (the Admin Panel only displays it). Since the owner's
   * "always queue" decision (Phase D-Q §12.1 #3) the Worker's Redis heartbeat
   * no longer takes part in that creation-time decision.
   * Same @Type/@Transform gotcha as EMAIL_SMTP_NO_TLS below — see its
   * comment for why @Type(() => String) is required here too.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  EMAIL_DELIVERY_ENABLED: boolean = true;

  /**
   * Hyper Workspace runtime cutover mode. Defaults to false (existing deployments and legacy-core behaviour unchanged).
   * When true: every workspace-scoped business read/write (TenantContextService.runInTenantContext with a non-null
   * ctx.workspaceId) resolves the caller's physical workspace schema through the registry (fail closed if not READY)
   * and binds search_path to exactly that schema, transaction-local, before the business callback runs. There is no
   * core fallback in this mode: a workspace that is not READY refuses the operation rather than silently reading or
   * writing core.* business tables. Core entities (explicit schema:'core') and explicitly core-qualified raw SQL are
   * unaffected either way. See docs/HANDOFF.md §32e for the cutover's current status and remaining gaps.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  HWS_RUNTIME_ENABLED: boolean = false;

  /**
   * P1E (FULL-ARCHITECTURE-UPGRADE-PLAN.md P1 program) — the Redis session/AuthContext cache
   * rollout flag. Defaults to false: every request takes the proven, unmodified PostgreSQL-only
   * path (`AuthSecuritySnapshotService.build()` exactly as P1C left it). When true, the SAME
   * service additionally consults/populates a version-keyed Redis cache — see
   * `AuthContextCacheService`'s own doc comment for why a cache HIT can never be stale: the
   * version vector is part of the cache KEY itself, not a value compared after the fact, so a
   * version bump makes the old key simply unreachable rather than relying on an explicit
   * invalidation step that could race or be skipped on a crash. Turning this off requires no data
   * migration — Redis holds no data this flag's own disablement needs to clean up; stale keys
   * expire on their own TTL and are never read once they are version-mismatched regardless of the
   * flag's state.
   *
   * Code-level default stays `false` deliberately, even though the Redis checkpoint's exit gate
   * has passed (p1e/p1f 8/8, full auth unit sweep 113/113, zero regressions) and `.env.example`'s
   * own default is now `true` for local/deployment use — flipping THIS class default would
   * silently turn caching on for every other existing integration test in this codebase that
   * never explicitly sets this var (most of them, unaudited against cache-on), not just for real
   * deployments. The owner-approved default-on applies to configured environments (local/.env,
   * deployment manifests), set explicitly there; it is not safe to apply retroactively to every
   * environment that happens to omit this var, including the test suite.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  AUTH_CONTEXT_CACHE_ENABLED: boolean = false;

  /**
   * Redis checkpoint — the Twenty-style Redis-first UserSession cache (`UserSessionCacheService`).
   * A SEPARATE flag from `AUTH_CONTEXT_CACHE_ENABLED` above, deliberately — the two caches hold
   * different data for different purposes (session identity vs. permissions snapshot) and must be
   * independently toggleable; neither implies the other.
   *
   * Code-level default stays `false` for the same reason `AUTH_CONTEXT_CACHE_ENABLED` above does
   * — see that field's comment. Its own exit gate passed: 8/8 dedicated cache tests (cold MISS,
   * warm HIT, revoked-despite-HIT, forged-stale-entry rejection, cross-session isolation, Redis
   * outage fallback, concurrent cold fill, mobile-path non-interference), 38/38 across the full
   * cookie-auth + P1E/P1F regression sweep, 113/113 auth unit tests, zero regressions, plus a
   * measured OFF-vs-ON benchmark (p50 15ms→10ms, p95 18ms→12ms, 100% steady-state hit rate, zero
   * errors). `.env.example`'s default is `true` for local/deployment use.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  USER_SESSION_CACHE_ENABLED: boolean = false;

  /**
   * Redis checkpoint — Core Entity Cache (`CoreEntityCacheService`). A read-through, Redis-backed
   * cache for a handful of frequently re-fetched, low-sensitivity DISPLAY projections (user
   * name/email/avatar, organisation name/slug/logo, manager profile summary, manager workspace
   * display fields, venue name) — never passwords, tokens, MFA secrets, payroll data, or anything
   * used as an authorization/RLS decision. Same epoch-in-key pattern as `AuthContextCacheService`
   * (see that file's own doc comment): a write bumps a per-row Redis epoch counter, which makes the
   * previous cache entry unreachable rather than relying on an explicit delete racing the write.
   *
   * Independently toggleable from every other cache flag in this file — none of the others gate
   * this one, and this one never gates any of them. Code-level default stays `false` for the same
   * reason `AUTH_CONTEXT_CACHE_ENABLED` above does: flipping it retroactively turns on caching for
   * every existing integration test that doesn't explicitly set this var.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  CORE_ENTITY_CACHE_ENABLED: boolean = false;

  /**
   * Redis checkpoint — Workspace Metadata Cache (`WorkspaceMetadataCacheService`). Caches only
   * NON-AUTHORITATIVE, workspace-scoped data that every HWS-mode request already resolves anyway
   * (today: `SchemaResolverService`'s successful schema-name/version resolution). Never consulted
   * for session validity, membership, permissions, account suspension, or any RLS decision — a
   * cache miss here always falls through to the exact same `core.workspace_schema_registry` read
   * the uncached path already performs, with identical fail-closed behaviour on every error case.
   *
   * Same false-by-default rationale as every other cache flag above.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  WORKSPACE_METADATA_CACHE_ENABLED: boolean = false;

  /**
   * Wave 5 lane OPS — in-process L1 (`MetadataL1CacheService`) in front of the Redis caches above, for NON-AUTHORISATION
   * metadata only: workspace -> schema resolution, host label -> workspace, and the static permission catalogue. Never
   * sessions, auth contexts, security versions or per-user permissions. Only active for a kind whose own Redis cache
   * flag is on (CORE_ENTITY_CACHE_ENABLED / WORKSPACE_METADATA_CACHE_ENABLED), and only while this process holds its
   * Redis invalidation subscription. Strict boolean; default false (enable per environment after the load test).
   */
  @IsOptional()
  @Type(() => String) // before Transform: stops enableImplicitConversion turning 'false' into true
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  METADATA_L1_CACHE_ENABLED: boolean = false;

  /** L1 entry lifetime: the worst-case staleness for a change nobody invalidated explicitly. 1000–5000 ms. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(5000)
  METADATA_L1_CACHE_TTL_MS: number = 2000;

  /** L1 entry cap (LRU eviction beyond it). 100–50000. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(50000)
  METADATA_L1_CACHE_MAX_ENTRIES: number = 5000;

  /** L1 approximate memory cap in bytes (LRU eviction beyond it). 1 MiB–64 MiB; default 8 MiB. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1048576)
  @Max(67108864)
  METADATA_L1_CACHE_MAX_BYTES: number = 8388608;

  /**
   * Wave 5 lane OPS (G6) — terminal outbox/event retention (rab-worker `outbox-retention.job.ts`, DB5's
   * `core.purge_terminal_*` functions). OWNER DECISION PENDING on the periods: off by default; when switched on it starts
   * in `report` mode (counts only, zero deletes). `purge` deletes terminal rows older than the per-table periods below.
   */
  @IsOptional()
  @Type(() => String) // before Transform: stops enableImplicitConversion turning 'false' into true
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  OUTBOX_RETENTION_ENABLED: boolean = false;

  @IsOptional()
  @IsIn(['report', 'purge'])
  OUTBOX_RETENTION_MODE: 'report' | 'purge' = 'report';

  /** SUGGESTED 90 d (owner decision G6). Floor 30 d (DB5 contract §5; the database refuses less too). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3650)
  OUTBOX_RETENTION_EMAIL_DAYS: number = 90;

  /** SUGGESTED 30 d (owner decision G6). Floor 30 d. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3650)
  OUTBOX_RETENTION_PUSH_DAYS: number = 30;

  /** SUGGESTED 7 d (owner decision G6). Floor 7 d (event_key dedupe window: see DB5 contract §5 caution). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(7)
  @Max(3650)
  OUTBOX_RETENTION_REALTIME_DAYS: number = 7;

  /** SUGGESTED 30 d (owner decision G6). Floor 30 d. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3650)
  OUTBOX_RETENTION_WORKER_EVENT_DAYS: number = 30;

  /** Rows per purge call (the DB caps at 10000). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  OUTBOX_RETENTION_BATCH_SIZE: number = 1000;

  /** Purge calls per (table, tenant scope) per cycle — bounds one cycle; a backlog drains over later cycles. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  OUTBOX_RETENTION_MAX_BATCHES_PER_SCOPE: number = 20;

  /** Cycle interval. 15–1440 minutes; default hourly. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(1440)
  OUTBOX_RETENTION_INTERVAL_MINUTES: number = 60;

  /**
   * Wave 4/5 (MFA-lane request) — purge of cross-host login handoffs (rab-worker `login-handoff-cleanup.job.ts`, DB5's
   * `core.login_handoff_cleanup`: rows expired or consumed more than 1 h ago). ON by default: short-lived security tokens,
   * not business records. Strict boolean.
   */
  @IsOptional()
  @Type(() => String) // before Transform: stops enableImplicitConversion turning 'false' into true
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  LOGIN_HANDOFF_CLEANUP_ENABLED: boolean = true;

  /** Cycle interval, 1–1440 minutes; default 15. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES: number = 15;

  /**
   * Phase D wave 2 (owner decision 2026-11-01) — retention switch for the account-invite cleanup (rab-worker
   * `account-invite-cleanup.job.ts`): may it automatically DELETE the user account of an invite that expired unused?
   *  - `false` (DEFAULT): no automatic deletion of any user account; today's externally visible behaviour is preserved,
   *    no alternative cleanup path is enabled, expired/revoked/consumed links are still rejected at redemption (that check
   *    lives in the auth/invite services, not in this job), and every audit/security check is unchanged.
   *  - `true`: the job may delete eligible users through the narrow definers. The SQL eligibility conditions are never
   *    weakened by this flag. **Needs a separate owner approval** (grace period, eligibility, audit wording, retention
   *    policy, rollback/monitoring): until it is recorded (`WORKER_INVITE_AUTO_DELETE_PRODUCTION_APPROVED` in
   *    env.validation.ts), `true` in production refuses to boot; test/development may set it for disposable tests.
   * Strict boolean: anything but true/false (e.g. `1`, `TRUE`, `yes`) refuses to boot — never silently true.
   * Validated by the API and the Worker alike (shared class); only the Worker acts on it.
   */
  @IsOptional()
  @Type(() => String) // before Transform: stops enableImplicitConversion turning 'false' into true
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean({ message: 'WORKER_INVITE_AUTO_DELETE_ENABLED must be exactly true or false' })
  WORKER_INVITE_AUTO_DELETE_ENABLED: boolean = false;

  /**
   * BullMQ worker migration (Lane A, M2) — how the jobs process schedules its periodic scans.
   *  - `interval`: every replica runs every loop on its own process-local timer (development and test).
   *  - `bullmq`: ONE cluster-wide BullMQ job scheduler per scan (`crewflow:<queue>:<jobName>`) hands each tick to one
   *    replica; a per-scan PostgreSQL advisory lock stops two replicas running the same scan at once. Requires a Redis whose
   *    `maxmemory-policy` is `noeviction` (refuses to boot otherwise).
   * O3 C2 (owner decision 2026-11-05, "exactly like Twenty"): UNSET means `bullmq` when NODE_ENV=production and `interval`
   * otherwise (env.validation.ts applies it), and `interval` in production refuses to boot — the interval timers are off
   * the production path. Anything else refuses to boot. The email/push/shift-statement consumers are the same in both modes.
   */
  @IsOptional()
  @IsIn(['interval', 'bullmq'])
  WORKER_SCHEDULER!: 'interval' | 'bullmq';

  /**
   * O3 C2 (owner decision 2026-11-05, Twenty's `DISABLE_CRON_JOBS_REGISTRATION`): exactly true or false (default false).
   *  - API image (api-prestart.sh): unless true, a one-shot `register-schedulers` command upserts every scan's BullMQ job
   *    scheduler (fixed ids) after the migrate step and before main.js; a registration failure is a loud WARNING and the API
   *    starts anyway (like Twenty's entrypoint).
   *  - Worker: true = CONSUME ONLY. It never upserts or removes a scheduler and never starts interval timers; it only
   *    verifies, read-only, that every enabled scheduler exists (a missing one is an ERROR and turns health unhealthy).
   *    true with WORKER_SCHEDULER=interval refuses to boot (it would schedule nothing).
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean({ message: 'DISABLE_CRON_JOBS_REGISTRATION must be exactly true or false' })
  DISABLE_CRON_JOBS_REGISTRATION: boolean = false;

  /**
   * Phase D-Q4a (owner approval 2026-11-04, OD-1): how the Worker walks the four 300-s shift-family scans (shift monitor,
   * attendance monitor, shift report scheduler, final timesheet).
   *  - `separate` (DEFAULT): four independent scans, each with its own workspace walk (today, unchanged).
   *  - `combined`: one scan `shift-scan-combined` walks the workspaces once and runs every DUE member's own discovery
   *    query inside that workspace's tenant transaction (one SAVEPOINT per member); each member then processes its own
   *    candidates exactly as in separate mode. Same SQL, keys, thresholds and transitions; each member keeps its interval.
   * Late clock-in is never a member. Exactly `separate` or `combined`; anything else refuses to boot. Combined mode also
   * refuses to boot when the members' intervals have no common tick of at least 30 s (env.validation.ts).
   */
  @IsOptional()
  @IsIn(['separate', 'combined'], { message: 'WORKER_SHIFT_SCAN_MODE must be exactly separate or combined' })
  WORKER_SHIFT_SCAN_MODE: 'separate' | 'combined' = 'separate';

  /**
   * Redis key prefix for the NEW BullMQ scan queues only (`bullmq` mode). Unset → `crewflow:<NODE_ENV>:bull`. The three
   * existing queues (`rab-email`, `rab-push`, `rab-shift-statements`) keep BullMQ's default `bull` prefix permanently —
   * the API publishes to two of them — so `bull` itself (or anything under `bull:`) is refused here.
   */
  @IsOptional()
  @IsString()
  @Matches(/^(?!bull(?::|$))[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)*$/, {
    message: 'BULLMQ_PREFIX must be letters/digits/_/- segments separated by ":" and must not be (or start with) the legacy "bull" prefix',
  })
  @MaxLength(80)
  BULLMQ_PREFIX?: string;

  /** `bullmq` mode: how often each replica re-checks (idempotently re-upserts) the Crewflow job schedulers. 10–3600 s; default 60. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(3600)
  WORKER_SCHEDULER_RECONCILE_SECONDS: number = 60;

  /**
   * PDF renderer P5 (owner decision D10): every report renders natively (@react-pdf/renderer, no browser). The key is
   * kept for ONE release and accepts only `native` (unset or empty = native); `chromium` refuses to boot, because this
   * Worker has no browser (roll back by redeploying the previous image). Delete the key in the release after.
   */
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsIn(['native'], { message: 'PDF_RENDERER must be exactly native (chromium was retired in P5: the Worker has no browser)' })
  PDF_RENDERER?: 'native' = 'native';

  /**
   * PDF renderer P1 — size of the native renderer's worker_threads pool (rab-worker queues/rab-reports/native/runtime,
   * `pdfNativeConcurrency`, which applies the same rule at render time). Unset (or empty, as for every variable) → 2;
   * exactly "1".."4"; anything else (spaces, "0", "5", "2.0") refuses to boot.
   */
  @IsOptional()
  @IsIn(['1', '2', '3', '4'], { message: 'PDF_NATIVE_CONCURRENCY must be an integer from 1 to 4' })
  PDF_NATIVE_CONCURRENCY?: '1' | '2' | '3' | '4';

  /**
   * PDF renderer P1 (F3) — render threads started at Worker boot when PDF_RENDERER=native (`pdfNativePrewarm`, rab-worker
   * native/runtime/render-pool.ts). Unset → min(2, PDF_NATIVE_CONCURRENCY); exactly "0".."4" ("0" = none); more than the
   * pool size refuses to start (checked at Worker boot, where the pool size is known); anything else refuses to boot.
   */
  @IsOptional()
  @IsIn(['0', '1', '2', '3', '4'], { message: 'PDF_NATIVE_PREWARM must be an integer from 0 to 4' })
  PDF_NATIVE_PREWARM?: '0' | '1' | '2' | '3' | '4';

  /**
   * PDF renderer P1 (review M-3) — total MB the native render threads' heap caps may add up to
   * (engine/worker-shared/pdf-native-memory.contract.ts). Unset (or empty) → 768, half of the Worker's default 1536m
   * mem_limit; a plain integer from 384 to 16384; anything else refuses to boot. Boot also refuses (env.validation.ts)
   * when PDF_NATIVE_CONCURRENCY × 384 MB exceeds it, so concurrent oversized renders fail their own thread with
   * error_PDF_NATIVE_OUT_OF_MEMORY instead of getting the whole Worker container OOM-killed. Raise it only together with
   * the Worker's mem_limit (CREWFLOW_WORKER_MEM_LIMIT).
   */
  @IsOptional()
  @IsString()
  PDF_NATIVE_MEMORY_BUDGET_MB?: string;

  // ───────────────────────── Phase D (D1/D2) — Worker dispatch claims and wake-ups ─────────────────────────
  // Read by rab-worker only (the API validates them like every variable but never acts on them). Supported combinations:
  // per_scope+poll (DEFAULT, today's behaviour), global+poll, global+event. event without global refuses to boot
  // (env.validation.ts); global needs the Worker's live database login to be `crewflow_worker` (the boot gate,
  // database/boot-checks/database-boot-gate-rules.ts — that rule needs the database, so it is not checked here).

  /**
   * Phase D-Q3: best-effort AFTER-COMMIT fast publish of the email_outbox / push_delivery rows NotificationService.notify()
   * writes in the caller's transaction (NotifyFastPublishService). DEFAULT false = today's behaviour: those rows wait for the
   * dispatcher's next tick. true = the same `.attempt.0` jobs the dispatcher's first publish adds are added right after the
   * transaction commits (never before; a rollback publishes nothing); the outbox row stays the record, nothing in the
   * database is changed by the fast path, and the dispatcher remains the safety net (its later add of the same jobId is
   * deduplicated). A latency change only. Read where notify() runs (the API; the Worker too if it is set there).
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  WORKER_FAST_PUBLISH_NOTIFY: boolean = false;

  /**
   * Phase D-Q4b (owner approval OD-3, 2026-11-04): delayed-job TIMER TRIGGERS for offer expiry, manager-confirmation
   * timeout, provisional no-show and late clock-in (engine/worker-shared/timer-trigger.contract.ts). The backstop scans keep
   * their intervals and code in every mode; triggers only let a transition happen earlier INSIDE its existing window, and
   * they add database work (no load reduction is claimed).
   *  - `off` (DEFAULT): today exactly — the API adds no trigger job, the Worker creates no trigger consumer and arms nothing.
   *  - `shadow`: triggers are armed and fire; the Worker runs a READ ONLY decision and logs/counts what it WOULD do. No
   *    business write, notification or audit row.
   *  - `on`: the Worker runs the scan's own per-candidate compare-and-set for the subject (same worker_event key, same
   *    notifications and audit as the scan).
   * Set the same value on the API (offer producers) and the Worker (consumer, no-show/late arming). Strict: exactly off,
   * shadow or on (OFF, On, ' on', true, 1 refuse to boot). Production `on` needs the owner's approval per kind (OD-3).
   */
  @IsOptional()
  @IsIn(['off', 'shadow', 'on'], { message: 'WORKER_TIMER_TRIGGERS must be exactly off, shadow or on' })
  WORKER_TIMER_TRIGGERS: 'off' | 'shadow' | 'on' = 'off';

  /**
   * Phase D-Q4b (OD-3 "on one kind at a time"): the trigger kinds WORKER_TIMER_TRIGGERS applies to — a comma-separated list
   * without spaces of offer-expiry, manager-confirmation, no-show, late-clock-in. Unset → all four. A kind not listed is
   * `off` for that kind. Unknown, misspelt, spaced or repeated items refuse to boot.
   */
  @IsOptional()
  @IsString()
  @Matches(TIMER_TRIGGER_KINDS_PATTERN, {
    message: 'WORKER_TIMER_TRIGGER_KINDS must be a comma-separated list (no spaces) of offer-expiry, manager-confirmation, no-show, late-clock-in',
  })
  WORKER_TIMER_TRIGGER_KINDS?: string;

  /**
   * How the email/push/realtime/statement dispatchers find due work.
   *  - `per_scope` (DEFAULT): walk every organisation/workspace and claim inside its own tenant transaction (today).
   *  - `global`: claim due routing ids through the `core.worker_claim_*_dispatch` SECURITY DEFINER functions (EXECUTE
   *    granted to `crewflow_worker` only), then process each id inside its own tenant scope.
   */
  @IsOptional()
  @IsIn(['per_scope', 'global'], { message: 'WORKER_CLAIM_MODE must be exactly per_scope or global' })
  WORKER_CLAIM_MODE: 'per_scope' | 'global' = 'per_scope';

  /**
   * What wakes the global claim.
   *  - `poll` (DEFAULT): the dispatch loops' own intervals.
   *  - `event`: a LISTEN connection on `crewflow_worker_wake` (a non-durable hint; rows are the truth) plus the backstop
   *    below. Needs WORKER_CLAIM_MODE=global and adds one listener connection per Worker replica (connection budget).
   */
  @IsOptional()
  @IsIn(['poll', 'event'], { message: 'WORKER_DISPATCH_MODE must be exactly poll or event' })
  WORKER_DISPATCH_MODE: 'poll' | 'event' = 'poll';

  /** event mode: a global claim runs at least this often even with no notification (lost NOTIFY, listener outage). 10–120 s; default 30. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'WORKER_DISPATCH_BACKSTOP_SECONDS must be a whole number of seconds' })
  @Min(10, { message: 'WORKER_DISPATCH_BACKSTOP_SECONDS must be at least 10' })
  @Max(120, { message: 'WORKER_DISPATCH_BACKSTOP_SECONDS must be at most 120' })
  WORKER_DISPATCH_BACKSTOP_SECONDS: number = 30;

  /**
   * global mode: how often the legacy per-scope sweep runs to pick up rows with no pointer (written before the triggers
   * existed, drift). 60–900 s; default 900. Owner decision (Phase D wave 3): 900 s is the normal maximum — a longer
   * interval needs a separate owner approval (a reviewed change here), so there is deliberately no override.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'WORKER_DISPATCH_RECONCILE_SECONDS must be a whole number of seconds' })
  @Min(60, { message: 'WORKER_DISPATCH_RECONCILE_SECONDS must be at least 60' })
  @Max(900, { message: 'WORKER_DISPATCH_RECONCILE_SECONDS must be at most 900 (a longer interval needs separate owner approval)' })
  WORKER_DISPATCH_RECONCILE_SECONDS: number = 900;

  /** global mode: routing ids requested per claim call (the server also clamps to 1..200). 1–200; default 100. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'WORKER_DISPATCH_CLAIM_BATCH must be a whole number' })
  @Min(1, { message: 'WORKER_DISPATCH_CLAIM_BATCH must be at least 1' })
  @Max(200, { message: 'WORKER_DISPATCH_CLAIM_BATCH must be at most 200' })
  WORKER_DISPATCH_CLAIM_BATCH: number = 100;

  // ───────────────────────── Phase A pa-intervals — worker scan intervals (seconds) ─────────────────────────
  // One key per periodic Worker scan. Defaults = the pre-existing hard-coded cadences (unset ⇒ no behaviour change);
  // bounds and their rationale live in worker-scan-intervals.ts (the single table the Worker also reads). Out of bounds,
  // non-integer or non-numeric refuses to boot. Read by rab-worker only.

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_ACCOUNT_INVITE_CLEANUP_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_ACCOUNT_INVITE_CLEANUP_INTERVAL_SECONDS.maxSeconds)
  WORKER_ACCOUNT_INVITE_CLEANUP_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_ACCOUNT_INVITE_CLEANUP_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS.maxSeconds)
  WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_PUSH_DISPATCH_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_PUSH_DISPATCH_INTERVAL_SECONDS.maxSeconds)
  WORKER_PUSH_DISPATCH_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_PUSH_DISPATCH_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_SHIFT_MONITOR_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_SHIFT_MONITOR_INTERVAL_SECONDS.maxSeconds)
  WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_SHIFT_MONITOR_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS.maxSeconds)
  WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS.maxSeconds)
  WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS.maxSeconds)
  WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_OFFER_EXPIRY_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_OFFER_EXPIRY_INTERVAL_SECONDS.maxSeconds)
  WORKER_OFFER_EXPIRY_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_OFFER_EXPIRY_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS.maxSeconds)
  WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS.maxSeconds)
  WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_TOKEN_CLEANUP_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_TOKEN_CLEANUP_INTERVAL_SECONDS.maxSeconds)
  WORKER_TOKEN_CLEANUP_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_TOKEN_CLEANUP_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS.maxSeconds)
  WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS.maxSeconds)
  WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS.maxSeconds)
  WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS.maxSeconds)
  WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_PAYROLL_PERIOD_ATTENTION_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_PAYROLL_PERIOD_ATTENTION_INTERVAL_SECONDS.maxSeconds)
  WORKER_PAYROLL_PERIOD_ATTENTION_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_PAYROLL_PERIOD_ATTENTION_INTERVAL_SECONDS.defaultSeconds;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SCAN_INTERVALS.WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS.minSeconds)
  @Max(SCAN_INTERVALS.WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS.maxSeconds)
  WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS: number = SCAN_INTERVALS.WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS.defaultSeconds;
  // ───────────────────────── end Phase A pa-intervals ─────────────────────────

  // ───────────────────────── AI Phase 1 + Part A (docs/ai/PHASE1_PLAN.md, docs/ai/PART_A_PLAN.md, modules/ai) ─────────
  // Every value below is an initial DESIGN default, not a statement of provider capacity or price. The model catalogue is
  // code (engine/core-modules/ai/models/ai-models.json + catalog.ts). Cross-field rules live in engine/core-modules/ai/ai-readiness.ts:
  // only a mock stand-in, the retired key alias (dev/test) and the dev flag outside development refuse to boot; every
  // other AI misconfiguration makes AI UNAVAILABLE (logged, admin-visible) without stopping the API or Worker. Keys are read by the server/Worker only
  // (the model gateway): never logged, shown as "configured" only by the admin environment viewer, never in a prompt.
  // Checklist before setting any of these for a real provider: docs/ai/CREWFLOW_AI_RELEASE_CHECKLIST.md.

  /**
   * Platform-wide AI kill switch. Off ⇒ every AI route answers 404 and the Worker refuses every queued turn.
   * Default ON by owner decision 2026-10-25 (deviation EX-2 from security spec rule 1.1; see
   * docs/ai/crewflow-ai-security-prompt.md appendix). AI still does nothing until a platform admin turns an
   * organisation's AI switch on (default OFF) and a model is ready; production sets AI_ENABLED=false explicitly in
   * docker-compose.production.yml and refuses `mock`, and no model is approved for production.
   */
  @IsOptional()
  @Type(() => String) // before Transform: stops enableImplicitConversion turning 'false' into true
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  AI_ENABLED: boolean = true;

  // Retired by Phase 1 "real models only" (docs/ai/PHASE1_TWENTY_PLAN.md §5): AI_PROVIDER, AI_MODEL and the
  // AI_PROVIDER_API_KEY alias are no longer properties. The model is chosen per organisation (Settings → AI); env.validation.ts
  // reads the old names from the RAW configuration only to refuse (mock stand-in; the alias in dev/test) or warn.

  /**
   * Secret. The Anthropic key (Twenty-style name, owner decision 2 / TP-2 — the name is written once in code, see
   * engine/core-modules/ai/models/provider-keys.ts). Passed explicitly to the provider SDK by the gateway only.
   */
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  @Matches(/^[\x21-\x7e]+$/, { message: 'ANTHROPIC_API_KEY must be printable ASCII without spaces (value not shown)' })
  ANTHROPIC_API_KEY?: string;

  /**
   * Secret, INERT in Phase 1 (TP-8, D4/D5): the Twenty-style OpenAI key name. No SDK for this provider is in the build
   * and none of its models is approved, so nothing reads it yet; the admin environment viewer shows "configured" only.
   */
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  @Matches(/^[\x21-\x7e]+$/, { message: 'OPENAI_API_KEY must be printable ASCII without spaces (value not shown)' })
  OPENAI_API_KEY?: string;

  /**
   * Secret, INERT in Phase 1 (TP-8, D4/D5): the Twenty-style Google (Gemini API) key name. No SDK for this provider is in the build
   * and none of its models is approved, so nothing reads it yet; the admin environment viewer shows "configured" only.
   */
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  @Matches(/^[\x21-\x7e]+$/, { message: 'GOOGLE_API_KEY must be printable ASCII without spaces (value not shown)' })
  GOOGLE_API_KEY?: string;

  /**
   * Secret, INERT in Phase 1 (TP-8, D4/D5): the Twenty-style Mistral key name. No SDK for this provider is in the build
   * and none of its models is approved, so nothing reads it yet; the admin environment viewer shows "configured" only.
   */
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  @Matches(/^[\x21-\x7e]+$/, { message: 'MISTRAL_API_KEY must be printable ASCII without spaces (value not shown)' })
  MISTRAL_API_KEY?: string;

  /**
   * Secret, INERT in Phase 1 (TP-8, D4/D5): the Twenty-style xAI key name. No SDK for this provider is in the build
   * and none of its models is approved, so nothing reads it yet; the admin environment viewer shows "configured" only.
   */
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  @Matches(/^[\x21-\x7e]+$/, { message: 'XAI_API_KEY must be printable ASCII without spaces (value not shown)' })
  XAI_API_KEY?: string;

  /**
   * Development-only escape hatch: a real provider may run only when NODE_ENV=development AND this is true AND the runtime
   * database is the development database AND the turn's organisation is marked `synthetic_data`. Boot refuses `true`
   * when NODE_ENV is production or test.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  AI_DEV_ALLOW_REAL_PROVIDERS: boolean = false;

  /**
   * Hard stop per organisation per UTC day on ESTIMATED provider cost (USD, catalogue prices × reported tokens). Every
   * model step reserves its worst-case cost first (atomic Redis script); a meter failure refuses the step.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 6 }, { message: 'AI_DAILY_BUDGET_USD must be a number with at most 6 decimal places' })
  @Min(0.000001, { message: 'AI_DAILY_BUDGET_USD must be positive' })
  @Max(10_000)
  AI_DAILY_BUDGET_USD: number = 2;

  /** Comma-separated catalogue ids no organisation may use (Twenty's name). A hard deny; no admin can override it. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9._,-]{0,2000}$/, { message: 'AI_MODELS_DEFAULT_DISABLED must be comma-separated model ids' })
  AI_MODELS_DEFAULT_DISABLED?: string;

  /**
   * Comma-separated catalogue ids for the `fast` tier when an organisation has no pin (Twenty's name): the first AVAILABLE
   * id wins, then AI_MODELS_DEFAULT_SMART (nearest tier), then any available model. Unknown ids are ignored with a
   * names-only warning. Cannot make an unapproved, keyless or disabled model available.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9._,-]{0,2000}$/, { message: 'AI_MODELS_DEFAULT_FAST must be comma-separated model ids' })
  AI_MODELS_DEFAULT_FAST?: string;

  /** Same as AI_MODELS_DEFAULT_FAST, for the `smart` tier. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9._,-]{0,2000}$/, { message: 'AI_MODELS_DEFAULT_SMART must be comma-separated model ids' })
  AI_MODELS_DEFAULT_SMART?: string;

  /** Per model call (each step). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(64)
  @Max(8000)
  AI_MAX_OUTPUT_TOKENS: number = 1500;

  /** Model steps (tool round trips) per turn. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(16)
  AI_MAX_STEPS: number = 8;

  /** Characters per user message. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(8000)
  AI_MAX_INPUT_CHARS: number = 4000;

  /** Hard stop per organisation per UTC day (input + output tokens), enforced by atomic Redis reservations. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(100_000_000)
  AI_ORG_DAILY_TOKEN_BUDGET: number = 200_000;

  /**
   * Questions per user per minute (one atomic three-bucket Redis call with AI_ORG_RATE_PER_MIN and AI_USER_TURNS_PER_DAY;
   * Redis unavailable ⇒ refused). Owner decision 2026-10-25: 10 (AI_RATE_LIMIT_DEFAULTS.userPerMinute).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  AI_USER_RATE_PER_MIN: number = 10;

  /** 7b: questions per ORGANISATION per minute (owner decision 2026-10-25: 60). A user limit above it only warns. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  AI_ORG_RATE_PER_MIN: number = 60;

  /** 7b: questions per user per UTC day (owner decision 2026-10-25: 100). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  AI_USER_TURNS_PER_DAY: number = 100;

  /**
   * 7b: the per-USER daily estimated-cost ceiling (USD); the effective ceiling is min(this, AI_DAILY_BUDGET_USD) (D7-2).
   * PROVISIONAL default 1.00 per person per day (AI_USER_DAILY_BUDGET_USD_DEFAULT) — flagged for the owner.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 6 }, { message: 'AI_USER_DAILY_BUDGET_USD must be a number with at most 6 decimal places' })
  @Min(0.000001, { message: 'AI_USER_DAILY_BUDGET_USD must be positive' })
  @Max(10_000)
  AI_USER_DAILY_BUDGET_USD: number = 1;

  /** Queued + running turns per organisation (Redis semaphore). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  AI_ORG_MAX_ACTIVE_TURNS: number = 2;

  /** Wall-clock limit of one turn in the Worker (model + tools); the turn ends AI_MODEL_TIMEOUT. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(300)
  AI_TURN_TIMEOUT_SECONDS: number = 90;

  /**
   * Conversation retention (days since the last message). The purge itself is governed by AI_RETENTION_MODE. Floor 30 d:
   * the database function refuses less (AiPhase1Schema1786720220000), so a lower value would only fail every cycle.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3650)
  AI_RETENTION_DAYS: number = 90;

  /** `off` (default): nothing runs. `report`: counts what would be purged. `purge`: deletes — the owner enables it. */
  @IsOptional()
  @IsIn(['off', 'report', 'purge'])
  AI_RETENTION_MODE: 'off' | 'report' | 'purge' = 'off';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(1440)
  AI_RETENTION_INTERVAL_MINUTES: number = 60;

  /**
   * Phase D-Q2: the Worker scan that ends AI turns stuck `queued` because their BullMQ job was lost (Redis loss). OFF by
   * default (not even scheduled). When on, a turn `queued` for longer than AI_STALE_TURN_THRESHOLD_MINUTES is finalised
   * `failed` / AI_WORKER_INTERRUPTED (the user asks again) — never re-run or requeued (owner rule 2026-11-02).
   */
  @IsOptional()
  @Type(() => String) // before Transform: stops enableImplicitConversion turning 'false' into true
  @Transform(({ value }) => strictBoolean(value)) // 'true' / 'false' only; TRUE, 1, yes, ' true' refuse to boot (review F46-1)
  @IsBoolean()
  AI_STALE_TURN_SWEEP: boolean = false;

  /**
   * How long a turn may stay `queued` before the sweep treats its job as lost. Default 15 min; floor 11 min because the
   * longest LEGITIMATE queued wait is bounded by the org-slot TTL = AI_TURN_TIMEOUT_SECONDS (max 300 s) + 5 min = 10 min
   * (a deferred successor gives up even earlier, at timeout + 60 s). The service re-checks against the live timeout and
   * refuses to run with a threshold that is not above it (fail closed).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(11)
  @Max(1440)
  AI_STALE_TURN_THRESHOLD_MINUTES: number = 15;

  /** Cadence of the stale-turn sweep (minutes, 1–60, default 5). Read by rab-worker only. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  AI_STALE_TURN_SWEEP_INTERVAL_MINUTES: number = 5;

  /**
   * AI Phase 2 (PHASE2_TWENTY_PLAN §2.5, P2-D8): a conversation's first question also enqueues one thread-title call on
   * the fast model, in the Worker, through the gateway with every EX-1 / payload / budget control. `false` ⇒ no title job
   * is enqueued and a queued one does nothing (the first-question fallback title stays). Not a boot refusal either way.
   */
  @IsOptional()
  @Type(() => String) // before Transform: stops enableImplicitConversion turning 'false' into true
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  AI_TITLE_GENERATION: boolean = true;

  /**
   * AI Phase 6a (docs/ai/PHASE6_TWENTY_PLAN.md §4, P6-D7): the platform switch for AI agents. Default `false`; production
   * pins it `'false'` (6b, docker-compose.production.yml). While false every `/rest/v1/ai/agents` route answers the uniform
   * 404 AI_NOT_AVAILABLE and nothing about agents is read or written. Even when true, 6a is STORAGE ONLY: no trigger can
   * be enabled and nothing runs until the owner approves EX-3 (`AI_AGENT_EXECUTION_APPROVED`). Only the exact string
   * `'true'` turns it on; any other value is off (fail closed) — never a boot refusal (2026-10-22 crash-loop lesson).
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  AI_AGENTS_ENABLED: boolean = false;

  /**
   * P1B.1 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.2 / docs/HANDOFF.md) — the `core.user_session`
   * enforcement cutover flag. Defaults to false: PRE-CUTOVER / transitional behaviour, where a
   * valid refresh-token family with no matching `core.user_session` row (a legacy session that
   * logged in before P1B shipped, or whose backfill hasn't run yet in this environment) is still
   * accepted — `core.refresh_token` remains the sole PRIMARY authority in this mode, exactly as
   * before P1B. When true: POST-CUTOVER — a missing `core.user_session` row for an otherwise
   * valid-looking refresh family is treated the same as an explicit revocation and DENIES the
   * request (`SessionValidityService.assertActive`). Flip this to true only after
   * `user-session:backfill --verify` reports `missing: 0` for every organisation in that
   * deployment — flipping it before backfill is complete would lock out every account whose
   * session predates P1B. Never silently inferred from backfill completion; an explicit,
   * auditable operator action (this env var), never a second competing authority.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  USER_SESSION_ENFORCEMENT_CUTOVER: boolean = false;

  /**
   * P1C.1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.6/§33.7.7) — system-level auth-provider
   * toggles. Effective availability for a request is always `AUTH_<PROVIDER>_ENABLED AND
   * core.organisation.<provider>_auth_enabled` — this env flag is the deployment-wide gate;
   * the per-organisation column (OrganisationAuthProviders1786680100000) is the tenant-level one.
   * Cross-field requirements (client id/secret/callback required when a provider is enabled; at
   * least one provider must be enabled) are enforced in env.validation.ts's validate(), the same
   * place STORAGE_DRIVER==='S3' already enforces its own cross-field requirements.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  AUTH_PASSWORD_ENABLED: boolean = true;

  /**
   * Wave 1 lane A (finding D-A1) — password sign-in attempt limits (`LoginAttemptLimiterService`), atomic
   * Redis token buckets on the bounded auth-cache client (the same `token-bucket.ts` script as the
   * invitation limits). Every bucket refills continuously over its window, so a limit SLOWS attempts
   * down; it never hard-locks an account. Redis unavailable ⇒ sign-in fails closed with 503.
   *
   * Per (normalised email, client IP) — the attacker's own address is slowed, the real user elsewhere
   * is not: a burst of AUTH_LOGIN_EMAIL_IP_BURST attempts, then one more per (window / burst).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_LOGIN_EMAIL_IP_BURST: number = 5;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_LOGIN_EMAIL_IP_WINDOW_SECONDS: number = 900;

  /** Second, slower per-(email, IP) tier: at most this many attempts per 24 hours (progressive slow-down after the burst tier). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_LOGIN_EMAIL_IP_DAILY_LIMIT: number = 30;

  /**
   * Account-wide ceiling across ALL client IPs (distributed guessing). Applies only to addresses that
   * have NOT signed in to this account successfully recently (AUTH_LOGIN_KNOWN_IP_TTL_DAYS), so a
   * distributed attack slows down unknown addresses but never locks the owner out of a device they
   * already use. A burst of AUTH_LOGIN_ACCOUNT_BURST, then one more per (window / burst).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_LOGIN_ACCOUNT_BURST: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_LOGIN_ACCOUNT_WINDOW_SECONDS: number = 900;

  /** How long a successful sign-in from an address exempts that (email, address) pair from the account-wide ceiling. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  AUTH_LOGIN_KNOWN_IP_TTL_DAYS: number = 30;

  // ── Wave 4 lane MFA: TOTP second factor, step-up, cross-host login handoff ──────────────────────────────────────────
  // Every enforcement switch defaults OFF (owner decision: nobody already signed in may be locked out by a deploy).
  // Enrolment is available to every web user regardless; a user who HAS enrolled is always challenged on web sign-in
  // (no flag can downgrade an enrolled account to password-only on web).

  /** Whether NEW enrolments may start (`/auth/mfa/enrolment/*`). Never affects users who already enrolled: they are still challenged. */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  AUTH_MFA_ENROLMENT_ENABLED: boolean = true;

  /** Require a second factor (enrolment at next sign-in if missing) for platform administrators. */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  AUTH_MFA_ENFORCE_PLATFORM_ADMIN: boolean = false;

  /** Require a second factor for the organisation owner (role `ceo`). */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  AUTH_MFA_ENFORCE_ORGANISATION_OWNER: boolean = false;

  /** Require a second factor for the organisation's current Initial Manager (manager_profile.is_initial_manager). */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  AUTH_MFA_ENFORCE_INITIAL_MANAGER: boolean = false;

  /** Require a second factor for every other web-console user (managers, custom workspace roles, org admins). */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  AUTH_MFA_ENFORCE_OTHER_WEB_USERS: boolean = false;

  /**
   * `exempt` (default): sign-ins to the mobile apps (staff_app / venue_manager_app) are never challenged — the mobile
   * apps have no second-factor screen yet. `require`: an ENROLLED user (or an enforced role) is challenged on mobile too,
   * which a mobile client without MFA support cannot complete. See WAVE4_LANE_MFA_REPORT.md (security trade-off).
   */
  @IsOptional()
  @IsIn(['exempt', 'require'])
  AUTH_MFA_MOBILE_POLICY: 'exempt' | 'require' = 'exempt';

  /** Lifetime of a pending sign-in second-factor challenge (single use). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(600)
  AUTH_MFA_CHALLENGE_TTL_SECONDS: number = 300;

  /** Wrong codes accepted against ONE challenge before it is destroyed (the user must sign in again). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  AUTH_MFA_CHALLENGE_MAX_ATTEMPTS: number = 5;

  /** Per-user (all IPs, all challenges, step-up included) code attempts: a burst of this many, refilling over the window. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_MFA_USER_ATTEMPTS_BURST: number = 10;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60)
  AUTH_MFA_USER_ATTEMPTS_WINDOW_SECONDS: number = 900;

  /** Issuer label shown in authenticator apps (`otpauth://` issuer). Display only. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  AUTH_MFA_ISSUER: string = 'Crewflow';

  /** How long a successful step-up (password + current code) on a session satisfies `assertRecentStepUp`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(900)
  AUTH_STEP_UP_WINDOW_SECONDS: number = 300;

  /**
   * `false` (default): the pre-existing password-only step-up actions (platform-admin grant/revoke, organisation
   * suspend/reactivate, user deletion, email change) keep accepting the password alone, because their dialogs have no
   * code field yet. `true`: an actor who has enrolled must also present a code (inline `mfaCode`, or a recent
   * `/auth/step-up`). MFA management itself ALWAYS requires password + code, independent of this flag.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS: boolean = false;

  /**
   * Cross-host login handoff (wave 3 joint step): a web sign-in completed on a host that is not the user's own
   * canonical workspace host issues NO session there; instead a single-use, short-lived handoff bound to that workspace
   * host is returned and exchanged on the workspace host for a host-only session. Requires WORKSPACE_HOST_ROUTING_ENABLED.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  AUTH_LOGIN_HANDOFF_ENABLED: boolean = false;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(60)
  AUTH_LOGIN_HANDOFF_TTL_SECONDS: number = 30;

  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  AUTH_GOOGLE_ENABLED: boolean = false;

  @ValidateIf((env: EnvironmentVariables) => env.AUTH_GOOGLE_ENABLED)
  @IsNotEmpty()
  @IsString()
  AUTH_GOOGLE_CLIENT_ID?: string;

  @ValidateIf((env: EnvironmentVariables) => env.AUTH_GOOGLE_ENABLED)
  @IsNotEmpty()
  @IsString()
  AUTH_GOOGLE_CLIENT_SECRET?: string;

  @ValidateIf((env: EnvironmentVariables) => env.AUTH_GOOGLE_ENABLED)
  @IsUrl({ require_tld: false, require_protocol: true })
  AUTH_GOOGLE_CALLBACK_URL?: string;

  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  AUTH_MICROSOFT_ENABLED: boolean = false;

  @ValidateIf((env: EnvironmentVariables) => env.AUTH_MICROSOFT_ENABLED)
  @IsNotEmpty()
  @IsString()
  AUTH_MICROSOFT_CLIENT_ID?: string;

  @ValidateIf((env: EnvironmentVariables) => env.AUTH_MICROSOFT_ENABLED)
  @IsNotEmpty()
  @IsString()
  AUTH_MICROSOFT_CLIENT_SECRET?: string;

  @ValidateIf((env: EnvironmentVariables) => env.AUTH_MICROSOFT_ENABLED)
  @IsUrl({ require_tld: false, require_protocol: true })
  AUTH_MICROSOFT_CALLBACK_URL?: string;

  /**
   * Fixed, not a free-form string (P1C.1B owner decision — deliberately NOT Twenty's own
   * `'common'` default, which accepts personal Microsoft accounts with no verified-email
   * claim). `'organizations'` restricts Microsoft login to Azure AD work/school accounts only.
   * Exposed as a closed `@IsIn` set of one, rather than omitted entirely, specifically so an
   * operator cannot widen it to `'common'`/`'consumers'` without an actual code change.
   */
  @ValidateIf((env: EnvironmentVariables) => env.AUTH_MICROSOFT_ENABLED)
  @IsIn(['organizations'])
  AUTH_MICROSOFT_TENANT: string = 'organizations';

  /**
   * OIDC issuer overrides for deterministic tests against a local mock identity provider. Unset in
   * every real deployment; `env.validation.ts` refuses either one when NODE_ENV=production, so a
   * misconfigured production process can never trust a non-Google / non-Microsoft issuer.
   */
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  AUTH_GOOGLE_ISSUER_URL?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  AUTH_MICROSOFT_ISSUER_URL?: string;

  /**
   * Google/Microsoft one-time login handoff (cutover flag). `false` (default) keeps the original
   * behaviour: the OAuth callback sets the session cookies itself. `true`: the callback only creates
   * a short-lived, browser-bound, single-use handoff, and the session is issued by
   * `POST /rest/v1/auth/oauth/complete`. Deploy the web app first (it understands both), then enable
   * locally, in staging, then production; remove the legacy path only after that.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  AUTH_OAUTH_HANDOFF_ENABLED: boolean = false;

  @IsOptional()
  @IsString()
  EMAIL_SMTP_HOST?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  EMAIL_SMTP_PORT: number = 587;

  @IsOptional()
  @IsString()
  EMAIL_SMTP_USER?: string;

  @IsOptional()
  @IsString()
  EMAIL_SMTP_PASSWORD?: string;

  /**
   * @Type(() => String) here isn't decoration boilerplate — without it,
   * enableImplicitConversion (env.validation.ts) coerces the raw string to
   * a real boolean via Boolean(value) *before* @Transform below runs,
   * turning both "true" and "false" into JS `true` (any non-empty string
   * is truthy) and making value === 'true' always compare a boolean
   * against a string. Pinning the type to String defers that coercion to
   * this Transform instead, which does it correctly.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  EMAIL_SMTP_NO_TLS: boolean = false;

  /**
   * Secret API key for the RESEND driver — never logged, never returned
   * from an API, never referenced outside EmailDriverFactory/ResendDriver.
   * Only required when EMAIL_DRIVER=RESEND.
   */
  @IsOptional()
  @IsString()
  RESEND_API_KEY?: string;

  /**
   * Sender identity for outbound email, e.g. "rab <no-reply@example.com>".
   * For the RESEND driver this address's domain must be verified in the
   * Resend dashboard (SPF/DKIM) — Resend rejects a `from` on a domain it
   * hasn't verified, so this cannot be an arbitrary third-party mailbox
   * (e.g. a personal Gmail address). Use EMAIL_REPLY_TO for that instead.
   */
  @IsOptional()
  @IsString()
  EMAIL_FROM_ADDRESS: string = 'rab <no-reply@example.com>';

  /** Optional Reply-To for outbound email — e.g. a personal inbox that isn't the verified sending domain. */
  @IsOptional()
  @IsString()
  EMAIL_REPLY_TO?: string;

  /**
   * Base URL of the authenticated Manager web application. No longer used to
   * build activation/reset email links (see `ACCOUNTS_URL`) — its one job now
   * is the absolute "Continue to Manager Portal" link returned by
   * `AuthService.activateAccount()`/`resetPassword()` once a Manager/CEO
   * completes one of those flows on the separate accounts domain.
   */
  @IsOptional()
  @IsUrl({ require_tld: false })
  APP_URL: string = 'http://localhost:5173';

  /**
   * Base URL for the public, pre-authentication account-lifecycle pages
   * (activate-account, reset-password, forgot-password) — deliberately
   * separate from `APP_URL` so these links never look like part of the
   * authenticated Manager application. Defaults to the same local dev server
   * as `APP_URL` since there's only one Vite dev server locally; production
   * points this at its own subdomain (e.g. accounts.rabworkspaceteams.co.uk).
   */
  @IsOptional()
  @IsUrl({ require_tld: false })
  ACCOUNTS_URL: string = 'http://localhost:5173';

  /**
   * Dynamic-domain-display checkpoint (docs/HANDOFF.md) — the `host[:port]` a workspace's
   * subdomain gets prefixed onto for display/preview purposes (`GET /rest/v1/config/domain`,
   * consumed by `CreateWorkspaceScreen.tsx`/Settings → Domains). Deliberately NOT derived from
   * `APP_URL` automatically: `APP_URL` is frequently a bare IP locally (`127.0.0.1:5173`), and
   * `issac.127.0.0.1` is not a valid DNS subdomain of an IPv4 literal — prefixing one onto an IP
   * would show a URL that can never actually resolve. Left UNSET on purpose for a fresh local
   * checkout (`.env.example` ships it commented out): the frontend then honestly shows the current
   * browser origin as the application URL, with no subdomain preview claimed, exactly per the
   * owner's own explicit requirement ("do not pretend that prefixing a subdomain to the IP
   * works"). A developer who wants real `issac.localhost:5173`-style local subdomain testing sets
   * this to `localhost:5173` themselves (see this repo's local-dev docs for the matching hosts/Vite
   * config). Production sets it to the real wildcard-DNS base domain (e.g.
   * `workspaces.rabworkspaceteams.co.uk`) — this value, not component source, is what changes.
   * This is presentation-only authority: it governs what URL is SHOWN, never what the backend
   * actually trusts for authentication/tenant resolution — see `rab-workforce-architecture.md` for
   * why hostname-based tenant routing itself (Parts 5-11 of the dynamic-domain checkpoint) is a
   * separate, not-yet-built piece of work, deliberately not conflated with this display config.
   * EXCEPTION (wave 1 lane A, D-C1): when WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED=true this value
   * also becomes AUTH-RELEVANT — it defines which non-reserved `<label>.<base>` origins CORS and the
   * cookie CSRF checks trust. With that flag off (the default) it is display-only, as above.
   */
  @IsOptional()
  @IsString()
  WORKSPACE_BASE_DOMAIN?: string;

  /**
   * Wave 1 lane A (finding D-C1). WORKSPACE_BASE_DOMAIN alone is display-only. Only when THIS flag is
   * also `true` does `EnvironmentService.isTrustedOrigin` (CORS, cookie CSRF, login/refresh
   * provenance, OAuth handoff) additionally trust `scheme://<label>.<WORKSPACE_BASE_DOMAIN>` — and
   * even then never a reserved label (`RESERVED_SUBDOMAINS`: api, admin, mail, ...), never an IDN
   * (`xn--`) label, and only https in production. Default `false`: nothing legitimate is served from
   * a workspace subdomain today, so the wildcard is pure attack surface (any sibling host's
   * JavaScript could drive a victim's credentialed session).
   *
   * Wave 3 lane H: REGISTRY-BACKED. With the flag on, an Origin is trusted only when it is exactly the
   * canonical origin (`<scheme>://<label>.<WORKSPACE_BASE_DOMAIN>`, scheme from APP_URL, https in
   * production) of a registered workspace that `core.resolve_workspace_by_host_label` reports routable
   * (READY, active, organisation not suspended). Reserved, released/quarantined, unknown and CREATING
   * labels are never trusted. Requires WORKSPACE_HOST_ROUTING_ENABLED=true (boot refused otherwise),
   * because the routing layer's wrong-host check is what stops a trusted workspace origin from
   * driving another workspace's session.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: boolean = false;

  /**
   * Wave 3 lane H (C5/C6). When `true` (and WORKSPACE_BASE_DOMAIN is set), the API resolves which
   * workspace a browser is addressing from the request host (`Host`, or `X-Forwarded-Host` only from a
   * TRUSTED_PROXY_CIDRS peer) or, when the API is on its own fixed host, from the browser's `Origin`:
   *   - `GET /rest/v1/public/workspace-host` answers default / workspace / renamed / not-found;
   *   - every authenticated request made from a workspace host whose workspace is not the session's own
   *     (server-derived) workspace is refused with a 404 that discloses nothing about that host;
   *   - workspace-specific email links use the workspace's canonical host.
   * The host is routing context only: it never grants access, never selects a workspace for a session
   * and never overrides RLS. Default `false`: behaviour is exactly as before wave 3.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => strictBoolean(value))
  @IsBoolean()
  WORKSPACE_HOST_ROUTING_ENABLED: boolean = false;

  /**
   * Selects the file storage driver — see StorageDriverFactory. LOCAL writes
   * to STORAGE_LOCAL_ROOT on the process's own disk (development, unit
   * tests). S3 uses any S3-compatible object store (AWS S3, Cloudflare R2,
   * DigitalOcean Spaces, MinIO) and is what staging/production must use:
   * API and Worker are separate processes/containers, so durable files can
   * never live on either one's disk. `env.validation.ts` refuses to boot
   * with S3 selected but incomplete.
   */
  @IsIn(['LOCAL', 'S3'])
  STORAGE_DRIVER: string = 'LOCAL';

  @IsOptional()
  @IsString()
  STORAGE_LOCAL_ROOT: string = './storage';

  /** First path segment of every object key (e.g. `prod`, `staging`) so environments can share one bucket safely. Never authorization. */
  @IsOptional()
  @IsString()
  STORAGE_KEY_PREFIX: string = 'dev';

  @IsOptional()
  @IsString()
  S3_BUCKET?: string;

  /** Region is environment-driven and never hard-coded in business code (e.g. `eu-west-2` for UK production). */
  @IsOptional()
  @IsString()
  S3_REGION?: string;

  /** Only for non-AWS providers (R2, Spaces, MinIO). Leave unset for AWS S3. */
  @IsOptional()
  @IsUrl({ require_tld: false })
  S3_ENDPOINT?: string;

  /** Secret — never logged, never returned from an API, never referenced outside the S3 driver. */
  @IsOptional()
  @IsString()
  S3_ACCESS_KEY_ID?: string;

  /** Secret — see S3_ACCESS_KEY_ID. */
  @IsOptional()
  @IsString()
  S3_SECRET_ACCESS_KEY?: string;

  /**
   * Required by R2/MinIO/Spaces and most non-AWS providers; AWS S3 should
   * keep it false. Same @Type/@Transform gotcha as EMAIL_SMTP_NO_TLS, PLUS
   * one more: mapping every non-"true" string to `false` (as the other
   * boolean vars in this file do) would silently accept a typo'd value like
   * "yes" as `false` instead of refusing to boot — this one instead passes
   * anything that isn't exactly "true"/"false" straight through unconverted,
   * so @IsBoolean() below correctly rejects it as invalid.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  S3_FORCE_PATH_STYLE: boolean = false;

  /** Lifetime of a presigned URL. Short on purpose: a URL is a bearer token for one object. */
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(30)
  @Max(900)
  S3_SIGNED_URL_TTL_SECONDS: number = 120;

  /** Hard ceiling for any single stored object (bytes). Per-kind limits are lower still. */
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1024)
  S3_MAX_UPLOAD_BYTES: number = 20 * 1024 * 1024;

  /** Server-side encryption. `AES256` = SSE-S3. `aws:kms` needs S3_KMS_KEY_ID. Empty disables (only for providers that reject the header). */
  @IsOptional()
  @IsIn(['AES256', 'aws:kms', 'NONE'])
  S3_SERVER_SIDE_ENCRYPTION: string = 'AES256';

  @IsOptional()
  @IsString()
  S3_KMS_KEY_ID?: string;

  /** Displayed on Admin Panel → General. Not resolved from package.json (rootDir/dist path assumptions are fragile) — set explicitly at deploy time if accurate reporting matters. */
  @IsOptional()
  @IsString()
  APP_VERSION: string = 'dev';

  /**
   * Admin Panel → General "Commit". The git commit the running image was built from (short or full hex SHA), set at
   * build/deploy time (e.g. a Docker build arg passed through to the container environment). Optional: unset → the panel
   * shows "Unknown", never a guess. Validated as hex so nothing else can be smuggled into the page. An EMPTY value
   * (e.g. a Docker build arg that was not passed) counts as unset rather than refusing to boot.
   */
  @IsOptional()
  @ValidateIf((env: EnvironmentVariables) => env.APP_GIT_COMMIT !== '')
  @Matches(/^[0-9a-f]{7,40}$/)
  APP_GIT_COMMIT?: string;

  /**
   * Clock-in opens this many minutes before `shift.startsAt` — see
   * `AttendanceService.clockIn`'s time-window check. First business-rule
   * numeric value to live in validated env config (existing numeric business
   * rules elsewhere, e.g. offer expiry, are hardcoded local constants) —
   * deliberately config-driven per this feature's own requirement, without
   * retrofitting the pre-existing hardcoded ones.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  CLOCK_IN_EARLY_MINUTES: number = 15;

  /** The Shift QR (and the clock-out window) stays valid this many minutes past `shift.endsAt`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  QR_POST_SHIFT_GRACE_MINUTES: number = 120;

  /** The pre-shift roster+QR report is generated/emailed this many minutes before `shift.startsAt`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  REPORT_AVAILABLE_BEFORE_MINUTES: number = 180;

  /** A clock-in/out location fix reporting worse accuracy than this (metres) is rejected — see `AttendanceService`'s geofence check. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  GEOFENCE_MAX_ACCURACY_M: number = 100;

  /**
   * Check In / Clock In / Clock Out location evidence at a geofence-enforcing venue must have been captured on the device
   * no longer than this many seconds before the server receives it (FLAGGED default, owner to confirm). Older → LOCATION_STALE.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  LOCATION_EVIDENCE_MAX_AGE_SECONDS: number = 120;

  /** Tolerated device-clock skew: a fix stamped more than this many seconds in the server's future is refused (LOCATION_STALE). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  LOCATION_EVIDENCE_MAX_FUTURE_SKEW_SECONDS: number = 30;

  /**
   * How late a confirmed shift's clock-in can run before the worker flags
   * it — a genuinely new setting (rab-worker migration), not a duplicate of
   * an existing one: the only related existing value is the hardcoded
   * `NO_SHOW_GRACE_MS` (30 min) in `shift-monitor.job.ts`, which is a
   * DIFFERENT, later escalation (no clock-in at all, ever). Default (10)
   * is deliberately well below that 30-minute no-show threshold so "late"
   * fires as an earlier, softer warning before "no-show" ever does.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  LATE_CLOCK_IN_GRACE_MINUTES: number = 10;

  // MANAGER_CONFIRMATION_TIMEOUT_MINUTES was removed (owner decision Q12, 2026-11-06): the system never confirms an
  // offer, and the manager-confirmation deadline is the fixed rule `MANAGER_CONFIRMATION_LEAD_MINUTES` in @rab/shared
  // (standard: assignment start − 30 min; replacement/standby: window end), not a tunable. A deployment that still sets
  // the variable keeps booting: unknown keys are ignored by this validation.

  /**
   * Member-invitation rate limits (`InvitationRateLimitService`, atomic Redis token buckets on the bounded
   * auth-cache client). Each bucket refills continuously over its window; a request is admitted only if EVERY
   * bucket it touches has capacity, and then all are debited together. Redis unavailable ⇒ sending fails closed
   * (503), it never falls back to "unlimited". Listing invitations never touches these buckets.
   */
  /** Invitation emails (sends + resends) one recipient address may receive across all organisations, per 24 hours. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  MEMBER_INVITE_RATE_RECIPIENT_PER_DAY: number = 6;

  /** Invitation emails one administrator may trigger, per hour. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  MEMBER_INVITE_RATE_ACTOR_PER_HOUR: number = 60;

  /** Invitation emails one organisation may trigger, per 24 hours. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  MEMBER_INVITE_RATE_ORGANISATION_PER_DAY: number = 500;

  /** Public invitation look-up / acceptance attempts per client IP, per hour (on top of the route's own 5/min throttle). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  MEMBER_INVITE_RATE_REDEEM_PER_IP_PER_HOUR: number = 30;

  /** How many days past being marked DELETED a stored file's object is safe to actually purge — see `storage:reconcile`'s `--purge-deleted-images-older-than-days` flag, reused (not re-implemented) by the scheduled storage-cleanup job. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  STORAGE_CLEANUP_PURGE_DELETED_IMAGES_AFTER_DAYS: number = 30;

  // Phase A pa-storage — storage reconciliation cost controls (new keys only; nothing above changed).
  /**
   * How `storage:reconcile` (CLI and the Worker's storage-cleanup job) learns what the object store holds.
   * `list` (default): one paginated LIST of the prefix, HEAD only for rows the listing cannot settle (see the command's
   * doc comment). `head`: the historical one-HEAD-per-row behaviour — the rollback switch.
   */
  @IsOptional()
  @IsIn(['list', 'head'])
  STORAGE_RECONCILE_METHOD: 'list' | 'head' = 'list';

  /**
   * Worker storage-cleanup only: skip a cycle when a successful storage cleanup finished less than this many minutes ago
   * (cluster-wide, read from the Worker stats hash). Stops the 24 h reconciliation from re-running on every Worker boot
   * or on every interval-mode replica. 0 = never skip (the historical behaviour). Capped at 1200 (20 h) so the regular
   * 24 h cycle itself is never skipped. Default 720 (12 h).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1200)
  STORAGE_CLEANUP_MIN_SPACING_MINUTES: number = 720;
  // end Phase A pa-storage

  /**
   * Stage 3 real-time gateway (`RealtimeGatewayController`'s `/rest/v1/realtime/stream` SSE route).
   * Defaults to `false` — same "disabled until its own exit gate passes, never auto-enabled" rule
   * this file already applies to every cache flag above. The route still exists and is still
   * guarded by the ordinary `JwtAuthGuard` either way; when this is `false` the handler closes the
   * stream immediately after authenticating, so no Redis subscription or connection-registry entry
   * is ever created.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  REALTIME_ENABLED: boolean = false;

  /** How often an open SSE connection re-checks `SecurityVersionService.readVector()` (cheap, version-only) to detect mid-connection revocation/permission/membership changes without redoing the full, expensive `AuthSecuritySnapshotService.build()`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5_000)
  REALTIME_HEARTBEAT_INTERVAL_MS: number = 30_000;

  /** Bounds one authenticated user's own fan-out (e.g. several open browser tabs) — never a cross-user limit. A connection beyond this is refused, not queued. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  REALTIME_MAX_CONNECTIONS_PER_USER: number = 3;

  /**
   * Stage 6 durable push delivery. Defaults to `false` — same "disabled until its own exit gate
   * passes" rule as REALTIME_ENABLED above. When `false`, `PushDeliveryService` never creates a
   * `push_delivery` row at all (not merely "creates one that never gets picked up") — so toggling
   * this on/off has zero schema or data-shape implications, only whether rows start existing.
   */
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  PUSH_ENABLED: boolean = false;

  /**
   * FAKE (default) — one universal `FakeFcmDriver`, used for every device regardless of platform,
   * no real provider, no credentials required; safe for every ordinary test and local dev run.
   * REAL — android devices route to `FcmDriver` (`firebase-admin`, HTTP v1), ios devices route to
   * `ApnsDriver` (direct Apple APNs HTTP/2 provider API — never through Firebase, per the owner's
   * explicit architecture decision: Android via FCM, iPhone via direct APNs). Each real driver
   * checks its own credential at first send, not at boot — same deferred-check convention as
   * EMAIL_DRIVER.
   */
  @IsIn(['FAKE', 'REAL'])
  PUSH_PROVIDER: string = 'FAKE';

  /**
   * The Firebase service-account JSON, as a raw string — never committed to `.env`/`.env.example`
   * (Stage 6 §16: no secret rotation, no committed credential), never required for PUSH_PROVIDER=FAKE.
   * When unset under PUSH_PROVIDER=REAL, the FCM driver falls back to application-default
   * credentials (workload identity) rather than failing — see FcmDriver's own doc comment.
   */
  @IsOptional()
  @IsString()
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;

  /**
   * Direct-APNs provider-token auth (Apple's HTTP/2 Provider API, JWT ES256) — never required for
   * PUSH_PROVIDER=FAKE. All four fields below are required together once PUSH_PROVIDER=REAL AND an
   * ios device exists; `ApnsDriver` checks this at first ios send, not at boot (same convention as
   * FCM). None of these are ever committed to `.env`/`.env.example` (Stage 6 §16).
   */
  @IsOptional()
  @IsString()
  APNS_AUTH_KEY_P8?: string;

  @IsOptional()
  @IsString()
  APNS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  APNS_TEAM_ID?: string;

  /** The iOS app's bundle identifier — sent as the `apns-topic` header on every APNs request. */
  @IsOptional()
  @IsString()
  APNS_BUNDLE_ID?: string;

  /** sandbox (default) talks to `api.sandbox.push.apple.com` — development-signed builds only ever register tokens that sandbox will accept. */
  @IsOptional()
  @IsIn(['sandbox', 'production'])
  APNS_ENVIRONMENT: string = 'sandbox';

  /** Bounds one push_delivery row's own retry count — independent of EMAIL's own max, since the two providers have different failure/backoff characteristics. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  PUSH_DELIVERY_MAX_ATTEMPTS: number = 5;

  // ---------------------------------------------------------------------------------------------------------------------
  // Owner-login architecture (PERMANENT-OWNER-LOGIN-ADDENDUM; M0 §7). The full rules (required on the API service; an
  // explicit approval mode for a production runtime that migrates on start; the removed CREWFLOW_DB_MODE) live in the one
  // shared parser, database/owner-login/runtime-db-config.ts, which env.validation.ts runs too. These declarations give
  // the values a type and their allowed sets. Strings, exactly as written.
  // ---------------------------------------------------------------------------------------------------------------------

  /** true: the API image entrypoint applies pending migrations on start (short-lived child, migration lock). false: a release step does. */
  @IsOptional()
  @IsIn(['true', 'false'], { message: 'CREWFLOW_MIGRATE_ON_START must be exactly true or false' })
  CREWFLOW_MIGRATE_ON_START?: 'true' | 'false';

  /** none | token: whether a migrate-on-start run needs the per-release approval token (CREWFLOW_MIGRATION_APPROVED). */
  @IsOptional()
  @IsIn(['none', 'token'], { message: 'CREWFLOW_MIGRATION_APPROVAL_MODE must be exactly none or token' })
  CREWFLOW_MIGRATION_APPROVAL_MODE?: 'none' | 'token';

  /**
   * O3 C1 (owner decision 2026-11-05, Twenty's switch): true = this process never migrates. On the API it overrides
   * CREWFLOW_MIGRATE_ON_START (api-prestart.sh runs only the read-only pending check). The Worker never migrates either way.
   */
  @IsOptional()
  @IsIn(['true', 'false'], { message: 'DISABLE_DB_MIGRATIONS must be exactly true or false' })
  DISABLE_DB_MIGRATIONS?: 'true' | 'false';

  /**
   * O3 C3 (owner decision 2026-11-05): continue (default) | refuse — what the API does when a schema UPGRADE migration fails.
   * continue: the migrate child logs an ERROR and exits 70; api-prestart.sh starts main.js with CREWFLOW_UPGRADE_INCOMPLETE.
   * A first install, the configuration, the identity, the lock, the approval and the post-checks stay fail-closed.
   */
  @IsOptional()
  @IsIn(['continue', 'refuse'], { message: 'CREWFLOW_UPGRADE_FAILURE must be exactly continue or refuse' })
  CREWFLOW_UPGRADE_FAILURE?: 'continue' | 'refuse';

  /** DEPRECATED alias of CREWFLOW_UPGRADE_FAILURE: refuse -> refuse, continue-if-compatible -> continue (the two must agree). */
  @IsOptional()
  @IsIn(['refuse', 'continue-if-compatible'], { message: 'CREWFLOW_UPGRADE_FAILURE_POLICY must be exactly refuse or continue-if-compatible' })
  CREWFLOW_UPGRADE_FAILURE_POLICY?: 'refuse' | 'continue-if-compatible';

  /**
   * O3 C3: set ONLY by api-prestart.sh, on main.js, after a verified exit 70 (an upgrade migration failed and
   * CREWFLOW_UPGRADE_FAILURE=continue): the failing migration's name, or `unknown`. api-prestart.sh REFUSES (exit 64) an
   * inherited value, so an operator cannot pre-set it. Read by /healthz (`upgradeFailed: true`, informational; never the name) and by the API's
   * boot gate (Agent 3). A migration name only: letters, digits, `_`, `-`, `.`, at most 200 characters.
   */
  @IsOptional()
  @Matches(/^[A-Za-z0-9_.-]{1,200}$/, { message: 'CREWFLOW_UPGRADE_INCOMPLETE must be a migration name (letters, digits, _ - .) or unknown' })
  CREWFLOW_UPGRADE_INCOMPLETE?: string;
}
