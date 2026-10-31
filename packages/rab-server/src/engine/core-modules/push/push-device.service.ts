import { Injectable } from '@nestjs/common';

import { SecretEncryptionService } from '../secret-encryption/secret-encryption.service';
import { TenantContextService } from '../tenant/tenant-context.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { PushDevice } from './entities/push-device.entity';
import { deactivateAllPushDevicesForUser, deactivatePushDeviceForUser } from './push-device-deactivation';

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

      // C1b (D5): the SAME user's other active row carrying this exact provider token is the same phone under an older
      // installation id (e.g. the mobile app's 32-hex → UUID device-id migration, or a reinstall); keeping both would
      // double-deliver and leave one that logout can never name. Tokens are encrypted non-deterministically, so they are
      // compared after decryption — only over this one user's own active rows (a handful).
      const others = await manager
        .createQueryBuilder(PushDevice, 'd')
        .addSelect('d.pushTokenEncrypted') // `select: false` on the entity
        .where('d.user_id = :userId AND d.device_id <> :deviceId AND d.active = true', { userId: ctx.userId, deviceId: params.deviceId })
        .getMany();
      for (const other of others) {
        let sameToken = false;
        try {
          sameToken = this.secretEncryption.decrypt(other.pushTokenEncrypted) === params.pushToken;
        } catch {
          sameToken = false; // an undecryptable old token is left alone (the provider will report it invalid)
        }
        if (sameToken) await manager.update(PushDevice, { id: other.id }, { active: false, deactivatedAt: now, deactivatedReason: 'superseded_by_new_device_id' });
      }

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

  /**
   * One device of the caller, by the client's own explicit `POST /push/devices/:deviceId/deactivate` call. Idempotent —
   * an already-inactive or unknown device is a silent no-op, never a 404 (mirrors `ProfileService`'s own session-revoke
   * tolerance for an already-gone row). Logout itself can do the same server-side, in the logout transaction, when the
   * client sends `pushDeviceId` (`AuthService.logout`).
   */
  async deactivate(ctx: AuthContext, deviceId: string, reason: string): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, (manager) => deactivatePushDeviceForUser(manager, ctx.userId, deviceId, reason));
  }

  /**
   * Every device of the caller, by the client's own explicit `POST /push/devices/deactivate-all` call. This endpoint is
   * NOT what makes revocation safe: the server deactivates registrations itself, inside the revoking transaction, via
   * `push-device-deactivation.ts` — every session revoked (`RefreshTokenService.revokeAllForUser`: password change/reset,
   * account suspension, sign-out-everywhere, deletion), the last live session revoked (`revokeFamily`), organisation
   * suspension (`revokeAllForOrganisation`), platform-admin sign-out-everywhere and workspace-access suspension.
   * Revoking ONE other session while others stay live does not touch devices (no session → device link yet).
   */
  async deactivateAll(ctx: AuthContext, reason: string): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, (manager) => deactivateAllPushDevicesForUser(manager, ctx.userId, reason));
  }

  /** Marks a device as having a confirmed-dead token (FCM's own unregistered/invalid-token classification) — separate from a user-initiated deactivate, so the reason is always honest in audit/debugging. */
  async deactivateInvalidToken(manager: import('typeorm').EntityManager, pushDeviceId: string): Promise<void> {
    await manager.update(PushDevice, { id: pushDeviceId }, { active: false, deactivatedAt: new Date(), deactivatedReason: 'provider_reported_invalid_token' });
  }
}
