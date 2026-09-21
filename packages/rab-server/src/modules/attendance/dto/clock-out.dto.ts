import { IsNotEmpty, IsString } from 'class-validator';

import { AttendanceLocationDto } from './attendance-location.dto';

/** No `shiftId` — clock-out always resolves the caller's own open `Attendance` row server-side, never a client-supplied id (see `AttendanceService.clockOut`). */
export class ClockOutDto extends AttendanceLocationDto {
  /** The same Shift QR used at clock-in (Part 31: one QR, both actions). */
  @IsString()
  @IsNotEmpty()
  qrToken!: string;
}
