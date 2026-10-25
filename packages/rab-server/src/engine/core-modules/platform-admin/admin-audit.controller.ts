import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AuthUser } from '../../decorators/auth-user.decorator';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../auth/guards/manager-application.decorator';
import { AuthContext } from '../tenant/auth-context.interface';
import { RateLimitRequired } from '../throttler/rab-throttler.guard';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditQueryDto } from './dto/admin-panel.dto';

/**
 * Crewflow Platform Admin Panel — Audit tab. `GET /rest/v1/admin/audit?action=&user=&cursor=&limit=` (read-only; the
 * audit log is insert-only and there is no update/delete route anywhere). `action` must be one of the admin allowlist
 * (400 otherwise), `user` is a user id (actor OR target), `cursor` is the opaque keyset cursor of the previous page.
 */
@ManagerApplication()
@Controller('rest/v1/admin/audit')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class AdminAuditController {
  constructor(private readonly auditTimeline: AdminAuditService) {}

  @Get()
  @RateLimitRequired()
  list(@AuthUser() ctx: AuthContext, @Query() query: AdminAuditQueryDto) {
    return this.auditTimeline.listAudit(ctx, query);
  }
}
