import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CreateRoleDto } from '../dto/create-role.dto';
import { UpdateRoleDto } from '../dto/update-role.dto';
import { RoleService } from '../services/role.service';

@Controller('rest/v1/roles')
@UseGuards(JwtAuthGuard)
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  // Registered before ':id' so it's matched first — a static segment must
  // never be shadowed by the dynamic param route below it.
  @Get('permissions')
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_VIEW))
  listPermissionCatalog(@AuthUser() ctx: AuthContext) {
    return this.roleService.listPermissionCatalog(ctx);
  }

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_VIEW))
  list(@AuthUser() ctx: AuthContext) {
    return this.roleService.list(ctx);
  }

  @Get(':id')
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_VIEW))
  get(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.roleService.get(ctx, id);
  }

  @Post()
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_MANAGE))
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateRoleDto) {
    return this.roleService.create(ctx, dto);
  }

  @Patch(':id')
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_MANAGE))
  update(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.roleService.update(ctx, id, dto);
  }
}
