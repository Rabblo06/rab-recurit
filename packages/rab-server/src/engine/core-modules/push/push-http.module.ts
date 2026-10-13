import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PushDeviceController } from './controllers/push-device.controller';

/**
 * The HTTP-facing half of push — split out from the global `PushModule` specifically so
 * `rab-worker`'s `WorkerModule` (no HTTP adapter, no `AuthModule`) never pulls in a controller
 * guarded by `JwtAuthGuard`. Imported ONLY by `AppModule` (the API process).
 */
@Module({
  imports: [AuthModule],
  controllers: [PushDeviceController],
})
export class PushHttpModule {}
