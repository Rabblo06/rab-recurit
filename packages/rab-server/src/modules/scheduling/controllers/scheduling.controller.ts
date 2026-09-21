import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CancelShiftDto } from '../dto/cancel-shift.dto';
import { CreateJobRoleDto } from '../dto/create-job-role.dto';
import { CreateShiftDto } from '../dto/create-shift.dto';
import { DeclineShiftRequestDto } from '../dto/decline-shift-request.dto';
import { ListShiftsDto } from '../dto/list-shifts.dto';
import { ListVenueOffersDto } from '../dto/list-venue-offers.dto';
import { SubmitShiftRequestDto } from '../dto/submit-shift-request.dto';
import { SchedulingService } from '../services/scheduling.service';

@Controller('rest/v1')
@UseGuards(JwtAuthGuard)
export class SchedulingController {
  constructor(private readonly schedulingService: SchedulingService) {}

  @Get('job-roles')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  listJobRoles(@AuthUser() ctx: AuthContext) {
    return this.schedulingService.listJobRoles(ctx);
  }

  @Post('job-roles')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_CREATE), RequireWorkspaceGuard)
  createJobRole(@AuthUser() ctx: AuthContext, @Body() dto: CreateJobRoleDto) {
    return this.schedulingService.createJobRole(ctx, dto);
  }

  @Get('shifts')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  list(@AuthUser() ctx: AuthContext, @Query() dto: ListShiftsDto) {
    return this.schedulingService.list(ctx, dto);
  }

  // Must be declared before `shifts/:id` below — Nest/Express route
  // matching is order-sensitive, and a static path always has to come
  // before a `:id` wildcard that would otherwise swallow it (treating
  // "requests" as the id).
  @Get('shifts/requests/pending')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.STAFFING_REQUEST_APPROVE))
  listPendingApprovals(@AuthUser() ctx: AuthContext) {
    return this.schedulingService.listPendingApprovals(ctx);
  }

  // "Venue Offers" — the Internal Manager's dedicated review queue across
  // every stage (pending/approved/declined), not just still-pending. Also
  // declared before `shifts/:id` for the same route-order reason as above.
  @Get('shifts/requests')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.STAFFING_REQUEST_APPROVE))
  listVenueOffers(@AuthUser() ctx: AuthContext, @Query() dto: ListVenueOffersDto) {
    return this.schedulingService.listVenueOffers(ctx, dto);
  }

  @Post('shifts/request')
  @UseGuards(PermissionGuard(PermissionFlag.STAFFING_REQUEST_CREATE), RequireWorkspaceGuard)
  submitRequest(@AuthUser() ctx: AuthContext, @Body() dto: SubmitShiftRequestDto) {
    return this.schedulingService.submitRequest(ctx, dto);
  }

  @Get('shifts/:id')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  get(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.schedulingService.get(ctx, id);
  }

  // The Venue Manager's staff selection at request time — read by the Shift
  // Approval drawer. Same permission as `get()`: whoever can view the shift
  // can see who was requested for it.
  @Get('shifts/:id/requested-staff')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  getRequestedStaff(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.schedulingService.getRequestedStaff(ctx, id);
  }

  // Editing a still-pending request's recipient list, before any offer
  // exists — same permission as approve/decline: this is part of the
  // Internal Manager's review authority over the request, not a general
  // scheduling action.
  @Post('shifts/:id/requested-staff/:staffProfileId')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.STAFFING_REQUEST_APPROVE))
  addRequestedStaff(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Param('staffProfileId') staffProfileId: string) {
    return this.schedulingService.addRequestedStaff(ctx, id, staffProfileId);
  }

  @Delete('shifts/:id/requested-staff/:staffProfileId')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.STAFFING_REQUEST_APPROVE))
  removeRequestedStaff(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Param('staffProfileId') staffProfileId: string) {
    return this.schedulingService.removeRequestedStaff(ctx, id, staffProfileId);
  }

  @Post('shifts')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_CREATE))
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateShiftDto) {
    return this.schedulingService.create(ctx, dto);
  }

  @Post('shifts/:id/publish')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_PUBLISH))
  publish(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.schedulingService.publish(ctx, id);
  }

  @Post('shifts/:id/cancel')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_CREATE))
  cancel(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: CancelShiftDto) {
    return this.schedulingService.cancel(ctx, id, dto.reason);
  }

  @Post('shifts/:id/decline')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.STAFFING_REQUEST_APPROVE))
  declineRequest(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: DeclineShiftRequestDto) {
    return this.schedulingService.declineRequest(ctx, id, dto);
  }
}
