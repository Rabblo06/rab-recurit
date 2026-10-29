import { IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';

/**
 * Organisation-administrator "Select Staff" list for one Venue Manager's Assigned Staff. Search text and paging only: the
 * workspace always comes from the Venue Manager record on the server, never from the request.
 */
export class ListVenueTeamCandidatesDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
