import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { AttendanceLocationDto } from './attendance-location.dto';

/**
 * Staff Check In (arrival evidence). No staff id, organisation, workspace, time or status is accepted: the booking is
 * resolved from the verified session + `shiftId`, the time is the server's. `qrToken` is optional — when present it must
 * be this shift's valid signed QR and the check-in is recorded with source 'qr'. Location fields as for Clock In.
 */
export class CheckInDto extends AttendanceLocationDto {
  @IsUUID()
  shiftId!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  qrToken?: string;
}

/** Venue Manager live clock-in / clock-out on behalf of a staff member. At least 10 words (checked by the service). */
export class OnBehalfPunchDto {
  @IsString()
  @MaxLength(1000)
  reason!: string;
}
