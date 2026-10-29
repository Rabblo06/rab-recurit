import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';

import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { AssignVenueTeamStaffDto } from '../dto/assign-venue-team-staff.dto';
import { ListVenueTeamCandidatesDto } from '../dto/list-venue-team-candidates.dto';
import { VenueManagerService } from '../services/venue-manager.service';

/**
 * Assigned Staff of any Venue Manager in the caller's own organisation, for organisation administrators (effective
 * `manager.manage`: the CEO by default; a platform admin only in their own organisation). A separate route from the
 * workspace owner's `/venue-managers/:id/staff` on purpose, so the owner endpoint never accepts another workspace; both
 * call the same VenueManagerService implementation. No RequireWorkspaceGuard: the workspace is derived on the server from
 * the Venue Manager record. Admin Inspect stays read-only (JwtAuthGuard refuses every mutation under an inspect header).
 */
@ManagerApplication()
@Controller('rest/v1/org-admin/venue-managers')
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.MANAGER_MANAGE))
export class OrgAdminVenueTeamController {
  constructor(private readonly venueManagers: VenueManagerService) {}

  @Get(':id/staff')
  listTeam(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueManagers.listTeamAsOrgAdmin(ctx, id);
  }

  /** The Venue Manager's workspace Staff that can be assigned (the "Select Staff" list). */
  @Get(':id/assignable-staff')
  listAssignableStaff(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() dto: ListVenueTeamCandidatesDto) {
    return this.venueManagers.listAssignableStaffAsOrgAdmin(ctx, id, dto);
  }

  @Post(':id/staff')
  assignTeamStaff(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignVenueTeamStaffDto) {
    return this.venueManagers.assignTeamStaffAsOrgAdmin(ctx, id, dto);
  }

  @Delete(':id/staff/:staffId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeTeamStaff(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.venueManagers.removeTeamStaffAsOrgAdmin(ctx, id, staffId);
  }
}
