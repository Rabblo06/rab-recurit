import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Shared by `ClockInDto`/`ClockOutDto`/`GeofenceExitDto` — one field shape,
 * not three drifted copies. All three are optional at the DTO level (a venue
 * with `enforceGeofence = false` never requires them); `AttendanceService`'s
 * own geofence check is what actually requires them when the venue demands
 * it, returning a structured `LocationRequiredException` rather than a DTO
 * validation 400 — that keeps "location needed" a per-venue business rule,
 * not a blanket API contract. `class-validator`'s `@IsNumber()` already
 * rejects `NaN`/non-finite values (it uses `Number.isFinite` internally), so
 * no separate Infinity guard is needed here.
 */
export class AttendanceLocationDto {
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracyM?: number;
}
