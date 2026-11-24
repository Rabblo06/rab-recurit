import { STAFF_TIME_OFF_TEXT_MAX } from '@rab/shared';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';

/** A calendar date, exactly `YYYY-MM-DD` (the columns are `date`; no time or zone is accepted). */
export const TIME_OFF_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The date range of a time-off request or a manager-entered range. Both ends inclusive, organisation-local calendar days
 * (owner decision 42). `organisationId`, `workspaceId`, `staffProfileId`, `staffUserId`, `status`, `requestedBy`,
 * `decidedBy` and every other column are NOT fields here, so a body carrying any of them is a 400 (global
 * `forbidNonWhitelisted`), never a hint.
 */
class TimeOffRangeDto {
  @IsISO8601({ strict: true })
  @Matches(TIME_OFF_CALENDAR_DATE, {
    message: 'startsOn must be a date (YYYY-MM-DD)',
  })
  startsOn!: string;

  @IsISO8601({ strict: true })
  @Matches(TIME_OFF_CALENDAR_DATE, {
    message: 'endsOn must be a date (YYYY-MM-DD)',
  })
  endsOn!: string;

  /** Optional free text for the manager. Never written to the audit log. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(STAFF_TIME_OFF_TEXT_MAX)
  note?: string | null;
}

/** `POST /rest/v1/me/time-off` — a staff member's own request (status `requested`, set by the server). */
export class RequestTimeOffDto extends TimeOffRangeDto {}

/** `POST /rest/v1/staff/:staffProfileId/time-off` — manager-entered time off, approved immediately (set by the server). */
export class CreateStaffTimeOffDto extends TimeOffRangeDto {}

/** `POST /rest/v1/time-off/:id/decline`. The reason is shown to the staff member; never written to the audit log. */
export class DeclineTimeOffDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(STAFF_TIME_OFF_TEXT_MAX)
  reason!: string;
}

/** Query filter values of the manager list (a read filter, never a write). */
export const TIME_OFF_LIST_STATUSES = [
  'requested',
  'approved',
  'declined',
  'cancelled',
] as const;

/** `GET /rest/v1/time-off?status=&page=&limit=` (workspace list, newest range first). */
export class ListTimeOffDto extends PaginationDto {
  @IsOptional()
  @IsIn(TIME_OFF_LIST_STATUSES)
  status?: (typeof TIME_OFF_LIST_STATUSES)[number];
}
