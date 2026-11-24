import { PermissionFlag } from '@rab/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import {
  CreateStaffTimeOffDto,
  DeclineTimeOffDto,
  ListTimeOffDto,
} from '../dto/staff-time-off.dto';
import { StaffTimeOffService } from '../services/staff-time-off.service';

/**
 * Manager side of staff time off (owner decisions 42, 48). Transport only: every rule, including the same permission flag
 * again, lives in StaffTimeOffService. Read: staff.view. Decide / enter: staff.edit. Web console only (no
 * @MobileApplication, so a mobile-app credential is refused here). Mutations are named actions; no route accepts a status.
 */
@Controller('rest/v1')
@UseGuards(JwtAuthGuard, RequireWorkspaceGuard)
export class StaffTimeOffController {
  constructor(private readonly timeOff: StaffTimeOffService) {}

  @Get('time-off')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  list(@AuthUser() ctx: AuthContext, @Query() dto: ListTimeOffDto) {
    return this.timeOff.listWorkspace(ctx, dto);
  }

  @Get('staff/:staffProfileId/time-off')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  listForStaff(
    @AuthUser() ctx: AuthContext,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Query() page: PaginationDto,
  ) {
    return this.timeOff.listForStaff(ctx, staffProfileId, page);
  }

  @Post('staff/:staffProfileId/time-off')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_EDIT))
  enter(
    @AuthUser() ctx: AuthContext,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Body() dto: CreateStaffTimeOffDto,
  ) {
    return this.timeOff.enter(ctx, staffProfileId, dto);
  }

  @Post('time-off/:id/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_EDIT))
  approve(
    @AuthUser() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.timeOff.approve(ctx, id);
  }

  @Post('time-off/:id/decline')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_EDIT))
  decline(
    @AuthUser() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeclineTimeOffDto,
  ) {
    return this.timeOff.decline(ctx, id, dto);
  }

  @Post('time-off/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_EDIT))
  cancel(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.timeOff.cancel(ctx, id);
  }
}
