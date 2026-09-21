import { VenueType, VenueTypeType } from '@rab/shared';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min, MinLength, ValidateIf } from 'class-validator';

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

  /**
   * Venue location — set only by roles holding `venue.create`/`venue.edit`
   * (Internal Manager / CEO), never by Venue Manager, Staff or the mobile
   * client. `null` clears it (allowed only while enforcement is off — see
   * `VenueService.assertGeofenceConfig`). No `@Type(() => Number)`: a string
   * like "NaN"/"Infinity" must fail `@IsNumber`, not be coerced.
   */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat?: number | null;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng?: number | null;

  /** `ValidateIf` instead of `IsOptional`: an explicit `null` must FAIL here (the column is NOT NULL); only an omitted field skips validation. */
  @ValidateIf((o: { geofenceRadiusM?: unknown }) => o.geofenceRadiusM !== undefined)
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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  defaultBreakMinutes?: number;
}
