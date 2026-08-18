import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CreateManagerDto } from '../dto/create-manager.dto';
import { UpdateManagerDto } from '../dto/update-manager.dto';
import { ManagerService } from '../services/manager.service';

@Controller('rest/v1/managers')
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.MANAGER_MANAGE))
export class ManagerController {
  constructor(private readonly managerService: ManagerService) {}

  @Get()
  list(@AuthUser() ctx: AuthContext) {
    return this.managerService.list(ctx);
  }

  @Post()
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateManagerDto) {
    return this.managerService.create(ctx, dto);
  }

  @Patch(':id')
  update(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: UpdateManagerDto) {
    return this.managerService.update(ctx, id, dto);
  }

  @Post(':id/deactivate')
  deactivate(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.setActive(ctx, id, false);
  }

  @Post(':id/reactivate')
  reactivate(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.setActive(ctx, id, true);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  resetPassword(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.resetPassword(ctx, id);
  }
}
