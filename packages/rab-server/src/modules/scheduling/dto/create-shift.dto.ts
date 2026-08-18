import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateShiftDto {
  @IsUUID()
  venueId!: string;

  @IsUUID()
  jobRoleId!: string;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  breakMinutes?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  requiredCount!: number;

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
  @IsString()
  notes?: string;
}
