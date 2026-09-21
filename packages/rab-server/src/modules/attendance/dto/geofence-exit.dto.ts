import { IsNumber, IsOptional, Max, Min } from 'class-validator';

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
}
