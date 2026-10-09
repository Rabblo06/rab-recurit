import { IsUUID } from 'class-validator';

import { CreateVenueManagerDto } from './create-venue-manager.dto';

/**
 * CEO/admin flow (MANAGER_MANAGE). The ONLY place a request may name a target workspace. The id is not trusted on arrival:
 * the service verifies it against the core registry for the caller's own organisation before using it.
 */
export class CreateAdminVenueManagerDto extends CreateVenueManagerDto {
  @IsUUID()
  targetWorkspaceId!: string;
}
