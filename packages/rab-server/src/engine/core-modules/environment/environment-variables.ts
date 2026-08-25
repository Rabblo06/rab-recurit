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
   * Selects the email transport driver — see EmailDriverFactory. Defaults
   * to LOGGER so local dev never sends real email unless explicitly
   * configured. SMTP requires EMAIL_SMTP_HOST (checked by the factory at
   * first send, not at boot, since it's only required for that one value).
   */
  @IsIn(['LOGGER', 'SMTP'])
  EMAIL_DRIVER: string = 'LOGGER';

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

  /** Sender identity for outbound email, e.g. "rab <no-reply@example.com>". */
  @IsOptional()
  @IsString()
  EMAIL_FROM_ADDRESS: string = 'rab <no-reply@example.com>';

  /** Base URL for links embedded in emails (password setup / reset). */
  @IsOptional()
  @IsUrl({ require_tld: false })
  APP_URL: string = 'http://localhost:5173';

  /**
   * Selects the file storage driver — see StorageDriverFactory. LOCAL is
   * the only driver today (writes to STORAGE_LOCAL_ROOT on the API
   * server's own disk); an S3 driver is a later, backend-agnostic addition.
   */
  @IsIn(['LOCAL'])
  STORAGE_DRIVER: string = 'LOCAL';

  @IsOptional()
  @IsString()
  STORAGE_LOCAL_ROOT: string = './storage';

  /** Displayed on Admin Panel → General. Not resolved from package.json (rootDir/dist path assumptions are fragile) — set explicitly at deploy time if accurate reporting matters. */
  @IsOptional()
  @IsString()
  APP_VERSION: string = 'dev';
}
