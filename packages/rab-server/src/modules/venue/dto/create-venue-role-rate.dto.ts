import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsNumber, IsOptional, IsUUID, Min } from 'class-validator';

export class CreateVenueRoleRateDto {
  @IsUUID()
  jobRoleId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  payRatePence!: number;

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
