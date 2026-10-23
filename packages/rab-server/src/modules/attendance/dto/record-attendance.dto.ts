import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

/** An instant, never a wall-clock time: the offset (or Z) is mandatory so the server never guesses a timezone. */
const WITH_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/**
 * Why a manager is entering or completing attendance (owner list 2026-10-21). Stored as readable text in
 * `attendance_correction.reason` and as the code in the audit metadata. `other` requires an explanation.
 */
export const ATTENDANCE_RECORD_REASONS = {
  forgot_clock_in: 'Staff forgot to clock in',
  forgot_clock_out: 'Staff forgot to clock out',
  app_issue: 'Mobile application issue',
  venue_issue: 'Venue operational issue',
  other: 'Other',
} as const;
export type AttendanceRecordReason = keyof typeof ATTENDANCE_RECORD_REASONS;

/**
 * Venue Manager "Record attendance" (manager-entered / manager-completed attendance for one seat). Every time is an
 * absolute ISO-8601 instant with an offset (overnight and Europe/London DST are then plain instant arithmetic). Fields
 * left out keep what is stored; when no attendance exists yet both times are required. `expectedVersion` is the
 * `attendanceVersion` the client last read (absent/null = "I saw no attendance"), used to refuse a lost update (409).
 * No `status`, `organisationId`, ids or provenance are accepted — they come from the route and the session.
 */
export class RecordAttendanceDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(WITH_OFFSET, { message: 'clockInAt must include a timezone offset.' })
  clockInAt?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(WITH_OFFSET, { message: 'clockOutAt must include a timezone offset.' })
  clockOutAt?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  breakMinutes?: number;

  @IsIn(Object.keys(ATTENDANCE_RECORD_REASONS))
  reasonCode!: AttendanceRecordReason;

  /** Required (≥ 10 characters) when `reasonCode` is `other`; optional context otherwise. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reasonNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  expectedVersion?: string | null;
}

/** Reopening a confirmed no-show is a deliberate, audited act: the reason is required. */
export class ReopenNoShowDto {
  @IsString()
  @Length(10, 500)
  reason!: string;
}
