import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AuthUser } from '../../decorators/auth-user.decorator';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../auth/guards/manager-application.decorator';
import { AuthContext } from '../tenant/auth-context.interface';
import { AdminWorkspacesService } from './admin-workspaces.service';
import { AdminWorkspacesQueryDto } from './dto/admin-panel.dto';

/**
 * Crewflow Platform Admin Panel — platform overview (General stat cards) and the Workspaces tab. Read-only; no Retry
 * route (owner decision D6: the provisioner retries FAILED workspaces automatically).
 *
 *   GET /rest/v1/admin/overview                               counts only
 *   GET /rest/v1/admin/migrations                             core migrations applied / latest / pending
 *   GET /rest/v1/admin/workspaces?status=&organisationId=&cursor=&limit=
 */
@ManagerApplication()
@Controller('rest/v1/admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class AdminWorkspacesController {
  constructor(private readonly workspaces: AdminWorkspacesService) {}

  @Get('overview')
  overview(@AuthUser() ctx: AuthContext) {
    return this.workspaces.overview(ctx);
  }

  @Get('migrations')
  migrations(@AuthUser() ctx: AuthContext) {
    return this.workspaces.coreMigrations(ctx);
  }

  @Get('workspaces')
  list(@AuthUser() ctx: AuthContext, @Query() query: AdminWorkspacesQueryDto) {
    return this.workspaces.listWorkspaces(ctx, query);
  }
}
