import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CreateVenueDto } from '../dto/create-venue.dto';
import { UpdateVenueDto } from '../dto/update-venue.dto';
import { VenueService } from '../services/venue.service';

@Controller('rest/v1/venues')
@UseGuards(JwtAuthGuard)
export class VenueController {
  constructor(private readonly venueService: VenueService) {}

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_VIEW))
  list(@AuthUser() ctx: AuthContext, @Query() pagination: PaginationDto) {
    return this.venueService.list(ctx, pagination);
  }

  @Get(':id')
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_VIEW))
  get(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.venueService.get(ctx, id);
  }

  @Post()
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_CREATE), RequireWorkspaceGuard)
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateVenueDto) {
    return this.venueService.create(ctx, dto);
  }

  @Patch(':id')
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_EDIT))
  update(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: UpdateVenueDto) {
    return this.venueService.update(ctx, id, dto);
  }

  @Post(':id/archive')
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_EDIT))
  archive(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.venueService.archive(ctx, id);
  }
}
