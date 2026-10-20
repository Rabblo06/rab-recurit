import { Type } from 'class-transformer';
import { Equals, IsBoolean, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

/** Five required 1-5 ratings — no defaults are ever invented server-side — plus optional feedback. */
export class SaveStaffReviewDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(5) grooming!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(5) attitude!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(5) skills!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(5) attendance!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(5) timeKeeping!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  feedback?: string;
}

/**
 * Optional for backward compatibility (an older client finalises with no body). When sent, both are required together
 * and the break confirmation must be `true`; the signer and time are always the server's `finalised_by` / `finalised_at`.
 */
export class FinaliseReportDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  signedOffName?: string;

  @IsOptional()
  @IsBoolean()
  @Equals(true)
  breakConfirmed?: boolean;
}
