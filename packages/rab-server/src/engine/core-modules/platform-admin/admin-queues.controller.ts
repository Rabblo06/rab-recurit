import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AuthUser } from '../../decorators/auth-user.decorator';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../auth/guards/manager-application.decorator';
import { AuthContext } from '../tenant/auth-context.interface';
import { RateLimitRequired } from '../throttler/rab-throttler.guard';
import { AdminQueuesService } from './admin-queues.service';
import { AdminQueueJobsActionDto, AdminQueueJobsQueryDto } from './dto/admin-panel.dto';

const QUEUE_NAME = /^[a-z0-9-]{1,64}$/;
const queueParam = (name: string) => {
  if (!QUEUE_NAME.test(name)) throw new NotFoundException('Queue not found.');
  return name;
};

/**
 * Crewflow Platform Admin Panel — Health tab queues. Transport adapter only; `AdminQueuesService` re-checks the actor
 * (layer 2), applies the D7 eligibility rules, step-up and reason, and never returns job data.
 *
 *   GET  /rest/v1/admin/queues                              registry queues + counts, worker heartbeat/scheduler/cycles
 *   GET  /rest/v1/admin/queues/:queue/jobs?state=&offset=&limit=   ids, timestamps, attempts, error class only
 *   POST /rest/v1/admin/queues/:queue/jobs/retry  {jobIds, reason}
 *   POST /rest/v1/admin/queues/:queue/jobs/delete {jobIds, reason}
 */
@ManagerApplication()
@Controller('rest/v1/admin/queues')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class AdminQueuesController {
  constructor(private readonly queues: AdminQueuesService) {}

  @Get()
  overview(@AuthUser() ctx: AuthContext) {
    return this.queues.overview(ctx);
  }

  @Get(':queue/jobs')
  jobs(@AuthUser() ctx: AuthContext, @Param('queue') queue: string, @Query() query: AdminQueueJobsQueryDto) {
    return this.queues.listJobs(ctx, queueParam(queue), query.state, query.offset ?? 0, query.limit ?? 25);
  }

  @Post(':queue/jobs/retry')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RateLimitRequired()
  retry(@AuthUser() ctx: AuthContext, @Param('queue') queue: string, @Body() dto: AdminQueueJobsActionDto) {
    return this.queues.retryJobs(ctx, queueParam(queue), dto.jobIds, dto.reason);
  }

  @Post(':queue/jobs/delete')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RateLimitRequired()
  delete(@AuthUser() ctx: AuthContext, @Param('queue') queue: string, @Body() dto: AdminQueueJobsActionDto) {
    return this.queues.deleteJobs(ctx, queueParam(queue), dto.jobIds, dto.reason);
  }
}
