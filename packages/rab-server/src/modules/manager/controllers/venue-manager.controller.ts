import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CreateVenueManagerDto } from '../dto/create-venue-manager.dto';
import { VenueManagerService } from '../services/venue-manager.service';

/** Normal Manager flow: a Venue Manager inside the caller's own workspace. See VenueManagerService. */
@ManagerApplication()
@Controller('rest/v1/venue-managers')
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.VENUE_MANAGER_CREATE), RequireWorkspaceGuard)
export class VenueManagerController {
  constructor(private readonly venueManagers: VenueManagerService) {}

  @Post()
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateVenueManagerDto) {
    return this.venueManagers.createInOwnWorkspace(ctx, dto);
  }
}
