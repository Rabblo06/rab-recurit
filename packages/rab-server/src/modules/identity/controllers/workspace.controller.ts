import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { PermissionFlag } from '@rab/shared';
import { Controller, Get, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { WorkspaceService } from '../services/workspace.service';

/**
 * The tenant's organisation settings — READ ONLY (`settings.view`).
 *
 * W6-E2E-04 (owner decision 2026-10-23): changing organisation settings, including turning password sign-in off, is
 * platform-admin only — see `AdminOrganisationSettingsController`. The former tenant mutations (`PATCH /workspace`,
 * `PATCH /workspace/domain`, `POST|DELETE /workspace/logo`, `PATCH /workspace/security`, all `settings.edit`) were
 * removed rather than left behind a flag nobody holds, so no grant, override or fixture can re-open them (404).
 */
@ManagerApplication()
@Controller('rest/v1/workspace')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.SETTINGS_VIEW))
  get(@AuthUser() ctx: AuthContext) {
    return this.workspaceService.get(ctx);
  }

  /** P1C.1B — Settings -> Security -> Authentication, read-only for the tenant since W6-E2E-04. */
  @Get('security')
  @UseGuards(PermissionGuard(PermissionFlag.SETTINGS_VIEW))
  getSecurity(@AuthUser() ctx: AuthContext) {
    return this.workspaceService.getAuthProviders(ctx);
  }
}
