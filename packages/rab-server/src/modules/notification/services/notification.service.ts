import { NotificationTypeType } from '@rab/shared';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EmailService } from '../../../engine/core-modules/email/email.service';
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
 * In-app only this pass — no push provider, no WebSocket. `notify()` takes
 * an already-open, tenant-bound `EntityManager` (mirrors `AuditService.record`)
 * so the notification lands in the same transaction as the state change
 * it's about: either both commit or neither does. This is the correct
 * on-ramp for a future outbox-based dispatcher — the call site doesn't
 * change, only what wraps it.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly emailService: EmailService,
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
        try {
          await this.emailService.send({
            to: user.email,
            subject: params.title,
            html: `<p>${params.message}</p>`,
            text: params.message,
          });
        } catch (error) {
          // Best-effort — an SMTP outage must not roll back the state
          // change (offer sent/accepted/etc.) this notification is about.
          this.logger.error(`Notification email failed to send to ${user.email}`, error as Error);
        }
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
