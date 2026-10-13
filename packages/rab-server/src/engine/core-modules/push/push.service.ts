import { Injectable } from '@nestjs/common';

import { PushDriverFactory } from './push-driver.factory';
import { PushSendOptions, PushSendResult } from './drivers/interfaces/push-driver.interface';

/** Thin facade over `PushDriverFactory` — mirrors `EmailService`'s own wrapping of `EmailDriverFactory` exactly, so the worker-side dispatch/processor code reads identically to its email counterpart. */
@Injectable()
export class PushService {
  constructor(private readonly driverFactory: PushDriverFactory) {}

  send(platform: 'ios' | 'android', options: PushSendOptions): Promise<PushSendResult> {
    return this.driverFactory.getDriver(platform).send(options);
  }

  /**
   * Both real drivers (FCM, direct APNs) currently agree: neither provider exposes a server-side
   * idempotency key we can safely retry against, so a delivery whose provider call already
   * durably started is never safe to republish. If a future provider ever diverges, the stuck-
   * PROCESSING recovery claim in `push-dispatch.job.ts` would need to read this per-row (by that
   * row's device platform) rather than once per cycle — not needed today since the value is
   * identical for every platform.
   */
  get ambiguousDeliverySafeToRetry(): boolean {
    return this.driverFactory.getDriver('android').ambiguousDeliverySafeToRetry;
  }
}
