import { IsISO8601, IsNumber, IsOptional, Matches, Max, Min } from 'class-validator';

import { ISO_WITH_OFFSET } from './attendance-location.dto';

/**
 * No QR (this is an automatic system action triggered by the device leaving
 * the venue, not a manual re-scan — identity still comes from the JWT).
 * `lat`/`lng` are required (unlike `AttendanceLocationDto`'s optional
 * fields, which this deliberately does NOT extend — a required/optional
 * override across a class-validator subclass trips up
 * `useDefineForClassFields` field semantics, so a small, standalone
 * duplicate of the three fields is the more robust choice here) — a
 * geofence-exit report with no location is meaningless, since the server
 * must independently re-verify the device is genuinely outside the venue
 * before ever acting on it (see `AttendanceService.autoClockOutOnGeofenceExit`
 * — never trusts the client's bare claim "I left").
 */
export class GeofenceExitDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracyM?: number;

  /** Device capture time of the fix (see `AttendanceLocationDto.capturedAt`); required for bookings that need Check In. */
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(ISO_WITH_OFFSET, { message: 'capturedAt must include a timezone offset.' })
  capturedAt?: string;
}
