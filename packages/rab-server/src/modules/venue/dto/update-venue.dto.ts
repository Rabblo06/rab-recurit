import { VenueType, VenueTypeType } from '@rab/shared';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class UpdateVenueDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  clientName?: string;

  @IsOptional()
  @IsEnum(VenueType)
  type?: VenueTypeType;

  @IsOptional()
  @IsObject()
  address?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  contact?: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(50)
  geofenceRadiusM?: number;

  @IsOptional()
  @IsBoolean()
  enforceGeofence?: boolean;

  @IsOptional()
  @IsString()
  instructions?: string;

  @IsOptional()
  @IsString()
  uniform?: string;

  @IsOptional()
  @IsString()
  checkInInstructions?: string;

  @IsOptional()
  @IsString()
  parking?: string;

  @IsOptional()
  @IsString()
  accessNotes?: string;

  @IsOptional()
  @IsBoolean()
  breakPaid?: boolean;
}
