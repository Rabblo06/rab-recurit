import { OfferStatus } from '@rab/shared';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';

export const OFFER_SORT_FIELDS = ['sentAt', 'shiftDate', 'staff', 'venue', 'status'] as const;

export class ListOffersDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(OfferStatus))
  status?: string;

  @IsOptional()
  @IsUUID()
  staffProfileId?: string;

  @IsOptional()
  @IsUUID()
  venueId?: string;

  @IsOptional()
  @IsUUID()
  jobRoleId?: string;

  @IsOptional()
  @IsDateString()
  shiftDateFrom?: string;

  @IsOptional()
  @IsDateString()
  shiftDateTo?: string;

  @IsOptional()
  @IsDateString()
  sentAtFrom?: string;

  @IsOptional()
  @IsDateString()
  sentAtTo?: string;

  @IsOptional()
  @IsIn(OFFER_SORT_FIELDS)
  sort?: (typeof OFFER_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';
}
