import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AuthUser } from '../../decorators/auth-user.decorator';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../auth/guards/manager-application.decorator';
import { AuthContext } from '../tenant/auth-context.interface';
import { RateLimitRequired } from '../throttler/rab-throttler.guard';
import { AdminUsersService } from './admin-users.service';
import { AdminOrganisationSearchQueryDto, AdminReasonDto, AdminUserSearchQueryDto } from './dto/admin-panel.dto';

/**
 * Crewflow Platform Admin Panel — General tab: user / organisation lookup, user summary, "Sign out everywhere", platform
 * admins list. Transport adapter only; `AdminUsersService` re-checks platform-admin status on every call (layer 2).
 *
 *   GET  /rest/v1/admin/users/search?q=&role=&limit=          cross-organisation user search (audited when q is given)
 *   GET  /rest/v1/admin/users/:userId/summary                 one user's admin summary (audited)
 *   POST /rest/v1/admin/users/:userId/sessions/revoke {reason} sign the user out everywhere (step-up + reason + audit)
 *   GET  /rest/v1/admin/platform-admins                       active platform administrators
 *   GET  /rest/v1/admin/lookup/organisations?q=               organisation search (audited when q is given)
 *   GET  /rest/v1/admin/lookup/organisations/:id/summary      organisation summary (counts only)
 */
@ManagerApplication()
@Controller('rest/v1/admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get('users/search')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RateLimitRequired()
  search(@AuthUser() ctx: AuthContext, @Query() query: AdminUserSearchQueryDto) {
    return this.users.searchUsers(ctx, query.q, query.role, query.limit);
  }

  @Get('users/:userId/summary')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RateLimitRequired()
  summary(@AuthUser() ctx: AuthContext, @Param('userId') userId: string) {
    return this.users.userSummary(ctx, userId);
  }

  @Post('users/:userId/sessions/revoke')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RateLimitRequired()
  revokeSessions(@AuthUser() ctx: AuthContext, @Param('userId') userId: string, @Body() dto: AdminReasonDto) {
    return this.users.revokeSessions(ctx, userId, dto.reason);
  }

  @Get('platform-admins')
  platformAdmins(@AuthUser() ctx: AuthContext) {
    return this.users.listPlatformAdmins(ctx);
  }

  @Get('lookup/organisations')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RateLimitRequired()
  searchOrganisations(@AuthUser() ctx: AuthContext, @Query() query: AdminOrganisationSearchQueryDto) {
    return this.users.searchOrganisations(ctx, query.q);
  }

  @Get('lookup/organisations/:organisationId/summary')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  organisationSummary(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string) {
    return this.users.organisationSummary(ctx, organisationId);
  }
}
