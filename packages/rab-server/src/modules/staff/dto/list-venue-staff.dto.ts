import { IsDateString, IsOptional, IsUUID } from 'class-validator';

import { ListStaffDto } from './list-staff.dto';

/**
 * `venueDirectory`/`venueStaffPool` only — when a Venue Manager (or the
 * Internal Manager reviewing a Venue Offer) is picking staff for a
 * specific shift window, passing `startAt`/`endAt` here makes the response
 * include a real, backend-derived `available` flag per row (see
 * `AvailabilityService`), computed in the same bulk query as the rest of
 * the list rather than one round trip per row. Omitting them just returns
 * the directory/pool with no `available` field, matching today's shape —
 * this is an additive, optional extension, not a breaking change to the
 * existing endpoints.
 */
export class ListVenueStaffDto extends ListStaffDto {
  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  /** Editing an already-published shift: exclude that shift's own existing assignment from the busy calculation. */
  @IsOptional()
  @IsUUID()
  excludeShiftId?: string;
}
