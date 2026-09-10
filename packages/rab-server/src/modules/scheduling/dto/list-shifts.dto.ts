import { ShiftStatus } from '@rab/shared';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';

export const SHIFT_SORT_FIELDS = ['startsAt', 'venue', 'jobRole', 'status', 'createdAt'] as const;

export class ListShiftsDto extends PaginationDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(ShiftStatus))
  status?: string;

  @IsOptional()
  @IsUUID()
  venueId?: string;

  @IsOptional()
  @IsUUID()
  jobRoleId?: string;

  @IsOptional()
  @IsIn(SHIFT_SORT_FIELDS)
  sort?: (typeof SHIFT_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';
}
