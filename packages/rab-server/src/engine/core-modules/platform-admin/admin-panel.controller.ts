import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AuthUser } from '../../decorators/auth-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthContext } from '../tenant/auth-context.interface';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { AdminPanelService } from './admin-panel.service';
import { MaintenanceModeDto } from './dto/maintenance-mode.dto';
import { RecentUsersQueryDto } from './dto/recent-users-query.dto';
import { TestSmtpDto } from './dto/test-smtp.dto';
import { UpdateSmtpConfigDto } from './dto/update-smtp-config.dto';

/**
 * Every route here requires PlatformAdminGuard, never a PermissionFlag —
 * see PlatformAdminService's docstring for why platform-admin status is
 * deliberately not a grantable permission. A normal authenticated user
 * (even one holding every other PermissionFlag) gets a 403 from every
 * route below.
 */
@Controller('rest/v1/admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminPanelController {
  constructor(private readonly adminPanelService: AdminPanelService) {}

  @Get('general')
  getGeneral() {
    return this.adminPanelService.getGeneral();
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
}
