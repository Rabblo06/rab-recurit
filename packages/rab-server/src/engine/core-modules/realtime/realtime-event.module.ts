import { Global, Module } from '@nestjs/common';

import { RealtimeEventService } from './realtime-event.service';

/**
 * Global (Phase C1b): the outbox writer is called from several domain services (offer, scheduling, attendance,
 * notification, payroll) in the API and the Worker; making the module global gives each of them the one shared
 * provider without touching every domain module's imports. It holds no state beyond `EnvironmentService`.
 */
@Global()
@Module({
  providers: [RealtimeEventService],
  exports: [RealtimeEventService],
})
export class RealtimeEventModule {}
