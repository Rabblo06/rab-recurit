import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

/**
 * Employment status is deliberately absent here — it changes via the named
 * `deactivate`/`reactivate` actions, never a raw field set (CLAUDE.md: no
 * raw status from a client).
 */
export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  staffRef?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  defaultPayRatePence?: number;
}
