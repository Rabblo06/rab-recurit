import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsUrl, IsString, Max, Min, MinLength, IsNotEmpty } from 'class-validator';

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
   * rab-workforce-architecture.md §5.5.
   */
  @IsNotEmpty({ message: 'APP_SECRET is required — the process must not start without it' })
  @IsString()
  @MinLength(32, { message: 'APP_SECRET must be at least 32 characters' })
  APP_SECRET!: string;

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

  /** Base URL for links embedded in emails (password setup / reset). */
  @IsOptional()
  @IsUrl({ require_tld: false })
  APP_URL: string = 'http://localhost:5173';

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

  /** How many days past being marked DELETED a stored file's object is safe to actually purge — see `storage:reconcile`'s `--purge-deleted-images-older-than-days` flag, reused (not re-implemented) by the scheduled storage-cleanup job. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  STORAGE_CLEANUP_PURGE_DELETED_IMAGES_AFTER_DAYS: number = 30;
}
