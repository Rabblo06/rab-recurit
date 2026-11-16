import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export const CORRECTABLE_FIELDS = ['clockInAt', 'clockOutAt', 'breakMinutes'] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

/**
 * `newValue` is always a string on the wire — an ISO-8601 timestamp for
 * `clockInAt`/`clockOutAt`, a stringified non-negative integer for
 * `breakMinutes` — parsed and range-checked in `AttendanceService.correct`
 * itself (which field it is determines how to parse it, so a single
 * `@IsNumberString()`-vs-`@IsISO8601()` decorator pair can't express that
 * conditional validation at the DTO layer alone).
 */
export class CorrectAttendanceDto {
  @IsIn(CORRECTABLE_FIELDS)
  field!: CorrectableField;

  @IsString()
  newValue!: string;

  /** Required, never optional — Part 42/43: no silent overwrites. */
  @IsString()
  @MinLength(10)
  reason!: string;

  /**
   * Owner brief 2026-11-15 (compact attendance correction warning): a corrected `clockInAt` earlier than the staff
   * member's own scheduled start minus CLOCK_IN_EARLY_MINUTES is refused with 409 `CLOCK_IN_CONFIRMATION_REQUIRED`
   * unless this is exactly `true` — sent only after the manager pressed Confirm on the warning. Ignored for any other
   * field and for a clock-in inside the allowance. Declared so `forbidNonWhitelisted` accepts it; a non-boolean is a 400.
   */
  @IsOptional()
  @IsBoolean()
  confirmUnusualClockIn?: boolean;
}
