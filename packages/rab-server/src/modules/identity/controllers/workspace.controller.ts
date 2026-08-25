import { PermissionFlag } from '@rab/shared';
import { BadRequestException, Body, Controller, Delete, Get, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { UpdateSubdomainDto } from '../dto/update-subdomain.dto';
import { UpdateWorkspaceDto } from '../dto/update-workspace.dto';
import { WorkspaceService } from '../services/workspace.service';

const LOGO_UPLOAD_OPTIONS = { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } };

@Controller('rest/v1/workspace')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.SETTINGS_VIEW))
  get(@AuthUser() ctx: AuthContext) {
    return this.workspaceService.get(ctx);
  }

  @Patch()
  @UseGuards(PermissionGuard(PermissionFlag.SETTINGS_EDIT))
  update(@AuthUser() ctx: AuthContext, @Body() dto: UpdateWorkspaceDto) {
    return this.workspaceService.update(ctx, dto);
  }

  @Patch('domain')
  @UseGuards(PermissionGuard(PermissionFlag.SETTINGS_EDIT))
  updateSubdomain(@AuthUser() ctx: AuthContext, @Body() dto: UpdateSubdomainDto) {
    return this.workspaceService.updateSubdomain(ctx, dto);
  }

  @Post('logo')
  @UseGuards(PermissionGuard(PermissionFlag.SETTINGS_EDIT))
  @UseInterceptors(FileInterceptor('file', LOGO_UPLOAD_OPTIONS))
  uploadLogo(@AuthUser() ctx: AuthContext, @UploadedFile() file?: { buffer: Buffer }) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    return this.workspaceService.uploadLogo(ctx, file.buffer);
  }

  @Delete('logo')
  @UseGuards(PermissionGuard(PermissionFlag.SETTINGS_EDIT))
  deleteLogo(@AuthUser() ctx: AuthContext) {
    return this.workspaceService.deleteLogo(ctx);
  }
}
