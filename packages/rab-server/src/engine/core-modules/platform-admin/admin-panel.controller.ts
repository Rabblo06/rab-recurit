import { ManagerApplication } from '../auth/guards/manager-application.decorator';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AuthUser } from '../../decorators/auth-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthContext } from '../tenant/auth-context.interface';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';
import { AdminPanelService } from './admin-panel.service';
import { OrganisationSuspensionService } from './organisation-suspension.service';
import { StepUpReauthDto } from '../auth/dto/step-up-reauth.dto';
import { MaintenanceModeDto } from './dto/maintenance-mode.dto';
import { RecentUsersQueryDto } from './dto/recent-users-query.dto';
import { SuspendOrganisationDto } from './dto/suspend-organisation.dto';
import { TestSmtpDto } from './dto/test-smtp.dto';
import { UpdateSmtpConfigDto } from './dto/update-smtp-config.dto';
import { RateLimitRequired } from '../throttler/rab-throttler.guard';
import { AdminConfigService } from './admin-config.service';
import { AdminHealthService } from './admin-health.service';
import { AdminEmptyBodyDto, ReactivateOrganisationDto } from './dto/admin-panel.dto';

/**
 * Every route here requires PlatformAdminGuard, never a PermissionFlag —
 * see PlatformAdminService's docstring for why platform-admin status is
 * deliberately not a grantable permission. A normal authenticated user
 * (even one holding every other PermissionFlag) gets a 403 from every
 * route below.
 */
@ManagerApplication()
@Controller('rest/v1/admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class AdminPanelController {
  constructor(
    private readonly adminPanelService: AdminPanelService,
    private readonly platformAdminService: PlatformAdminService,
    private readonly organisationSuspensionService: OrganisationSuspensionService,
    private readonly adminConfig: AdminConfigService,
    private readonly adminHealth: AdminHealthService,
  ) {}

  /**
   * Guarded three times over: `PlatformAdminGuard` (class-level, above)
   * rejects before this handler is even reached, `StepUpReauthService`
   * (inside `PlatformAdminService.grant`) requires the acting session to
   * re-prove its password for THIS call specifically (P2.8 — a hijacked-
   * but-live session alone can never mint a new admin), and
   * `PlatformAdminService.grant` re-checks the acting session's admin
   * status server-side again (CLAUDE.md's "layer 2 is the one people skip"
   * — this method is also reachable from a future non-HTTP caller). The
   * very first platform admin can never be minted through this route —
   * see `grant-platform-admin.command.ts`.
   */
  @Post('platform-admins/:userId')
  grantPlatformAdmin(@AuthUser() ctx: AuthContext, @Param('userId') userId: string, @Body() dto: StepUpReauthDto) {
    return this.platformAdminService.grant(ctx, userId, dto.currentPassword);
  }

  /** P2.8 — same step-up reauth as grant above. */
  @Delete('platform-admins/:userId')
  revokePlatformAdmin(@AuthUser() ctx: AuthContext, @Param('userId') userId: string, @Body() dto: StepUpReauthDto) {
    return this.platformAdminService.revoke(ctx, userId, dto.currentPassword);
  }

  /** Version + (Admin Panel) the build's git commit, or null ("Unknown") when APP_GIT_COMMIT is not set. */
  @Get('general')
  getGeneral() {
    return { ...this.adminPanelService.getGeneral(), commit: this.adminConfig.general().commit };
  }

  /** Admin Panel Health tab: bounded (2 s) probes, cached 10 s, fixed detail strings only. */
  @Get('health/report')
  getHealthReport(@AuthUser() ctx: AuthContext) {
    return this.adminHealth.report(ctx);
  }

  /** Admin Panel Config tab: allowlisted environment variables — secrets and URLs as "set"/"not set" only (D8). */
  @Get('config/environment')
  getEnvironment(@AuthUser() ctx: AuthContext) {
    return this.adminConfig.environment(ctx);
  }

  /** Admin Panel Config tab: the env-driven email settings, read-only (D5). */
  @Get('config/email')
  getEmail(@AuthUser() ctx: AuthContext) {
    return this.adminConfig.email(ctx);
  }

  /** "Send test email to me": the live driver, the admin's own address only, audited. */
  @Post('config/email/test')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @RateLimitRequired()
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sendTestEmail(@AuthUser() ctx: AuthContext, @Body() _body: AdminEmptyBodyDto) {
    return this.adminConfig.sendTestEmail(ctx);
  }

  /** Admin Panel Security tab: switch states and signing-key ids (never key material). */
  @Get('security')
  getSecurity(@AuthUser() ctx: AuthContext) {
    return this.adminConfig.security(ctx);
  }

  @Get('recent-users')
  getRecentUsers(@AuthUser() ctx: AuthContext, @Query() query: RecentUsersQueryDto) {
    return this.adminPanelService.getRecentUsers(ctx, query.search);
  }

  @Get('config')
  getConfig(@AuthUser() ctx: AuthContext) {
    return this.adminPanelService.getConfig(ctx);
  }

  @Patch('config/smtp')
  updateSmtpConfig(@AuthUser() ctx: AuthContext, @Body() dto: UpdateSmtpConfigDto) {
    return this.adminPanelService.updateSmtpConfig(ctx, dto);
  }

  // Opens a real socket to an admin-supplied host:port — rate-limited so it
  // can't be used as a network probe/oracle beyond "did it connect."
  @Post('config/smtp/test')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RateLimitRequired()
  testSmtp(@AuthUser() ctx: AuthContext, @Body() dto: TestSmtpDto) {
    return this.adminPanelService.testSmtp(ctx, dto);
  }

  @Patch('config/maintenance-mode')
  setMaintenanceMode(@AuthUser() ctx: AuthContext, @Body() dto: MaintenanceModeDto) {
    return this.adminPanelService.setMaintenanceMode(ctx, dto);
  }

  @Get('health')
  getHealth() {
    return this.adminPanelService.getHealth();
  }

  /** P2.8 — reversible suspension, never a hard delete. See `OrganisationSuspensionService`'s own doc comment for the full design. */
  @Get('organisations/:organisationId/suspension')
  getOrganisationSuspension(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string) {
    return this.organisationSuspensionService.getStatus(ctx, organisationId);
  }

  @Post('organisations/:organisationId/suspend')
  suspendOrganisation(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string, @Body() dto: SuspendOrganisationDto) {
    return this.organisationSuspensionService.suspend(ctx, organisationId, dto);
  }

  @Post('organisations/:organisationId/reactivate')
  @HttpCode(200)
  reactivateOrganisation(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string, @Body() dto: ReactivateOrganisationDto) {
    return this.organisationSuspensionService.reactivate(ctx, organisationId, dto);
  }
}
