import { UserStatus } from '@rab/shared';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { MANAGER_SORT_FIELDS } from './list-managers.dto';

/**
 * Normal Manager flow: list the Venue Managers of the caller's OWN workspace. Deliberately has no type, workspace,
 * organisation or initial-manager filter: the type is always `venue` and the workspace always comes from the session.
 */
export class ListVenueManagersDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(UserStatus))
  status?: string;

  @IsOptional()
  @IsIn(MANAGER_SORT_FIELDS)
  sort?: (typeof MANAGER_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';
}
