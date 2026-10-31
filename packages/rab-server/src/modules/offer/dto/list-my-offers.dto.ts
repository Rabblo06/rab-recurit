import { IsIn, IsOptional } from 'class-validator';

import { KeysetPaginationDto } from '../../../engine/dto/pagination.dto';

/**
 * `GET /offers/mine` window (Phase C1, contract §3). `current` = offers whose shift has not ended plus offers sent in the
 * last 30 days (database clock); `all` = every offer of the caller (the explicit history path). `current` is the default
 * whenever `limit`/`cursor` is sent. A request with none of `limit`, `cursor`, `scope` is the legacy unpaged call (see
 * `LEGACY_UNPAGED_LIMIT`) and has no window at all, exactly as before C1.
 */
export const MY_OFFER_SCOPES = ['current', 'all'] as const;
export type MyOfferScope = (typeof MY_OFFER_SCOPES)[number];

export class ListMyOffersDto extends KeysetPaginationDto {
  @IsOptional()
  @IsIn(MY_OFFER_SCOPES)
  scope?: MyOfferScope;
}
