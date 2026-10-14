import { PermissionFlag } from '@rab/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { MembersService } from '../services/members.service';

export class ListMembersDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Settings → Members → Team. The workspace owner's view of their workspace's members; see MembersService. */
@ManagerApplication()
@Controller('rest/v1/members')
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.ROLE_VIEW))
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  list(@AuthUser() ctx: AuthContext, @Query() query: ListMembersDto) {
    return this.members.list(ctx, { search: query.search, page: query.page ?? 1, limit: query.limit ?? 25 });
  }
}
