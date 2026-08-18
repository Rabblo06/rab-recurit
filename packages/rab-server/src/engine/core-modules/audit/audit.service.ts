import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditLog } from '../../../modules/identity/entities';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';

/**
 * Values are `subject.verb`, dot-separated — this is the contract
 * `TimelinePanel.tsx`/`AuditLog.tsx` were already built against
 * (`action.split('.')` to derive a subject/verb pair) before either had a
 * real backend route. Keep new actions in this shape; don't reintroduce
 * uppercase-underscore names.
 */
export const AuditAction = {
  USER_CREATED: 'user.created',
  INVITE_EMAIL_SENT: 'user.invited',
  PASSWORD_CHANGED: 'password.changed',
  PASSWORD_RESET_REQUESTED: 'password.reset_requested',
  PASSWORD_RESET_COMPLETED: 'password.reset_completed',
  ADMIN_PASSWORD_RESET: 'password.admin_reset',
  OFFER_SENT: 'offer.sent',
  OFFER_ACCEPTED: 'offer.accepted',
  OFFER_DECLINED: 'offer.declined',
  OFFER_CONFIRMED: 'offer.confirmed',
  OFFER_REJECTED: 'offer.rejected',
  OFFER_WITHDRAWN: 'offer.withdrawn',
  OFFER_EXPIRED: 'offer.expired',
} as const;
export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditLogListItem {
  id: string;
  action: string;
  actor: { fullName: string } | null;
  metadata: Record<string, unknown>;
  targetType: string | null;
  targetId: string | null;
  createdAt: Date;
}

/**
 * `record()` takes an already-open, tenant-bound `EntityManager` rather
 * than opening its own transaction (mirrors `RefreshTokenService`'s shape)
 * — every current call site already runs inside `runInTenantContext` for
 * the business-logic write it's auditing (e.g. `staff.service.ts`'s
 * `create()`), so the audit row lands in the same transaction and either
 * both commit or neither does. `audit_log` is FORCEd RLS and insert-only
 * at the DB grant level (CLAUDE.md) — this is the only write path for it
 * in the app.
 *
 * Never pass a password, token, or token hash in `metadata`.
 */
@Injectable()
export class AuditService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async record(
    manager: EntityManager,
    ctx: Pick<AuthContext, 'organisationId' | 'userId'>,
    action: AuditActionType,
    opts: { targetUserId?: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<void> {
    const entry = manager.create(AuditLog, {
      organisationId: ctx.organisationId!,
      actorUserId: ctx.userId,
      targetUserId: opts.targetUserId,
      entityType: opts.entityType,
      entityId: opts.entityId,
      action,
      metadata: opts.metadata ?? {},
    });
    await manager.save(entry);
  }

  /**
   * Backs `GET /audit-logs` — the read side `TimelinePanel.tsx`/`AuditLog.tsx`
   * were already built against. `entityType`/`entityId` together scope this
   * to one entity's activity (e.g. one offer); omitted, it's the org-wide
   * feed. `targetType`/`targetId` in the response fall back to `'user'`/
   * `targetUserId` for the account-lifecycle actions that predate the
   * polymorphic columns.
   */
  async list(
    ctx: AuthContext,
    opts: { page?: number; limit?: number; entityType?: string; entityId?: string } = {},
  ): Promise<{ items: AuditLogListItem[]; page: number; limit: number }> {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
    const offset = (page - 1) * limit;

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (opts.entityType) {
        params.push(opts.entityType);
        conditions.push(`al.entity_type = $${params.length}`);
      }
      if (opts.entityId) {
        params.push(opts.entityId);
        conditions.push(`al.entity_id = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit, offset);

      const rows = await manager.query(
        `
          SELECT al.id, al.action, al.metadata, al.entity_type, al.entity_id, al.target_user_id, al.created_at,
                 u.first_name AS actor_first_name, u.last_name AS actor_last_name
          FROM core.audit_log al
          LEFT JOIN core."user" u ON u.id = al.actor_user_id
          ${where}
          ORDER BY al.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params,
      );

      const items: AuditLogListItem[] = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        action: r.action as string,
        actor: r.actor_first_name ? { fullName: `${r.actor_first_name} ${r.actor_last_name}` } : null,
        metadata: (r.metadata as Record<string, unknown>) ?? {},
        targetType: (r.entity_type as string) ?? (r.target_user_id ? 'user' : null),
        targetId: (r.entity_id as string) ?? (r.target_user_id as string) ?? null,
        createdAt: r.created_at as Date,
      }));

      return { items, page, limit };
    });
  }
}
