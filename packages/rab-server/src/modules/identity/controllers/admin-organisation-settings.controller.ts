import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { LOGO_MAX_BYTES, singleImageUploadOptions } from '../../../engine/core-modules/storage/upload-limits';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PlatformAdminGuard } from '../../../engine/guards/platform-admin.guard';
import { UpdateAuthProvidersDto } from '../dto/update-auth-providers.dto';
import { UpdateSubdomainDto } from '../dto/update-subdomain.dto';
import { UpdateWorkspaceDto } from '../dto/update-workspace.dto';
import { OrganisationSettingsAdminService } from '../services/organisation-settings-admin.service';

const LOGO_UPLOAD_OPTIONS = singleImageUploadOptions(LOGO_MAX_BYTES);

/**
 * W6-E2E-04 — organisation settings, PLATFORM ADMIN ONLY (owner decision 2026-10-23). `PlatformAdminGuard` here
 * (403 for anyone without the platform-admin claim, whatever PermissionFlags they hold), and
 * `OrganisationSettingsAdminService` re-checks the claim inside its own transaction (layer 2). A malformed
 * `:organisationId` is 404 (global `UuidPathParamsInterceptor`), an unknown one is 404 (service).
 */
@ManagerApplication()
@Controller('rest/v1/admin/organisations/:organisationId/settings')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminOrganisationSettingsController {
  constructor(private readonly settings: OrganisationSettingsAdminService) {}

  @Get()
  get(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string) {
    return this.settings.get(ctx, organisationId);
  }

  @Patch()
  update(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string, @Body() dto: UpdateWorkspaceDto) {
    return this.settings.update(ctx, organisationId, dto);
  }

  @Patch('domain')
  updateSubdomain(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string, @Body() dto: UpdateSubdomainDto) {
    return this.settings.updateSubdomain(ctx, organisationId, dto);
  }

  @Post('logo')
  @UseInterceptors(FileInterceptor('file', LOGO_UPLOAD_OPTIONS))
  uploadLogo(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string, @UploadedFile() file?: { buffer: Buffer }) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    return this.settings.uploadLogo(ctx, organisationId, file.buffer);
  }

  @Delete('logo')
  deleteLogo(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string) {
    return this.settings.deleteLogo(ctx, organisationId);
  }

  @Patch('security')
  updateSecurity(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string, @Body() dto: UpdateAuthProvidersDto) {
    return this.settings.updateAuthProviders(ctx, organisationId, dto);
  }
}
