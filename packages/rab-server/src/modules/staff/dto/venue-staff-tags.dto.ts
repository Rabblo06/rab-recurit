import { IsBoolean, IsOptional } from 'class-validator';

/** A Venue Manager's own per-team-member tags. At least one field is required (checked in the service). */
export class VenueStaffTagsDto {
  @IsOptional()
  @IsBoolean()
  favourite?: boolean;

  @IsOptional()
  @IsBoolean()
  emergency?: boolean;
}
