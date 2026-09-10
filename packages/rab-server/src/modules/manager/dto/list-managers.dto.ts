import { ManagerType, UserStatus } from '@rab/shared';
import { IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';

export const MANAGER_SORT_FIELDS = ['name', 'email', 'accountStatus', 'jobTitle', 'createdAt'] as const;

export class ListManagersDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(UserStatus))
  status?: string;

  @IsOptional()
  @IsIn(Object.values(ManagerType))
  type?: string;

  @IsOptional()
  @IsDateString()
  createdAtFrom?: string;

  @IsOptional()
  @IsDateString()
  createdAtTo?: string;

  @IsOptional()
  @IsIn(MANAGER_SORT_FIELDS)
  sort?: (typeof MANAGER_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';
}
