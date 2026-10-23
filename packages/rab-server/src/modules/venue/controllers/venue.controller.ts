import { PermissionFlag } from '@rab/shared';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { singleImageUploadOptions, VENUE_PHOTO_MAX_BYTES } from '../../../engine/core-modules/storage/upload-limits';
import { CreateVenueDto } from '../dto/create-venue.dto';
import { CreateVenueRoleRateDto } from '../dto/create-venue-role-rate.dto';
import { ListVenuesDto } from '../dto/list-venues.dto';
import { UpdateVenueDto } from '../dto/update-venue.dto';
import { UpdateVenueRoleRateDto } from '../dto/update-venue-role-rate.dto';
import { VenueService } from '../services/venue.service';
import { MobileApplication } from '../../../engine/core-modules/auth/guards/mobile-application.decorator';

@Controller('rest/v1/venues')
@UseGuards(JwtAuthGuard)
export class VenueController {
  constructor(private readonly venueService: VenueService) {}

  @MobileApplication('venue_manager_app')

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_VIEW))
  list(@AuthUser() ctx: AuthContext, @Query() dto: ListVenuesDto) {
    return this.venueService.list(ctx, dto);
  }

  // CF-08: the Venue Manager role's existing venue-scoped read surface (venue-manager-scoping specs).

  @MobileApplication('venue_manager_app')

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

  /**
   * Venue profile photo (multipart field `file`, one JPEG/PNG/WebP, max 5 MB; no other form field is accepted, so a
   * body naming `organisationId` or anything else is a 400). Same guard as PATCH; VenueService re-checks permission and
   * venue scope (404 outside it) and the storage layer re-decides the type and size from the bytes.
   */
  @Post(':id/photo')
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_EDIT), RequireWorkspaceGuard)
  @UseInterceptors(FileInterceptor('file', singleImageUploadOptions(VENUE_PHOTO_MAX_BYTES)))
  uploadPhoto(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: { buffer: Buffer }) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    return this.venueService.uploadPhoto(ctx, id, file.buffer);
  }

  @Delete(':id/photo')
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_EDIT), RequireWorkspaceGuard)
  removePhoto(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueService.removePhoto(ctx, id);
  }

  /** Named action archiveVenue (wave 5: also stamps archived_at/by + audit). Never a status write. */
  @Post(':id/archive')
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_EDIT), RequireWorkspaceGuard)
  archive(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueService.archive(ctx, id);
  }

  /** Named action restoreVenue (wave 5). */
  @Post(':id/restore')
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_EDIT), RequireWorkspaceGuard)
  restore(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueService.restore(ctx, id);
  }

  @Get(':id/role-rates')
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_VIEW))
  listRoleRates(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.venueService.listRoleRates(ctx, id);
  }

  @Post(':id/role-rates')
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_EDIT))
  createRoleRate(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: CreateVenueRoleRateDto) {
    return this.venueService.createRoleRate(ctx, id, dto);
  }

  @Patch(':id/role-rates/:rateId')
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_EDIT))
  updateRoleRate(
    @AuthUser() ctx: AuthContext,
    @Param('id') id: string,
    @Param('rateId') rateId: string,
    @Body() dto: UpdateVenueRoleRateDto,
  ) {
    return this.venueService.updateRoleRate(ctx, id, rateId, dto);
  }

  @Delete(':id/role-rates/:rateId')
  @UseGuards(PermissionGuard(PermissionFlag.VENUE_EDIT))
  deleteRoleRate(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Param('rateId') rateId: string) {
    return this.venueService.deleteRoleRate(ctx, id, rateId);
  }
}
