import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { OfferModule } from '../offer/offer.module';
import { PayrollModule } from '../payroll/payroll.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AI_LANGUAGE_MODEL_FACTORY, defaultAiLanguageModelFactory, ModelGatewayService } from './gateway/model-gateway.service';
import { AiAccessService } from './services/ai-access.service';
import { AiConfigService } from './services/ai-config.service';
import { AiCostMeterService } from './services/ai-cost-meter.service';
import { AiQuotaService } from './services/ai-quota.service';
import { AiRedisClientProvider } from './services/ai-redis-client.provider';
import { AiRetentionService } from './services/ai-retention.service';
import { AiStreamService } from './services/ai-stream.service';
import { AiTurnRunnerService } from './services/ai-turn-runner.service';
import { AiUsageService } from './services/ai-usage.service';
import { AiToolRegistry } from './tools/ai-tool-registry.service';

/**
 * AI Phase 1 shared core (docs/ai/PHASE1_PLAN.md): every AI service, NO controllers — imported by BOTH the API
 * (`AiModule`) and the Worker (`WorkerModule`), so the step loop the Worker runs is the same code the API was tested
 * against. The domain modules are imported for the five read tools only (scheduling, offers, attendance, payroll);
 * `AuthModule` for `SessionValidityService` (the Worker's read-only session re-check).
 */
@Module({
  imports: [AuthModule, SchedulingModule, OfferModule, AttendanceModule, PayrollModule],
  providers: [
    // The allowlisted model factory (overridable in tests with a recorded/scripted model; production resolves this one).
    { provide: AI_LANGUAGE_MODEL_FACTORY, useValue: defaultAiLanguageModelFactory },
    AiConfigService,
    AiRedisClientProvider,
    AiAccessService,
    AiQuotaService,
    AiCostMeterService,
    AiStreamService,
    AiUsageService,
    ModelGatewayService,
    AiToolRegistry,
    AiTurnRunnerService,
    AiRetentionService,
  ],
  exports: [AiConfigService, AiRedisClientProvider, AiAccessService, AiQuotaService, AiCostMeterService, AiStreamService, AiUsageService, ModelGatewayService, AiToolRegistry, AiTurnRunnerService, AiRetentionService],
})
export class AiCoreModule {}
