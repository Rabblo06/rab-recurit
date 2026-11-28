import { WEEKDAY_NAMES, WeekdayName } from '@rab/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

import { SHIFT_PATTERN_MAX_DAYS, SHIFT_PATTERN_MAX_INTERVAL_WEEKS } from '../utils/shift-pattern-plan';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * `POST /shifts/pattern/preview` and `POST /shifts/pattern`: a recurring pattern, generated server-side into DRAFT
 * shifts that share one server-generated `recurrence_group_id`. No status, pay rate, recurrence id or organisation
 * field exists here (forbidNonWhitelisted → 400). Dates and times are the organisation's wall clock.
 */
export class ShiftPatternDto {
  @IsUUID()
  venueId!: string;

  @IsUUID()
  jobRoleId!: string;

  @Matches(DAY, { message: 'startDate must be a date (YYYY-MM-DD).' })
  startDate!: string;

  @Matches(DAY, { message: 'endDate must be a date (YYYY-MM-DD).' })
  endDate!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsIn(WEEKDAY_NAMES, { each: true })
  weekdays!: WeekdayName[];

  @Matches(TIME, { message: 'startTime must be HH:MM (24-hour).' })
  startTime!: string;

  /** At or before `startTime` = the shift ends the next day. */
  @Matches(TIME, { message: 'endTime must be HH:MM (24-hour).' })
  endTime!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SHIFT_PATTERN_MAX_INTERVAL_WEEKS)
  intervalWeeks?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  breakMinutes?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  requiredCount!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  chargeRatePence?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /** Confirm only: the occurrence dates (preview row keys) to create; any other occurrence is reported `not_selected`. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SHIFT_PATTERN_MAX_DAYS)
  @Matches(DAY, { each: true })
  dates?: string[];
}
