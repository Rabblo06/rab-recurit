import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsUrl, IsString, Max, Min, MinLength, IsNotEmpty, ValidateIf } from 'class-validator';

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
   * Backs SecretEncryptionService (bank details, NI numbers) and JWT
   * signing. Refusing to boot without it is deliberate — see
   * rab-workforce-architecture.md §5.5. Also the "legacy" (kid-less) key
   * both services fall back to when no keyring below is configured — their
   * behaviour with neither new var set is byte-for-byte identical to before
   * this keyring existed.
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
   */
  @IsOptional()
  @IsString()
  WORKSPACE_BASE_DOMAIN?: string;

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
