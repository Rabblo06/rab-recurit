import { Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../decorators/auth-user.decorator';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthContext } from '../tenant/auth-context.interface';
import { AdminInspectService } from './admin-inspect.service';

/**
 * `@AuthUser() ctx` on both routes here is always the admin's own real,
 * un-rebuilt identity — `JwtAuthGuard` carves this whole path prefix out of
 * the inspect-header rewrite (see its own docstring), so ending an active
 * session always works even while the header is attached.
 */
@Controller('rest/v1/admin/inspect')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminInspectController {
  constructor(private readonly adminInspectService: AdminInspectService) {}

  @Post('end')
  @HttpCode(HttpStatus.NO_CONTENT)
  end(@AuthUser() ctx: AuthContext) {
    return this.adminInspectService.end(ctx);
  }

  @Post(':targetUserId')
  start(@AuthUser() ctx: AuthContext, @Param('targetUserId') targetUserId: string) {
    return this.adminInspectService.start(ctx, targetUserId);
  }
}
