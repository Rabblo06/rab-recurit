import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { STAFF_ROLE_RATE_MAX_PENCE } from '../../../database/typeorm/core/staff-role-rate-sql';

/** A calendar date, exactly `YYYY-MM-DD` (the column is a `date`; no time or zone is accepted). */
export const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `POST /rest/v1/staff/:staffProfileId/role-rates`. The staff member comes from the URL and is re-checked in the service;
 * `organisationId`, `workspaceId`, `createdBy` and `staffProfileId` are NOT fields here, so a body carrying any of them is a
 * 400 (global `forbidNonWhitelisted`), never a hint. Money is whole pence.
 */
export class CreateStaffRoleRateDto {
  @IsUUID()
  jobRoleId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1) // owner decision 39: never a £0 rate
  @Max(STAFF_ROLE_RATE_MAX_PENCE)
  payRatePence!: number;

  @IsISO8601({ strict: true })
  @Matches(CALENDAR_DATE, {
    message: 'effectiveFrom must be a date (YYYY-MM-DD)',
  })
  effectiveFrom!: string;

  /** Omitted or null = open-ended. Inclusive, like the venue rate. */
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(CALENDAR_DATE, {
    message: 'effectiveTo must be a date (YYYY-MM-DD)',
  })
  effectiveTo?: string | null;
}
