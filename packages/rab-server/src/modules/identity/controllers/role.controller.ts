import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { RoleDefinitionDto } from '../dto/role-definition.dto';
import { RoleService } from '../services/role.service';

@ManagerApplication()
@Controller('rest/v1/roles')
@UseGuards(JwtAuthGuard)
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  // Static segments are registered before ':id' so they're matched first — a static segment must
  // never be shadowed by the dynamic param route below it.
  @Get('permissions')
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_VIEW))
  listPermissionCatalog(@AuthUser() ctx: AuthContext) {
    return this.roleService.listPermissionCatalog(ctx);
  }

  @Get('object-metadata')
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_VIEW))
  objectMetadata(@AuthUser() ctx: AuthContext) {
    return this.roleService.objectMetadata(ctx);
  }

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_VIEW))
  list(@AuthUser() ctx: AuthContext) {
    return this.roleService.list(ctx);
  }

  @Get(':id/definition')
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_VIEW))
  getDefinition(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.roleService.getDefinition(ctx, id);
  }

  @Get(':id')
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_VIEW))
  get(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.roleService.get(ctx, id);
  }

  /** Creates a custom workspace-member role from its full definition, in one transaction. */
  @Post()
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_MANAGE))
  create(@AuthUser() ctx: AuthContext, @Body() dto: RoleDefinitionDto) {
    return this.roleService.create(ctx, dto);
  }

  /** Replaces a custom role's whole definition (settings + object/field/record rules) in one transaction. */
  @Put(':id')
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_MANAGE))
  update(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: RoleDefinitionDto) {
    return this.roleService.update(ctx, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(PermissionGuard(PermissionFlag.ROLE_MANAGE))
  delete(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.roleService.delete(ctx, id);
  }
}
