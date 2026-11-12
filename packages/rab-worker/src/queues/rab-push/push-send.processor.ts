import { randomUUID } from 'node:crypto';

import { Job, UnrecoverableError } from 'bullmq';

import { Notification } from '@rab/server/modules/notification/entities/notification.entity';
import { PushDevice } from '@rab/server/engine/core-modules/push/entities/push-device.entity';
import { PushDelivery } from '@rab/server/engine/core-modules/push/entities/push-delivery.entity';
import { PushSendError, PushSendResult } from '@rab/server/engine/core-modules/push/drivers/interfaces/push-driver.interface';
import { PushService } from '@rab/server/engine/core-modules/push/push.service';
import { PushDeviceService } from '@rab/server/engine/core-modules/push/push-device.service';
import { SecretEncryptionService } from '@rab/server/engine/core-modules/secret-encryption/secret-encryption.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { PushQueueJobData } from '@rab/server/engine/core-modules/push/push-queue.constants';
import { claimedAttemptFrom } from '../claimed-attempt';

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
 *
 * D-Q5b (owner confirmation OC-1, 2026-11-04): `attempt_count` is cumulative across dispatch generations — the claim adds 1
 * and returns it, ACCEPTED/RETRY/FAILED record it, and a row already at `max_attempts` is not claimed (see
 * `claimed-attempt.ts`). Before, every write used `job.attemptsMade + 1`, which restarted at 1 on each republish.
 */
export function createPushSendProcessor(deps: PushSendProcessorDeps) {
  return async function processPushSendJob(job: Job<PushQueueJobData>): Promise<void> {
    const { pushDeliveryId, organisationId } = job.data;
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: '', role: '' };
    const processingToken = randomUUID();

    const outcome = await deps.tenantContext.runInTenantContext(ctx, async (manager) => {
      const row = await manager.findOne(PushDelivery, { where: { id: pushDeliveryId } });
      // E8 (D0-C §3.3): not visible (yet) — a producer or claim that published before its commit, or a different binding.
      // Completing here would retain `push-delivery.<id>.attempt.0` as COMPLETED for 7 days, and the dispatcher's re-add of
      // that jobId would be silently dropped by BullMQ, stranding the row PENDING. Throw instead: BullMQ retries THIS job
      // (no add(), so no jobId dedupe) with its jittered backoff; a row that never appears exhausts the attempts and nothing
      // is sent. Same rule as email-send.processor.ts. A later republish keeps the `.attempt.<generation>` convention.
      if (!row) throw new Error(`push delivery row ${pushDeliveryId} is not visible yet — retrying`);
      if (row.status === 'ACCEPTED' || row.status === 'CANCELLED') return { skip: true as const };

      // D-Q5b (OC-1): the same CAS counts this attempt and returns the cumulative count; a row at its cap is not claimed.
      const claim = await manager
        .createQueryBuilder()
        .update(PushDelivery)
        .set({ status: 'PROCESSING', processingAt: () => 'now()', processingToken, attemptCount: () => 'attempt_count + 1' })
        .where('id = :id AND status IN (:...open) AND attempt_count < max_attempts', { id: row.id, open: ['PENDING', 'RETRY'] })
        .returning(['attemptCount', 'maxAttempts'])
        .execute();
      if (!claim.affected) return { skip: true as const };
      const attempt = claimedAttemptFrom(claim.raw, 'attempt_count', 'max_attempts');

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

      return { skip: false as const, row, device, notification, attempt };
    });

    if (outcome.skip) return;
    const { row, device, notification, attempt } = outcome;

    let result: PushSendResult;
    try {
      const token = deps.secretEncryption.decrypt(device.pushTokenEncrypted);
      result = await deps.pushService.send(device.platform, {
        token,
        title: 'Crewflow',
        body: 'You have a new notification. Tap to view.',
        data: { notificationId: notification.id, type: notification.type },
      });
    } catch (error) {
      const pushError = error instanceof PushSendError ? error : new PushSendError(sanitizeErrorMessage(error), true);
      if (pushError.invalidToken) {
        await deps.tenantContext.runInTenantContext(ctx, (manager) => deps.pushDeviceService.deactivateInvalidToken(manager, device.id));
      }
      const isFinal = !pushError.retryable || attempt.count >= attempt.max;
      const write = await deps.tenantContext.runInTenantContext(ctx, (manager) =>
        manager
          .createQueryBuilder()
          .update(PushDelivery)
          .set({
            status: isFinal ? 'FAILED' : 'RETRY',
            attemptCount: attempt.count,
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

    // Completion correctness: the provider ACCEPTED the push. A failure from here on is a persistence failure, never a
    // provider failure — classifying it as RETRY (as the single try/catch used to) would send a second real push.
    await persistAccepted(deps, ctx, row.id, processingToken, attempt.count, result);
  };
}

/**
 * Writes ACCEPTED (fenced by this attempt's token) with a short local retry for a transient database blip — mirrors
 * email-send.processor.ts's persistSent. If every try fails, it logs loudly and rethrows: the row stays PROCESSING under
 * this token with provider_call_started_at set, and the dispatcher's stale-PROCESSING recovery resolves it as
 * DELIVERY_UNCERTAIN (push is not safe to resend). A lost token (another claim owns the row) is a correct no-op.
 */
async function persistAccepted(
  deps: PushSendProcessorDeps,
  ctx: AuthContext,
  id: string,
  processingToken: string,
  attemptCount: number,
  result: PushSendResult,
): Promise<void> {
  const delays = [0, 100, 400];
  let lastError: unknown;
  for (const delayMs of delays) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      await deps.tenantContext.runInTenantContext(ctx, (manager) =>
        manager
          .createQueryBuilder()
          .update(PushDelivery)
          .set({ status: 'ACCEPTED', acceptedAt: () => 'now()', attemptCount, provider: result.provider, providerMessageId: result.providerMessageId ?? null })
          .where('id = :id AND status = :processing AND processing_token = :token', { id, processing: 'PROCESSING', token: processingToken })
          .execute(),
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  // eslint-disable-next-line no-console
  console.error(
    `push send: PROVIDER ACCEPTED (provider=${result.provider}) but persisting ACCEPTED for push delivery ${id} failed after ${delays.length} attempts. ` +
      'The row remains PROCESSING; recovery will resolve it as an uncertain delivery (no resend).',
    lastError,
  );
  throw lastError;
}
