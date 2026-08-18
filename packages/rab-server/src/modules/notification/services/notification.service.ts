import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { Notification } from '../entities/notification.entity';

export interface NotifyParams {
  organisationId: string;
  userId: string;
  type: string;
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
  constructor(private readonly tenantContext: TenantContextService) {}

  async notify(manager: EntityManager, params: NotifyParams): Promise<void> {
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
