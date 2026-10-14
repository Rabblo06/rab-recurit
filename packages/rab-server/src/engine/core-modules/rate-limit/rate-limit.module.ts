import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InvitationRateLimitService } from './invitation-rate-limit.service';

/** Atomic Redis token-bucket limits for flows that need more than the per-IP route throttler (see InvitationRateLimitService). */
@Module({
  imports: [AuthModule],
  providers: [InvitationRateLimitService],
  exports: [InvitationRateLimitService],
})
export class RateLimitModule {}
