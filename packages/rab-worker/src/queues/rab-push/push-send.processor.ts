import { randomUUID } from 'node:crypto';

import { Job, UnrecoverableError } from 'bullmq';

import { Notification } from '@rab/server/modules/notification/entities/notification.entity';
import { PushDevice } from '@rab/server/engine/core-modules/push/entities/push-device.entity';
import { PushDelivery } from '@rab/server/engine/core-modules/push/entities/push-delivery.entity';
import { PushSendError } from '@rab/server/engine/core-modules/push/drivers/interfaces/push-driver.interface';
import { PushService } from '@rab/server/engine/core-modules/push/push.service';
import { PushDeviceService } from '@rab/server/engine/core-modules/push/push-device.service';
import { SecretEncryptionService } from '@rab/server/engine/core-modules/secret-encryption/secret-encryption.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { PushQueueJobData } from '@rab/server/engine/core-modules/push/push-queue.constants';

const MAX_ERROR_MESSAGE_LENGTH = 500;

export interface PushSendProcessorDeps {
  tenantContext: TenantContextService;
  pushService: PushService;
  secretEncryption: SecretEncryptionService;
  pushDeviceService: PushDeviceService;
}

function sanitizeErrorMessage(error: unknown): string {
  const message = (error as { message?: string })?.message ?? String(error);
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * The BullMQ processor — one call per delivery attempt, mirrors `email-send.processor.ts`'s own
 * claim/fence/revalidate/provider-call-boundary/persist shape exactly.
 *
 * PAYLOAD MINIMALITY (Stage 6 §6): the push body sent to the provider is DELIBERATELY generic —
 * never `Notification.title`/`.message` verbatim (those can embed venue names, staff names,
 * decline reasons — ordinary business content, not secrets, but still more than a push payload
 * travelling through a third-party provider's transit infrastructure needs to carry). `data`
 * carries only `notificationId`/`type` — enough for the app to deep-link and then fetch the real
 * content through the ALREADY-AUTHENTICATED `/notifications` API, never from the push payload
 * itself.
 */
export function createPushSendProcessor(deps: PushSendProcessorDeps) {
  return async function processPushSendJob(job: Job<PushQueueJobData>): Promise<void> {
    const { pushDeliveryId, organisationId } = job.data;
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: '', role: '' };
    const processingToken = randomUUID();

    const outcome = await deps.tenantContext.runInTenantContext(ctx, async (manager) => {
      const row = await manager.findOne(PushDelivery, { where: { id: pushDeliveryId } });
      if (!row) return { skip: true as const };
      if (row.status === 'ACCEPTED' || row.status === 'CANCELLED') return { skip: true as const };

      const claim = await manager
        .createQueryBuilder()
        .update(PushDelivery)
        .set({ status: 'PROCESSING', processingAt: () => 'now()', processingToken })
        .where('id = :id AND status IN (:...open)', { id: row.id, open: ['PENDING', 'RETRY'] })
        .execute();
      if (!claim.affected) return { skip: true as const };

      // Revalidate authoritative state immediately before sending (A9/A10-style, same discipline
      // as email's own revalidate()): the device may have been deactivated, or the notification
      // itself may have been superseded, in the window between creation and this claim.
      const device = await manager.findOne(PushDevice, { where: { id: row.pushDeviceId }, select: ['id', 'active', 'pushTokenEncrypted', 'platform'] });
      if (!device || !device.active) {
        await manager
          .createQueryBuilder()
          .update(PushDelivery)
          .set({ status: 'CANCELLED', cancelledAt: () => 'now()', lastErrorMessageSanitized: 'device no longer active' })
          .where('id = :id AND status = :processing AND processing_token = :token', { id: row.id, processing: 'PROCESSING', token: processingToken })
          .execute();
        return { skip: true as const };
      }
      const notification = await manager.findOne(Notification, { where: { id: row.notificationId } });
      if (!notification) {
        await manager
          .createQueryBuilder()
          .update(PushDelivery)
          .set({ status: 'CANCELLED', cancelledAt: () => 'now()', lastErrorMessageSanitized: 'notification no longer exists' })
          .where('id = :id AND status = :processing AND processing_token = :token', { id: row.id, processing: 'PROCESSING', token: processingToken })
          .execute();
        return { skip: true as const };
      }

      await manager
        .createQueryBuilder()
        .update(PushDelivery)
        .set({ providerCallStartedAt: () => 'now()' })
        .where('id = :id AND status = :processing AND processing_token = :token', { id: row.id, processing: 'PROCESSING', token: processingToken })
        .execute();

      return { skip: false as const, row, device, notification };
    });

    if (outcome.skip) return;
    const { row, device, notification } = outcome;

    try {
      const token = deps.secretEncryption.decrypt(device.pushTokenEncrypted);
      const result = await deps.pushService.send(device.platform, {
        token,
        title: 'Crewflow',
        body: 'You have a new notification. Tap to view.',
        data: { notificationId: notification.id, type: notification.type },
      });
      await deps.tenantContext.runInTenantContext(ctx, (manager) =>
        manager
          .createQueryBuilder()
          .update(PushDelivery)
          .set({ status: 'ACCEPTED', acceptedAt: () => 'now()', attemptCount: job.attemptsMade + 1, provider: result.provider, providerMessageId: result.providerMessageId ?? null })
          .where('id = :id AND status = :processing AND processing_token = :token', { id: row.id, processing: 'PROCESSING', token: processingToken })
          .execute(),
      );
    } catch (error) {
      const pushError = error instanceof PushSendError ? error : new PushSendError(sanitizeErrorMessage(error), true);
      if (pushError.invalidToken) {
        await deps.tenantContext.runInTenantContext(ctx, (manager) => deps.pushDeviceService.deactivateInvalidToken(manager, device.id));
      }
      const isFinal = !pushError.retryable || job.attemptsMade + 1 >= row.maxAttempts;
      const write = await deps.tenantContext.runInTenantContext(ctx, (manager) =>
        manager
          .createQueryBuilder()
          .update(PushDelivery)
          .set({
            status: isFinal ? 'FAILED' : 'RETRY',
            attemptCount: job.attemptsMade + 1,
            lastErrorCode: pushError.code ?? null,
            lastErrorMessageSanitized: sanitizeErrorMessage(pushError),
            ...(isFinal ? { failedAt: () => 'now()' } : {}),
          })
          .where('id = :id AND status = :processing AND processing_token = :token', { id: row.id, processing: 'PROCESSING', token: processingToken })
          .execute(),
      );
      if (!write.affected) return; // lease lost — nothing more to correctly write
      if (isFinal) throw new UnrecoverableError(pushError.message);
      throw pushError;
    }
  };
}
