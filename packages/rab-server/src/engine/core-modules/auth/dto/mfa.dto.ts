import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Wave 4 lane MFA DTOs. `forbidNonWhitelisted` (main.ts) turns any extra field — a userId, organisationId, secret,
 * step or "enabled" flag — into a 400: the client names the action, never the resulting state, and never supplies the
 * secret (always generated server-side).
 */

/** A pending sign-in's challenge token (from the 409 SECOND_FACTOR_REQUIRED body). */
export class MfaChallengeDto {
  @IsString()
  @MaxLength(128)
  challengeToken!: string;
}

/** A pending sign-in's challenge token + the six-digit code or a recovery code. */
export class MfaChallengeCodeDto extends MfaChallengeDto {
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  code!: string;
}

/** Start enrolling from settings: the current password (a stolen session alone cannot bind an authenticator). */
export class MfaEnrolmentStartDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  currentPassword!: string;
}

/** Confirm enrolment with the first code from the authenticator. */
export class MfaCodeDto {
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  code!: string;
}

/** Step-up proof: current password AND (when the account has MFA) a current code. */
export class MfaStepUpDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  currentPassword!: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  code?: string;
}
