import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { AttendanceStatus } from '../constants/attendance-status';

export const ATTENDANCE_SORT_FIELDS = ['clockInAt', 'staff', 'venue', 'workedMinutes', 'earnedPence'] as const;

/**
 * Backs the Payroll page — `Attendance` (workedMinutes/earnedPence,
 * snapshotted once at clock-out, never recalculated later) is the only
 * authoritative worked-hours/earned-pay data in this codebase. There is no
 * "paid"/payment-run concept anywhere in the schema (confirmed — no such
 * column, table, or migration exists), so `status` here is genuinely just
 * `active` (still clocked in) vs `completed` (clocked out, hours/pay
 * computed) — never labelled "Paid", which would claim a fact this data
 * doesn't track.
 */
export class ListAttendanceDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(AttendanceStatus))
  status?: string;

  @IsOptional()
  @IsUUID()
  staffProfileId?: string;

  @IsOptional()
  @IsUUID()
  venueId?: string;

  @IsOptional()
  @IsDateString()
  clockInFrom?: string;

  @IsOptional()
  @IsDateString()
  clockInTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  workedMinutesMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  workedMinutesMax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  earnedPenceMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_00)
  earnedPenceMax?: number;

  @IsOptional()
  @IsIn(ATTENDANCE_SORT_FIELDS)
  sort?: (typeof ATTENDANCE_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';
}
