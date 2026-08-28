import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { CheckSubdomainDto } from '../dto/check-subdomain.dto';
import { CreateManagerWorkspaceDto } from '../dto/create-manager-workspace.dto';
import { UpdateManagerWorkspaceNameDto } from '../dto/update-manager-workspace-name.dto';
import { UpdateManagerWorkspaceSubdomainDto } from '../dto/update-manager-workspace-subdomain.dto';
import { ManagerWorkspaceService } from '../services/manager-workspace.service';
import { SubdomainService } from '../services/subdomain.service';

// Deliberately tight — the same subdomain-enumeration/DB-load concern
// AUTH_THROTTLE (auth.controller.ts) exists for, applied here since a
// candidate-subdomain check is the closest thing this feature has to a
// probe-able endpoint. Combined with the web client's own 300-500ms
// debounce (Increment 3) — this guard is the server-side backstop, not a
// substitute for it.
const SUBDOMAIN_CHECK_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

const LOGO_UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // fast-fail before the buffer is fully read; StorageService re-checks server-side
};

/**
 * `ManagerWorkspace` — a private, individually-owned workspace per Manager.
 * Not `WorkspaceController` (`modules/identity/`, `rest/v1/workspace`),
 * which is a different, pre-existing concept: editing the shared
 * Organisation's own settings. See the entity's doc comment.
 */
@Controller('rest/v1/manager-workspaces')
@UseGuards(JwtAuthGuard)
export class ManagerWorkspaceController {
  constructor(
    private readonly managerWorkspaceService: ManagerWorkspaceService,
    private readonly subdomainService: SubdomainService,
  ) {}

  @Get('me')
  getMine(@AuthUser() ctx: AuthContext) {
    return this.managerWorkspaceService.getMine(ctx);
  }

  @Post()
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateManagerWorkspaceDto) {
    return this.managerWorkspaceService.create(ctx, dto);
  }

  @Patch('me')
  updateName(@AuthUser() ctx: AuthContext, @Body() dto: UpdateManagerWorkspaceNameDto) {
    return this.managerWorkspaceService.updateName(ctx, dto);
  }

  @Patch('me/subdomain')
  updateSubdomain(@AuthUser() ctx: AuthContext, @Body() dto: UpdateManagerWorkspaceSubdomainDto) {
    return this.managerWorkspaceService.updateSubdomain(ctx, dto);
  }

  @Post('subdomain/check')
  @Throttle(SUBDOMAIN_CHECK_THROTTLE)
  checkSubdomain(@Body() dto: CheckSubdomainDto) {
    return this.subdomainService.checkAvailability(dto.candidate);
  }

  @Post('me/logo')
  @UseInterceptors(FileInterceptor('file', LOGO_UPLOAD_OPTIONS))
  uploadLogo(@AuthUser() ctx: AuthContext, @UploadedFile() file?: { buffer: Buffer }) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    return this.managerWorkspaceService.uploadLogo(ctx, file.buffer);
  }

  @Delete('me/logo')
  deleteLogo(@AuthUser() ctx: AuthContext) {
    return this.managerWorkspaceService.deleteLogo(ctx);
  }

  @Post('me/complete-onboarding')
  @HttpCode(HttpStatus.OK)
  completeOnboarding(@AuthUser() ctx: AuthContext) {
    return this.managerWorkspaceService.completeOnboarding(ctx);
  }
}
