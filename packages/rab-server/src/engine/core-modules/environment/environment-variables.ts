import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsUrl, IsString, Max, Min, MinLength, IsNotEmpty, ValidateIf } from 'class-validator';

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

  @IsNotEmpty({ message: 'DATABASE_URL is required — the process must not start without it' })
  @IsString()
  DATABASE_URL!: string;

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
   * Operator kill-switch, independent of the worker heartbeat check
   * AccountLifecycleService.isEmailDeliveryAvailable() also performs — lets
   * an operator disable all outbound invite/welcome email (e.g. during a
   * maintenance window) even while the worker itself is technically up.
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

  /**
   * How long a `STAFF_ACCEPTED` offer can wait for a manager's confirm/reject
   * before the worker automatically closes it out. NOT a duplicate of an
   * offer's own `expiresAt`/`expiresInHours` (that governs the STAFF's
   * response window, already enforced by the existing offer-expiry job) —
   * this is the separate manager-side half of the same two-step
   * confirmation flow. Never auto-CONFIRMS (a seat is only ever claimed by
   * an actual manager action or an auto-confirm shift's own accept) — PHASE
   * 7 made this atomically auto-REJECT (`STAFF_ACCEPTED -> MANAGER_REJECTED`,
   * the same edge a manager's own manual reject already used, `rejected_by`
   * left NULL to distinguish a system timeout from a real person) once the
   * deadline (`staff_accepted_at + this duration`) passes, replacing an
   * earlier notify-only-forever implementation that never resolved the
   * offer at all. See `queues/rab-offers/offer-expiry.job.ts`'s
   * `runManagerConfirmationTimeoutCycle` and `claim-manager-confirmation-
   * timeout.ts`'s own doc comment for the exact atomic claim.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  MANAGER_CONFIRMATION_TIMEOUT_MINUTES: number = 60;

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
}
