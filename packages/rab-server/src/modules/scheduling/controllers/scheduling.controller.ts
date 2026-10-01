import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CancelShiftDto } from '../dto/cancel-shift.dto';
import { CreateJobRoleDto } from '../dto/create-job-role.dto';
import { CreateShiftDto } from '../dto/create-shift.dto';
import { DeclineShiftRequestDto } from '../dto/decline-shift-request.dto';
import { ListSelectableStaffDto } from '../dto/list-selectable-staff.dto';
import { ListShiftsDto } from '../dto/list-shifts.dto';
import { ListVenueOffersDto } from '../dto/list-venue-offers.dto';
import { SubmitShiftRequestDto } from '../dto/submit-shift-request.dto';
import { SetRequestedStaffDto } from '../dto/set-requested-staff.dto';
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
  listPendingApprovals(@AuthUser() ctx: AuthContext, @Query() dto: PaginationDto) {
    return this.schedulingService.listPendingApprovals(ctx, dto);
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

  @Get('shifts/sent')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  listSentShifts(@AuthUser() ctx: AuthContext, @Query() dto: PaginationDto) {
    return this.schedulingService.listSentShifts(ctx, dto);
  }

  @Get('shifts/sent/:id')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  async getSentShift(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    const result = await this.schedulingService.listSentShifts(ctx, {}, id);
    return result.data[0];
  }

  @Get('shifts/:id')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  get(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.schedulingService.get(ctx, id);
  }

  // The Venue Manager's staff selection at request time — read by the Shift
  // Approval drawer. Same permission as `get()`: whoever can view the shift
  // can see who was requested for it.
  @Get('shifts/:id/selectable-staff')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW), PermissionGuard(PermissionFlag.STAFFING_REQUEST_APPROVE), RequireWorkspaceGuard)
  listSelectableStaff(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Query() dto: ListSelectableStaffDto) {
    return this.schedulingService.listSelectableStaff(ctx, id, dto);
  }

  @Get('shifts/:id/requested-staff')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  getRequestedStaff(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.schedulingService.getRequestedStaff(ctx, id);
  }

  // Editing a still-pending request's recipient list, before any offer
  // exists — same permission as approve/decline: this is part of the
  // Internal Manager's review authority over the request, not a general
  // scheduling action.
  @Put('shifts/:id/requested-staff')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.STAFFING_REQUEST_APPROVE), RequireWorkspaceGuard)
  setRequestedStaff(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: SetRequestedStaffDto) {
    return this.schedulingService.setRequestedStaff(ctx, id, dto);
  }

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
