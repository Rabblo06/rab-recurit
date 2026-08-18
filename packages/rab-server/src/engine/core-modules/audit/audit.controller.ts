import { PermissionFlag } from '@rab/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../decorators/auth-user.decorator';
import { AuthContext } from '../tenant/auth-context.interface';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../guards/permission.guard';
import { AuditService } from './audit.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

/** Manager-only (AUDIT_VIEW) — the generic activity feed `TimelinePanel.tsx`/`AuditLog.tsx` were built against. */
@Controller('rest/v1/audit-logs')
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AUDIT_VIEW))
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  list(@AuthUser() ctx: AuthContext, @Query() query: ListAuditLogsDto) {
    return this.auditService.list(ctx, query);
  }
}
