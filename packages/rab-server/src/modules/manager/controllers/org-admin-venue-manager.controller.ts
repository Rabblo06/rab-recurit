import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CreateAdminVenueManagerDto } from '../dto/create-admin-venue-manager.dto';
import { VenueManagerService } from '../services/venue-manager.service';

/**
 * CEO/admin flow: a Venue Manager for an EXPLICITLY chosen workspace. A separate route from the normal Manager endpoint on
 * purpose, so that endpoint never accepts a target workspace. No RequireWorkspaceGuard: a workspace-less CEO is the point.
 */
@ManagerApplication()
@Controller('rest/v1/org-admin/venue-managers')
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.MANAGER_MANAGE))
export class OrgAdminVenueManagerController {
  constructor(private readonly venueManagers: VenueManagerService) {}

  @Post()
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateAdminVenueManagerDto) {
    return this.venueManagers.createForWorkspace(ctx, dto);
  }
}
