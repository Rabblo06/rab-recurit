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
import { MobileApplication } from '../../../engine/core-modules/auth/guards/mobile-application.decorator';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { RequestTimeOffDto } from '../dto/staff-time-off.dto';
import { StaffTimeOffService } from '../services/staff-time-off.service';

/**
 * Staff self-service time off (owner decision 42: staff REQUEST, a manager APPROVES). Staff app only
 * (@MobileApplication('staff_app'), like the attendance and offer self-service routes) behind offer.respond, the staff-only
 * flag; the service re-checks it and resolves the caller's OWN staff profile from the session, never from the request.
 */
@Controller('rest/v1/me/time-off')
@UseGuards(JwtAuthGuard, RequireWorkspaceGuard)
export class MyTimeOffController {
  constructor(private readonly timeOff: StaffTimeOffService) {}

  @MobileApplication('staff_app')
  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_RESPOND))
  list(@AuthUser() ctx: AuthContext, @Query() page: PaginationDto) {
    return this.timeOff.listMine(ctx, page);
  }

  @MobileApplication('staff_app')
  @Post()
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_RESPOND))
  request(@AuthUser() ctx: AuthContext, @Body() dto: RequestTimeOffDto) {
    return this.timeOff.request(ctx, dto);
  }

  @MobileApplication('staff_app')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_RESPOND))
  cancel(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.timeOff.cancelMine(ctx, id);
  }
}
