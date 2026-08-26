import { IsUUID } from 'class-validator';

export class AssignVenueDto {
  @IsUUID()
  venueId!: string;
}
