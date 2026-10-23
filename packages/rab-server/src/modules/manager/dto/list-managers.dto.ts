import { ManagerType, UserStatus } from '@rab/shared';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { IncludeArchivedQuery } from '../../../engine/dto/include-archived.decorator';

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

  /**
   * P2.9 gap review, item 2 — narrows to the organisation's CURRENT Initial Manager only
   * (`is_initial_manager = true AND superseded_at IS NULL` — see `ManagerService.list()`).
   * Omitted entirely for the ordinary Users-table Managers view, so every additional Internal
   * Manager stays visible there exactly as before; only `CeoRoute`'s Settings → Team page and the
   * Super Admin organisation detail pass this.
   */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isInitialManager?: boolean;

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

  /** Wave 5: archived rows are excluded unless `includeArchived=true` ("Show archived"). */
  @IncludeArchivedQuery()
  includeArchived?: boolean;
}
