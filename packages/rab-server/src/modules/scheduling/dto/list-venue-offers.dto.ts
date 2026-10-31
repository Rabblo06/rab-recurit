import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { KeysetPaginationDto } from '../../../engine/dto/pagination.dto';

/**
 * `status` is a small, closed set of *view* filters, not raw `ShiftStatus`
 * values passed through — "approved" spans several real statuses (open,
 * offered, partially_filled, ...), so this can never be a plain `@IsIn
 * (Object.values(ShiftStatus))` the way `ListShiftsDto.status` is. See
 * `SchedulingService.listVenueOffers`'s own mapping.
 */
export const VENUE_OFFER_VIEW_STATUSES = ['pending', 'approved', 'declined'] as const;

/** Offset (`page`) or keyset (`cursor`, Phase C1) paging; see `SchedulingService`. */
export class ListVenueOffersDto extends KeysetPaginationDto {
  @IsOptional()
  @IsIn(VENUE_OFFER_VIEW_STATUSES)
  status?: (typeof VENUE_OFFER_VIEW_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
