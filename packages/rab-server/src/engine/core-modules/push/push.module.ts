import { Global, Module } from '@nestjs/common';

import { PushDeviceService } from './push-device.service';
import { PushDeliveryService } from './push-delivery.service';
import { PushDriverFactory } from './push-driver.factory';
import { PushQueueService } from './push-queue.service';
import { PushService } from './push.service';

/**
 * Global, same convention as `EmailModule`/`SecretEncryptionModule` — `NotificationService` (any
 * module) and `rab-worker`'s `WorkerModule` both need these services without every importer
 * re-declaring the import. Deliberately PROVIDERS ONLY, no controller: `rab-worker`'s
 * `WorkerModule` is a bare `NestFactory.createApplicationContext` with no HTTP adapter and no
 * `AuthModule` — a controller guarded by `JwtAuthGuard` here would break the worker's DI graph
 * (confirmed live: `AccessTokenService`/`AuthSecuritySnapshotService` etc. aren't resolvable
 * without `AuthModule`, which the worker never imports). The HTTP-facing registration endpoint
 * lives in the separate `PushHttpModule` below, imported ONLY by `AppModule`.
 */
@Global()
@Module({
  providers: [PushDeviceService, PushDeliveryService, PushDriverFactory, PushService, PushQueueService],
  exports: [PushDeviceService, PushDeliveryService, PushDriverFactory, PushService, PushQueueService],
})
export class PushModule {}
