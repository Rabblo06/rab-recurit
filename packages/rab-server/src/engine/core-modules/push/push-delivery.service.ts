import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EnvironmentService } from '../environment/environment.service';
import { PushDevice } from './entities/push-device.entity';
import { PushDelivery } from './entities/push-delivery.entity';

export interface CreatePushDeliveryParams {
  organisationId: string;
  userId: string;
  notificationId: string;
}

/**
 * Fans one `Notification` out to a `push_delivery` row per currently-`active` device for that
 * user — called from `NotificationService.notify()`, inside the SAME `manager`/transaction the
 * `Notification` row itself is written in (Stage 6 §2/§3: "every required durable notification
 * should be created atomically with the relevant business mutation"). Never triggered by, or
 * dependent on, Redis/the real-time outbox — a `push_delivery` row is as durable as the
 * `Notification` row it fans out from, full stop.
 *
 * Deliberately does NOT read or decrypt any device's push token here — that only happens inside
 * the worker's send processor, immediately before calling the provider, keeping the decrypted
 * token's lifetime as short as possible and out of this request-path code entirely.
 */
@Injectable()
export class PushDeliveryService {
  constructor(private readonly env: EnvironmentService) {}

  async createForNotification(manager: EntityManager, params: CreatePushDeliveryParams): Promise<number> {
    if (!this.env.get('PUSH_ENABLED')) return 0;

    const devices = await manager.find(PushDevice, {
      where: { userId: params.userId, active: true },
      select: ['id'], // never select pushTokenEncrypted here — this path never needs it
    });
    if (devices.length === 0) return 0;

    const maxAttempts = this.env.get('PUSH_DELIVERY_MAX_ATTEMPTS');
    const rows = devices.map((device) =>
      manager.create(PushDelivery, {
        organisationId: params.organisationId,
        notificationId: params.notificationId,
        pushDeviceId: device.id,
        maxAttempts,
      }),
    );
    await manager.save(rows);
    return rows.length;
  }
}
