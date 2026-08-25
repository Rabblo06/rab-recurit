import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@rab/shared';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsEmail, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * `organisationId` is deliberately absent — it comes from the verified
 * session, never the client (CLAUDE.md). `forbidNonWhitelisted` (main.ts)
 * turns a body that includes it into a 400, not a silent override.
 */
export class CreateStaffDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsString()
  @MinLength(1)
  staffRef!: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  defaultPayRatePence?: number;

  /**
   * Admin-supplied temp password from the "Temporary password" field's
   * Generate/edit control. Optional — if omitted the server generates one.
   * Re-validated server-side via `checkPasswordStrength` regardless of
   * origin; client-side validation is never trusted alone.
   */
  @IsOptional()
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  temporaryPassword?: string;
}
