import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/** Staff (of the caller's own workspace) to add to one Venue Manager's team. Never a tenancy or account field. */
export class AssignVenueTeamStaffDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  staffProfileIds!: string[];
}
