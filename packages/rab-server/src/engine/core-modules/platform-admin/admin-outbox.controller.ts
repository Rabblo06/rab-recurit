import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AuthUser } from '../../decorators/auth-user.decorator';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../auth/guards/manager-application.decorator';
import { AuthContext } from '../tenant/auth-context.interface';
import { RateLimitRequired } from '../throttler/rab-throttler.guard';
import { FailedOutboxQueryDto, ReplayFailedEmailDto } from './dto/outbox-operations.dto';
import { OutboxOperationsService } from './outbox-operations.service';

/**
 * Wave 5 lane OPS — operator surface for the durable outboxes. Platform admins only (same guard pair as every
 * `rest/v1/admin` route; `OutboxOperationsService` re-checks platform-admin status itself). Transport adapter only.
 *
 *   GET  /rest/v1/admin/outbox/failed?kind=&organisationId=&limit=   FAILED rows, ids/codes/timestamps only (no bodies)
 *   POST /rest/v1/admin/outbox/organisations/:organisationId/emails/:emailId/replay   named action, audited, exactly once
 *   GET  /rest/v1/admin/outbox/queues                                BullMQ counts + worker heartbeat/loop stats
 */
@ManagerApplication()
@Controller('rest/v1/admin/outbox')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminOutboxController {
  constructor(private readonly outbox: OutboxOperationsService) {}

  @Get('failed')
  listFailed(@AuthUser() ctx: AuthContext, @Query() query: FailedOutboxQueryDto) {
    return this.outbox.listFailed(ctx, query);
  }

  @Post('organisations/:organisationId/emails/:emailId/replay')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RateLimitRequired()
  replayEmail(
    @AuthUser() ctx: AuthContext,
    @Param('organisationId', new ParseUUIDPipe()) organisationId: string,
    @Param('emailId', new ParseUUIDPipe()) emailId: string,
    @Body() dto: ReplayFailedEmailDto,
  ) {
    return this.outbox.replayFailedEmail(ctx, organisationId, emailId, { allowUncertain: dto.allowUncertain });
  }

  @Get('queues')
  queues(@AuthUser() ctx: AuthContext) {
    return this.outbox.queueHealth(ctx);
  }
}
