import { IsISO8601, IsNumber, IsOptional, Matches, Max, Min } from 'class-validator';

/** An instant, never a wall-clock time: the offset (or Z) is mandatory. */
export const ISO_WITH_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

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

  /**
   * When the device captured this fix (ISO-8601 with offset). Required with the fix at a geofence-enforcing venue for
   * bookings that need Check In: the server refuses fixes older than LOCATION_EVIDENCE_MAX_AGE_SECONDS, stamped in its
   * future, or not newer than the previous step's fix (replay) — LOCATION_STALE. Never used as an attendance time.
   */
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(ISO_WITH_OFFSET, { message: 'capturedAt must include a timezone offset.' })
  capturedAt?: string;
}
