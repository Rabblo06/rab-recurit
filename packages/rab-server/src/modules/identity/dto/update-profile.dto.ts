import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Email is deliberately absent — no secure in-place email-change flow
 * exists, so it stays read-only from this endpoint (spec: don't build an
 * insecure one just for this page).
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;
}
