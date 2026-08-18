import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUrl, IsString, Max, Min, MinLength, IsNotEmpty } from 'class-validator';

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
   * Resend API key for account-invite/password-reset email. Deliberately
   * optional, not required-to-boot like APP_SECRET: EmailService logs and
   * no-ops when this is unset rather than throwing, so the rest of the
   * account lifecycle (tokens, mustResetPassword, audit log) stays fully
   * testable without live credentials. Nothing fakes a successful send.
   */
  @IsOptional()
  @IsString()
  RESEND_API_KEY?: string;

  /** Must be a domain verified with Resend once RESEND_API_KEY is set — unused while it isn't. */
  @IsOptional()
  @IsString()
  EMAIL_FROM: string = 'rab <onboarding@resend.dev>';

  /** Base URL for links embedded in emails (password setup / reset). */
  @IsOptional()
  @IsUrl({ require_tld: false })
  APP_URL: string = 'http://localhost:5173';
}
