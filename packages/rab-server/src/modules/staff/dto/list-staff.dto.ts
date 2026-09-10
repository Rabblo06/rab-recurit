import { EmploymentStatus } from '@rab/shared';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';

/**
 * Real, currently-used values only — `EmploymentStatus` is the actual
 * domain enum (`staff-profile.entity.ts`); `EMPLOYMENT_TYPES` matches the
 * exact free-text list `CreateUserModal.tsx`'s own select already offers
 * (not a DB-level enum — `employmentType` is a plain nullable column — so
 * this list is duplicated here deliberately rather than shared from a
 * frontend file, matching how every other cross-boundary constant in this
 * codebase is duplicated at each layer's own DTO, not imported across the
 * frontend/backend boundary).
 */
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Temporary', 'Casual', 'Contract'];

export const STAFF_SORT_FIELDS = ['name', 'staffRef', 'email', 'defaultPayRatePence', 'employmentStatus', 'createdAt'] as const;

export class ListStaffDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(EmploymentStatus))
  status?: string;

  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: string;

  @IsOptional()
  @IsUUID()
  jobRoleId?: string;

  @IsOptional()
  @IsDateString()
  createdAtFrom?: string;

  @IsOptional()
  @IsDateString()
  createdAtTo?: string;

  @IsOptional()
  @IsIn(STAFF_SORT_FIELDS)
  sort?: (typeof STAFF_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';
}
