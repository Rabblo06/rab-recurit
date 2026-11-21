import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { STAFF_ROLE_RATE_MAX_PENCE } from '../../../database/typeorm/core/staff-role-rate-sql';
import { CALENDAR_DATE } from './create-staff-role-rate.dto';

/**
 * `PATCH /rest/v1/staff/:staffProfileId/role-rates/:id`. Only the amount and the period can change; the staff member, the
 * job role and the author never do (no field here, no column grant in the database). `effectiveTo: null` re-opens the period.
 */
export class UpdateStaffRoleRateDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(STAFF_ROLE_RATE_MAX_PENCE)
  payRatePence?: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(CALENDAR_DATE, {
    message: 'effectiveFrom must be a date (YYYY-MM-DD)',
  })
  effectiveFrom?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(CALENDAR_DATE, {
    message: 'effectiveTo must be a date (YYYY-MM-DD)',
  })
  effectiveTo?: string | null;
}
