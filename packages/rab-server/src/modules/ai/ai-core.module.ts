import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { OfferModule } from '../offer/offer.module';
import { PayrollModule } from '../payroll/payroll.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { StaffModule } from '../staff/staff.module';
import { VenueModule } from '../venue/venue.module';
import { AI_TEST_MODEL_CATALOGUE } from './constants/ai.constants';
import { AiAccessService } from './services/ai-access.service';
import { AiConfigService } from './services/ai-config.service';
import { AiCostMeterService } from './services/ai-cost-meter.service';
import { AiQuotaService } from './services/ai-quota.service';
import { AiRedisClientProvider } from './services/ai-redis-client.provider';
import { AiRedisSubscriberProvider } from './services/ai-redis-subscriber.provider';
import { AiRetentionService } from './services/ai-retention.service';
import { AiStreamService } from './services/ai-stream.service';
import { AiTurnQueueService } from './services/ai-turn-queue.service';
import { AiUsageService } from './services/ai-usage.service';
import { AiUsageLedgerService } from './services/ai-usage-ledger.service';
import { AiToolRegistry } from './tools/ai-tool-registry.service';
import { AI_TOOL_PROVIDERS } from './tools';

/**
 * AI shared core (docs/ai/PHASE1_PLAN.md, PHASE2_TWENTY_PLAN.md P2-C11): the AI services BOTH processes need and NO model
 * — imported by the API (`AiModule`) and, through `AiWorkerCoreModule`, by the Worker. Phase 2 moved the model gateway,
 * the provider model factory, the turn runner and the title service OUT of this module into `AiWorkerCoreModule`, which
 * only the Worker imports: no API code path can call a model in-request (bypassing the queue, the slot and the lease).
 * The static test `__tests__/static/ai-worker-only-model.spec.ts` keeps it that way.
 *
 * The domain modules are imported for the read tools (scheduling, offers, attendance, payroll — the registry stays here
 * for the admin tool catalogue); `AuthModule` for `SessionValidityService` (the read-only session re-check). The queue
 * producer (API: new turns and titles; Worker: deferrals and promotions) and the pub/sub subscriber live here too.
 */
@Module({
  imports: [AuthModule, SchedulingModule, OfferModule, AttendanceModule, PayrollModule, StaffModule, VenueModule],
  providers: [
    // Test seam only: production provides NO test models; AiConfigService honours an override only when NODE_ENV=test.
    { provide: AI_TEST_MODEL_CATALOGUE, useValue: null },
    AiConfigService,
    AiRedisClientProvider,
    AiRedisSubscriberProvider,
    AiAccessService,
    AiQuotaService,
    AiCostMeterService,
    AiStreamService,
    AiUsageService,
    AiToolRegistry,
    AiRetentionService,
    AiUsageLedgerService,
    AiTurnQueueService,
    // AI Phase 3: the reviewed read-tool classes (tools/index.ts AI_READ_TOOLS) + the AI_TOOL_CLASSES collector.
    ...AI_TOOL_PROVIDERS,
  ],
  exports: [
    AiConfigService,
    AiRedisClientProvider,
    AiRedisSubscriberProvider,
    AiAccessService,
    AiQuotaService,
    AiCostMeterService,
    AiStreamService,
    AiUsageService,
    AiToolRegistry,
    AiRetentionService,
    AiTurnQueueService,
  ],
})
export class AiCoreModule {}
