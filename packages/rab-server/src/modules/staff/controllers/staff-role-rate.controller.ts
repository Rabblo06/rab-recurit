import { PermissionFlag } from '@rab/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CreateStaffRoleRateDto } from '../dto/create-staff-role-rate.dto';
import { UpdateStaffRoleRateDto } from '../dto/update-staff-role-rate.dto';
import { StaffRoleRateService } from '../services/staff-role-rate.service';

/**
 * A staff member's own pay rates per job role (Lane C; architecture §1 A6). Transport only: every rule, including the
 * same permission flags again, lives in StaffRoleRateService. Read: payroll.view (pay amounts, like the staff profile's
 * "Default pay rate"). Write: staff.edit AND payroll.view. ASSUMPTION (flagged in the PR): no new permission flag.
 */
@Controller('rest/v1/staff/:staffProfileId/role-rates')
@UseGuards(JwtAuthGuard, RequireWorkspaceGuard)
export class StaffRoleRateController {
  constructor(private readonly rates: StaffRoleRateService) {}

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_VIEW))
  list(
    @AuthUser() ctx: AuthContext,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
  ) {
    return this.rates.list(ctx, staffProfileId);
  }

  @Post()
  @UseGuards(
    PermissionGuard(PermissionFlag.STAFF_EDIT),
    PermissionGuard(PermissionFlag.PAYROLL_VIEW),
  )
  create(
    @AuthUser() ctx: AuthContext,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Body() dto: CreateStaffRoleRateDto,
  ) {
    return this.rates.create(ctx, staffProfileId, dto);
  }

  @Patch(':id')
  @UseGuards(
    PermissionGuard(PermissionFlag.STAFF_EDIT),
    PermissionGuard(PermissionFlag.PAYROLL_VIEW),
  )
  update(
    @AuthUser() ctx: AuthContext,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffRoleRateDto,
  ) {
    return this.rates.update(ctx, staffProfileId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(
    PermissionGuard(PermissionFlag.STAFF_EDIT),
    PermissionGuard(PermissionFlag.PAYROLL_VIEW),
  )
  remove(
    @AuthUser() ctx: AuthContext,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rates.remove(ctx, staffProfileId, id);
  }
}
