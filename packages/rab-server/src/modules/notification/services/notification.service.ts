import { EmailOutboxJobType, NotificationTypeType } from '@rab/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EmailOutboxService } from '../../../engine/core-modules/email/email-outbox.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { NotificationPreference, User } from '../../identity/entities';
import { Notification } from '../entities/notification.entity';

export interface NotifyParams {
  organisationId: string;
  userId: string;
  type: NotificationTypeType;
  title: string;
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

/**
 * In-app + (preference-gated) email — no push provider, no WebSocket yet.
 * `notify()` takes an already-open, tenant-bound `EntityManager` (mirrors
 * `AuditService.record`) so both the in-app row and the durable outbox row
 * land in the same transaction as the state change they're about: either
 * all three commit or none does.
 *
 * The email side previously called `EmailService.send()` inline,
 * synchronously, inside this same request — a direct SMTP/API call sitting
 * inside a critical HTTP path (offer sent/accepted/etc.), best-effort
 * try/catch swallowed on failure. Now it durably enqueues instead (same
 * `EmailOutboxService`/dispatcher/worker path every other email type in
 * this app already uses) and relies on the dispatcher's ~2s poll loop
 * rather than a request-time fast-publish — `notify()` is called from deep
 * inside other services' own transactions (`OfferService`), which don't
 * hand back a commit hook this method could use to fire a fast-publish
 * itself, and a couple of seconds' added latency for an in-app-first
 * notification email is an acceptable trade for not re-plumbing 6 call
 * sites. The actual SMTP/API call now always happens in the worker
 * process, never in this request.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly emailOutbox: EmailOutboxService,
  ) {}

  /**
   * Consults `notification_preference` before doing anything — both
   * in-app and email delivery are real, preference-gated behaviour, not a
   * dead settings toggle. Defaults (in-app on, email off) match no row
   * existing yet, mirroring ProfileService.listNotificationPreferences.
   */
  async notify(manager: EntityManager, params: NotifyParams): Promise<void> {
    const preference = await manager.findOne(NotificationPreference, {
      where: { userId: params.userId, notificationType: params.type },
    });
    const inAppEnabled = preference?.inAppEnabled ?? true;
    const emailEnabled = preference?.emailEnabled ?? false;

    if (inAppEnabled) {
      const entry = manager.create(Notification, {
        organisationId: params.organisationId,
        userId: params.userId,
        type: params.type,
        title: params.title,
        message: params.message,
        relatedEntityType: params.relatedEntityType,
        relatedEntityId: params.relatedEntityId,
      });
      await manager.save(entry);
    }

    if (emailEnabled) {
      const user = await manager.findOne(User, { where: { id: params.userId } });
      if (user) {
        await this.emailOutbox.enqueue(manager, {
          organisationId: params.organisationId,
          jobType: EmailOutboxJobType.NOTIFICATION,
          recipientEmail: user.email,
          targetUserId: params.userId,
          rendered: { subject: params.title, html: `<p>${params.message}</p>`, text: params.message },
        });
      }
    }
  }

  list(ctx: AuthContext): Promise<Notification[]> {
    return this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager.find(Notification, {
        where: { userId: ctx.userId },
        order: { createdAt: 'DESC' },
        take: 50,
      }),
    );
  }

  unreadCount(ctx: AuthContext): Promise<{ count: number }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const count = await manager
        .createQueryBuilder(Notification, 'n')
        .where('n.user_id = :userId', { userId: ctx.userId })
        .andWhere('n.read_at IS NULL')
        .getCount();
      return { count };
    });
  }

  async markRead(ctx: AuthContext, id: string): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const result = await manager.update(Notification, { id, userId: ctx.userId }, { readAt: new Date() });
      if (!result.affected) throw new NotFoundException('Notification not found.');
    });
  }

  async markAllRead(ctx: AuthContext): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager
        .createQueryBuilder()
        .update(Notification)
        .set({ readAt: new Date() })
        .where('user_id = :userId', { userId: ctx.userId })
        .andWhere('read_at IS NULL')
        .execute(),
    );
  }
}
