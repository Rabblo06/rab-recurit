import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

import { AttendanceLocationDto } from './attendance-location.dto';

export class ClockInDto extends AttendanceLocationDto {
  @IsUUID()
  shiftId!: string;

  /** The Shift's one signed QR token (Part 54: a QR alone is never sufficient, but it IS always required) — see `AttendanceQrService.validateQr`. */
  @IsString()
  @IsNotEmpty()
  qrToken!: string;
}
