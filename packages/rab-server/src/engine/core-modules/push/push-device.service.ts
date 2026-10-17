import { Injectable } from '@nestjs/common';

import { SecretEncryptionService } from '../secret-encryption/secret-encryption.service';
import { TenantContextService } from '../tenant/tenant-context.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { PushDevice } from './entities/push-device.entity';

export interface RegisterDeviceParams {
  deviceId: string;
  platform: 'ios' | 'android';
  pushToken: string;
  appVersion?: string;
}

/**
 * Device/installation registration — identity (`userId`/`organisationId`) is ALWAYS taken from
 * `ctx` (the verified, server-derived `AuthContext` a guard already produced), never from the
 * request body (Stage 6 §5: "Do not trust userId, organisationId or workspaceId submitted by
 * Flutter"). `deviceId` is the only client-supplied identifier this service trusts, and only as
 * an OPAQUE key to upsert against — it carries no authority of its own (the same existing
 * convention `RefreshTokenService`/`core.user_session` already use for this exact field).
 */
@Injectable()
export class PushDeviceService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly secretEncryption: SecretEncryptionService,
  ) {}

  /**
   * Upserts on `(userId, deviceId)` — a registration refresh/replacement (a rotated FCM token,
   * the same physical device) updates the existing row's token in place; it never creates a
   * second row for the same device (Stage 6 §4: "registration refresh and replacement").
   */
  async register(ctx: AuthContext, params: RegisterDeviceParams): Promise<{ id: string }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const encrypted = this.secretEncryption.encrypt(params.pushToken);
      const existing = await manager.findOne(PushDevice, { where: { userId: ctx.userId, deviceId: params.deviceId } });
      const now = new Date();
      // CF-35: one physical device delivers for one account at a time. When B signs in on a phone A used, A's
      // registration for that device stops, so B never receives A's notifications (shared or second-hand phones).
      await manager
        .createQueryBuilder()
        .update(PushDevice)
        .set({ active: false, deactivatedAt: now, deactivatedReason: 'device_registered_by_another_account' })
        .where('device_id = :deviceId AND user_id <> :userId AND active = true', { deviceId: params.deviceId, userId: ctx.userId })
        .execute();

      if (existing) {
        await manager.update(PushDevice, { id: existing.id }, {
          platform: params.platform,
          pushTokenEncrypted: encrypted,
          appVersion: params.appVersion ?? null,
          active: true,
          lastSeenAt: now,
          deactivatedAt: null,
          deactivatedReason: null,
        });
        return { id: existing.id };
      }

      const created = manager.create(PushDevice, {
        organisationId: ctx.organisationId!,
        userId: ctx.userId,
        deviceId: params.deviceId,
        platform: params.platform,
        pushTokenEncrypted: encrypted,
        appVersion: params.appVersion ?? null,
        registeredAt: now,
        lastSeenAt: now,
      });
      await manager.save(created);
      return { id: created.id };
    });
  }

  /** One device, on explicit single-device logout. Idempotent — deactivating an already-inactive or unknown device is a silent no-op, never a 404 (mirrors `ProfileService`'s own session-revoke tolerance for an already-gone row). */
  async deactivate(ctx: AuthContext, deviceId: string, reason: string): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager.update(PushDevice, { userId: ctx.userId, deviceId }, { active: false, deactivatedAt: new Date(), deactivatedReason: reason }),
    );
  }

  /** Every device for this user — "logout all" / session revocation / account suspension. */
  async deactivateAll(ctx: AuthContext, reason: string): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager
        .createQueryBuilder()
        .update(PushDevice)
        .set({ active: false, deactivatedAt: new Date(), deactivatedReason: reason })
        .where('user_id = :userId AND active = true', { userId: ctx.userId })
        .execute(),
    );
  }

  /** Marks a device as having a confirmed-dead token (FCM's own unregistered/invalid-token classification) — separate from a user-initiated deactivate, so the reason is always honest in audit/debugging. */
  async deactivateInvalidToken(manager: import('typeorm').EntityManager, pushDeviceId: string): Promise<void> {
    await manager.update(PushDevice, { id: pushDeviceId }, { active: false, deactivatedAt: new Date(), deactivatedReason: 'provider_reported_invalid_token' });
  }
}
