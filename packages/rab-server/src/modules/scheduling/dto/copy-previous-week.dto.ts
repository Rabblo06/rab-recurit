import { ArrayMaxSize, IsArray, IsISO8601, IsOptional, IsUUID, Matches } from 'class-validator';

import { DRAFT_BATCH_MAX_ROWS } from '../utils/draft-batch-plan';

/**
 * `POST /shifts/copy-previous-week/preview` and `POST /shifts/copy-previous-week`. The week is named by its first day
 * (organisation-local date); the source is the 7 days before it. No status, pay, assignment or organisation field
 * exists here: `forbidNonWhitelisted` turns any such field into a 400.
 */
export class CopyPreviousWeekDto {
  /** First day of the TARGET week, `YYYY-MM-DD` in the organisation's timezone. */
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'weekStart must be a date (YYYY-MM-DD).' })
  weekStart!: string;

  /** Copy one venue only (it must be one the caller may schedule at: 404 otherwise). Omitted = every venue in scope. */
  @IsOptional()
  @IsUUID()
  venueId?: string;

  /** Confirm only: the source shifts (preview row keys) to copy; any other source row is reported `not_selected`. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DRAFT_BATCH_MAX_ROWS)
  @IsUUID('all', { each: true })
  sourceShiftIds?: string[];
}
