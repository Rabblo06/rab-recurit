import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditLog } from '../../../modules/identity/entities';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { PlatformAdminService } from '../platform-admin/platform-admin.service';

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
  USER_LOGOUT: 'user.logout',
  PROFILE_UPDATED: 'profile.updated',
  WORKSPACE_UPDATED: 'workspace.updated',
  WORKSPACE_SUBDOMAIN_CHANGED: 'workspace.subdomain_changed',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_PERMISSIONS_UPDATED: 'role.permissions_updated',
  PLATFORM_CONFIG_SMTP_UPDATED: 'platform_config.smtp_updated',
  PLATFORM_CONFIG_MAINTENANCE_MODE_CHANGED: 'platform_config.maintenance_mode_changed',
  MANAGER_VENUE_ASSIGNED: 'manager.venue_assigned',
  MANAGER_VENUE_UNASSIGNED: 'manager.venue_unassigned',
  CEO_CREATED: 'manager.ceo_created',
  ADMIN_INSPECT_STARTED: 'admin.inspect_started',
  ADMIN_INSPECT_ENDED: 'admin.inspect_ended',
  STAFF_CLOCKED_IN: 'attendance.clocked_in',
  STAFF_CLOCKED_OUT: 'attendance.clocked_out',
  STAFF_SUSPENSION_NOTICE_SENT: 'staff.suspension_notice_sent',
  MANAGER_WORKSPACE_CREATED: 'manager_workspace.created',
  MANAGER_WORKSPACE_SUBDOMAIN_CHANGED: 'manager_workspace.subdomain_changed',
  MANAGER_WORKSPACE_UPDATED: 'manager_workspace.updated',
  MANAGER_WORKSPACE_ONBOARDING_COMPLETED: 'manager_workspace.onboarding_completed',
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
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly platformAdmin: PlatformAdminService,
  ) {}

  async record(
    manager: EntityManager,
    ctx: Pick<AuthContext, 'organisationId' | 'userId' | 'inspectedBy'>,
    action: AuditActionType,
    opts: { targetUserId?: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<void> {
    // While an admin is inspecting another user, `ctx.userId` is the target
    // (so scoped reads look right) but the ACTOR of record must stay the
    // real human — `inspectedBy` is only ever set by JwtAuthGuard from an
    // already-re-verified session, never client-supplied on its own.
    const actorUserId = ctx.inspectedBy ?? ctx.userId;
    const metadata = ctx.inspectedBy ? { ...(opts.metadata ?? {}), inspectedTargetUserId: ctx.userId } : (opts.metadata ?? {});
    const entry = manager.create(AuditLog, {
      organisationId: ctx.organisationId!,
      actorUserId,
      targetUserId: opts.targetUserId,
      entityType: opts.entityType,
      entityId: opts.entityId,
      action,
      metadata,
    });
    await manager.save(entry);
  }

  /**
   * Backs `GET /audit-logs` — the read side `TimelinePanel.tsx`/`AuditLog.tsx`
   * were already built against. `entityType`/`entityId` together scope this
   * to one entity's activity (e.g. one offer). `AUDIT_VIEW` is held by the
   * default `manager` role, so without actor-scoping any manager could read
   * every other manager's actions org-wide — a side channel around the
   * per-manager ownership model (staff.service.ts's `assertOwnedOrAdmin`
   * and friends). A non-platform-admin caller only ever sees entries where
   * they are the actor; the platform admin sees the full org-wide feed.
   * `targetType`/`targetId` in the response fall back to `'user'`/
   * `targetUserId` for the account-lifecycle actions that predate the
   * polymorphic columns.
   */
  async list(
    ctx: AuthContext,
    opts: { page?: number; limit?: number; entityType?: string; entityId?: string } = {},
  ): Promise<{ items: AuditLogListItem[]; page: number; limit: number }> {
    const page = Math.max(1, opts.page ?? 1);
    // 500 matches AuditLog.tsx's full-page browse request; TimelinePanel.tsx's
    // side-drawer feed asks for the smaller default (100).
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const offset = (page - 1) * limit;

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const isAdmin = await this.platformAdmin.isPlatformAdminTx(manager, ctx);

      const conditions: string[] = [];
      const params: unknown[] = [];
      if (!isAdmin) {
        params.push(ctx.userId);
        conditions.push(`al.actor_user_id = $${params.length}`);
      }
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
