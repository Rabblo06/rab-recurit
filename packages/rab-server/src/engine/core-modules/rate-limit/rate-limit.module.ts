import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ExpensiveActionRateLimitService } from './expensive-action-rate-limit.service';
import { InvitationRateLimitService } from './invitation-rate-limit.service';

/** Atomic Redis token-bucket limits for flows that need more than the per-IP route throttler (see InvitationRateLimitService). */
@Module({
  imports: [AuthModule],
  providers: [InvitationRateLimitService, ExpensiveActionRateLimitService],
  exports: [InvitationRateLimitService, ExpensiveActionRateLimitService],
})
export class RateLimitModule {}
