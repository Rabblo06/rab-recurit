import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { LOGO_MAX_BYTES, singleImageUploadOptions } from '../../../engine/core-modules/storage/upload-limits';
import { CheckSubdomainDto } from '../dto/check-subdomain.dto';
import { CreateManagerWorkspaceDto } from '../dto/create-manager-workspace.dto';
import { SuggestSubdomainsDto } from '../dto/suggest-subdomains.dto';
import { UpdateManagerWorkspaceNameDto } from '../dto/update-manager-workspace-name.dto';
import { UpdateManagerWorkspaceSubdomainDto } from '../dto/update-manager-workspace-subdomain.dto';
import { ManagerWorkspaceService } from '../services/manager-workspace.service';

// Deliberately tight — the same subdomain-enumeration/DB-load concern
// AUTH_THROTTLE (auth.controller.ts) exists for, applied here since a
// candidate-subdomain check is the closest thing this feature has to a
// probe-able endpoint. Combined with the web client's own 300-500ms
// debounce (Increment 3) — this guard is the server-side backstop, not a
// substitute for it.
const SUBDOMAIN_CHECK_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

// Wave 3 lane H: every rename quarantines the old label for lane S2's interval (90 days, reclaimable only by this
// workspace), so a burst of renames could hoard labels. A coarse per-client cap; the owner may want a stricter,
// per-workspace limit (WAVE3_LANE_H_REPORT.md, owner decisions).
const SUBDOMAIN_RENAME_THROTTLE = { default: { limit: 5, ttl: 3_600_000 } };

// Phase B P8: create is ALSO the owner's resume / retry of provisioning (WorkspacePreparationScreen re-POSTs the same body:
// auto-resume once per mount, and "Try again" on FAILED), and every retry of a FAILED workspace re-runs the full workspace
// DDL inside core.provision_workspace. The privileged worker provisioner is NOT retired yet: production still runs it
// (CREWFLOW_PROVISIONER_ENABLED, the provisioner credential handed to that child alone) until gate G2, so this route is the
// owner-facing retry path alongside the provisioner's own retries, not the only one. It gets its own cap instead of the
// global 120/min default. Same convention as the other route throttles here: the
// global tracker is the client IP (`resolveClientIp`), because the throttler is a global guard that runs before
// JwtAuthGuard has verified the session, so a verified user id is not yet known. 10/min comfortably covers the screen's
// own pattern (one auto-resume per mount + a few manual retries) for several owners behind one office IP.
export const WORKSPACE_CREATE_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

// fast-fail before the buffer is fully read; StorageService re-checks server-side
const LOGO_UPLOAD_OPTIONS = singleImageUploadOptions(LOGO_MAX_BYTES);

/**
 * `ManagerWorkspace` — a private, individually-owned workspace per Manager.
 * Not `WorkspaceController` (`modules/identity/`, `rest/v1/workspace`),
 * which is a different, pre-existing concept: editing the shared
 * Organisation's own settings. See the entity's doc comment.
 */
@ManagerApplication()
@Controller('rest/v1/manager-workspaces')
@UseGuards(JwtAuthGuard)
export class ManagerWorkspaceController {
  constructor(
    private readonly managerWorkspaceService: ManagerWorkspaceService,
  ) {}

  // `?fresh=1` — used ONLY by `WorkspacePreparationScreen`'s own active-provisioning poll
  // (`useMyWorkspace({ pollWhileCreating: true })`). See `getMine()`'s own doc comment for why: the
  // provisioner (an isolated, privilege-separated raw-`pg` process — see
  // `provision-workspace-schema.ts`'s own doc comment on why it deliberately has no NestJS DI/Redis
  // access) has no way to invalidate `CoreEntityCacheService`'s cache when it flips
  // `schema_status`, so an ordinary cached read could keep showing `CREATING` for up to that
  // cache's 5-minute TTL after the workspace is genuinely `READY`. Every OTHER caller of this route
  // (Settings pages, etc.) is unaffected and still benefits from the cache as before — this bypass
  // is scoped to the one request pattern that specifically needs provable freshness.
  @Get('me')
  getMine(@AuthUser() ctx: AuthContext, @Query('fresh') fresh?: string) {
    return this.managerWorkspaceService.getMine(ctx, { skipCache: fresh === '1' });
  }

  @Post()
  @Throttle(WORKSPACE_CREATE_THROTTLE)
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateManagerWorkspaceDto) {
    return this.managerWorkspaceService.create(ctx, dto);
  }

  @Patch('me')
  updateName(@AuthUser() ctx: AuthContext, @Body() dto: UpdateManagerWorkspaceNameDto) {
    return this.managerWorkspaceService.updateName(ctx, dto);
  }

  @Patch('me/subdomain')
  @Throttle(SUBDOMAIN_RENAME_THROTTLE)
  updateSubdomain(@AuthUser() ctx: AuthContext, @Body() dto: UpdateManagerWorkspaceSubdomainDto) {
    return this.managerWorkspaceService.updateSubdomain(ctx, dto);
  }

  @Post('subdomain/check')
  @Throttle(SUBDOMAIN_CHECK_THROTTLE)
  checkSubdomain(@AuthUser() ctx: AuthContext, @Body() dto: CheckSubdomainDto) {
    // C3: the caller's own workspace is excluded, so its current label (and its own quarantined ones) read available.
    return this.managerWorkspaceService.checkSubdomainFor(ctx, dto.candidate);
  }

  @Post('subdomain/suggestions')
  @HttpCode(HttpStatus.OK)
  @Throttle(SUBDOMAIN_CHECK_THROTTLE)
  suggestSubdomains(@AuthUser() ctx: AuthContext, @Body() dto: SuggestSubdomainsDto) {
    return this.managerWorkspaceService.suggestSubdomains(ctx, dto.name);
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
