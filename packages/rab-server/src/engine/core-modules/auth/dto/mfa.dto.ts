import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Wave 4 lane MFA DTOs. `forbidNonWhitelisted` (main.ts) turns any extra field — a userId, organisationId, secret,
 * step or "enabled" flag — into a 400: the client names the action, never the resulting state, and never supplies the
 * secret (always generated server-side).
 *
 * Account security step 1: `currentPassword` is OPTIONAL on the self-service routes and on step-up. Absent, the service
 * requires a fresh step-up grant of THIS session instead (password step-up, or an SSO re-authentication for an account
 * with no password) — see `StepUpReauthService.assertIdentityProof`. Optional in the DTO never means optional proof.
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

/** Start enrolling from settings: the current password, or a fresh step-up / SSO re-auth grant of this session. */
export class MfaEnrolmentStartDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  currentPassword?: string;
}

/** Confirm enrolment with the first code from the authenticator. */
export class MfaCodeDto {
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  code!: string;
}

/** Step-up proof: current password (or a fresh SSO re-auth grant) AND (when the account has MFA) a current code. */
export class MfaStepUpDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  code?: string;
}

/**
 * Account security step 1 (P4): a platform administrator resets ANOTHER account's second factor. `reason` is required
 * (trimmed, 3–500 characters) and stored in the audit events of both organisations. Proof: `currentPassword` (+ the
 * admin's own `code` only when the admin is enrolled), or none inline and a fresh step-up grant of this session.
 */
export class AdminMfaResetDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  code?: string;
}
