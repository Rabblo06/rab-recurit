import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateVenueRoleRateDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  payRatePence?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  chargeRatePence?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  overtimeMultiplier?: number;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;
}
