import { VenueStatus, VenueType } from '@rab/shared';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { IncludeArchivedQuery } from '../../../engine/dto/include-archived.decorator';

export const VENUE_SORT_FIELDS = ['name', 'createdAt'] as const;

export class ListVenuesDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(VenueStatus))
  status?: string;

  @IsOptional()
  @IsIn(Object.values(VenueType))
  type?: string;

  @IsOptional()
  @IsIn(VENUE_SORT_FIELDS)
  sort?: (typeof VENUE_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';

  /** Wave 5: archived rows are excluded unless `includeArchived=true` ("Show archived"). */
  @IncludeArchivedQuery()
  includeArchived?: boolean;
}
