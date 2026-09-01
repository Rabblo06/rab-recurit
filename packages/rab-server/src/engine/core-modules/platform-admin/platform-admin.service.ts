import { ConflictException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';

/**
 * Stage 2A Phase 2 — genuinely platform-wide (`core.platform_admin`, PK
 * `user_id`, no `organisation_id`, no `workspace_id`), not the retired
 * `platform_admin_claim` org-scoped "first user wins" mechanism. Deliberately
 * NOT a `PermissionFlag` — if platform-admin were grantable through the
 * ordinary role/permission-override system, any user holding
 * `user.manage_permissions` could self-grant it via the existing
 * `user_permission_override` endpoint, defeating the entire point of a
 * protected, explicitly-granted status. Every check reads
 * `core.is_active_platform_admin(uuid)`, a SECURITY DEFINER SQL function
 * (see `PlatformAdminGlobalRedesign1786669400000`) — never a raw `SELECT`
 * against the table, since that table's own SELECT policy only shows a
 * caller their own row (or every row if they're already an admin), which
 * would make a query for an ARBITRARY other user's status resolve
 * incorrectly for a non-admin caller.
 *
 * Full replacement, not additive: this service no longer has any notion of
 * "sees everything in my org unconditionally." That behaviour retired along
 * with `platform_admin_claim` — a platform admin's own ordinary Dashboard/
 * Search/list calls are scoped exactly like anyone else's now; cross-
 * workspace/cross-org visibility is available only through the audited
 * Admin Inspect mechanism (`AdminInspectService`), which rebuilds
 * `AuthContext` to an explicit target identity rather than granting a
 * blanket bypass.
 */
@Injectable()
export class PlatformAdminService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
  ) {}

  async isPlatformAdmin(ctx: Pick<AuthContext, 'userId'>): Promise<boolean> {
    return this.tenantContext.runInTenantContext(
      { organisationId: null, workspaceId: null, userId: ctx.userId, role: '' },
      (manager) => this.isPlatformAdminTx(manager, ctx),
    );
  }

  /**
   * Same check, for a caller that already has an open transaction's
   * `manager` from its own `runInTenantContext` block — avoids opening a
   * second, independent transaction just to answer "is this actor a
   * platform admin?" mid-request.
   */
  async isPlatformAdminTx(manager: EntityManager, ctx: Pick<AuthContext, 'userId'>): Promise<boolean> {
    const rows = await manager.query<Array<{ is_active_platform_admin: boolean }>>(
      `SELECT core.is_active_platform_admin($1) AS is_active_platform_admin`,
      [ctx.userId],
    );
    return rows[0]?.is_active_platform_admin ?? false;
  }

  /**
   * Guarded grant/revoke — only callable by an existing active platform
   * admin (enforced both here, service-layer, and again at the RLS
   * `WITH CHECK` layer via `core.is_active_platform_admin()`, CLAUDE.md's
   * "layer 2 is the one people skip" rule). The very first grant can never
   * go through this method (there is no existing admin yet to authorize
   * it) — that's what the `grant-platform-admin` bootstrap CLI is for,
   * which writes directly as `rab_owner`, bypassing this table's
   * (deliberately NOT FORCEd) RLS entirely.
   *
   * Idempotent: granting an already-active admin, or revoking an already-
   * inactive one, succeeds without changing `grantedAt`/`revokedAt` again —
   * `ON CONFLICT ... DO UPDATE ... WHERE` and a plain conditional `UPDATE`
   * both no-op cleanly rather than erroring.
   */
  async grant(actorCtx: Pick<AuthContext, 'userId' | 'organisationId'>, targetUserId: string): Promise<{ granted: boolean }> {
    // Bound to the ACTOR's own organisation, not `null` — `platform_admin`'s
    // own policies never reference `current_org()` so this binding doesn't
    // affect them either way, but it's what lets the audit row below
    // satisfy `audit_log`'s own `organisation_id NOT NULL`/FORCEd tenant
    // policy in the same transaction (that table predates the platform-wide
    // concept `platform_admin` itself is, and has no workspace-free storage
    // location of its own — see `grant-platform-admin.command.ts`'s
    // identical trade-off for the bootstrap-CLI case).
    return this.tenantContext.runInTenantContext(
      { organisationId: actorCtx.organisationId, workspaceId: null, userId: actorCtx.userId, role: '' },
      async (manager) => {
        const isAdmin = await this.isPlatformAdminTx(manager, actorCtx);
        if (!isAdmin) throw new ConflictException('Only an existing platform administrator can grant platform admin status.');

        const result = await manager.query<Array<{ user_id: string }>>(
          `INSERT INTO core.platform_admin (user_id, granted_by)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE
             SET granted_at = now(), granted_by = $2, revoked_at = NULL, revoked_by = NULL
             WHERE core.platform_admin.revoked_at IS NOT NULL
           RETURNING user_id`,
          [targetUserId, actorCtx.userId],
        );
        const granted = result.length > 0;
        if (granted) {
          await this.auditService.record(manager, actorCtx, AuditAction.PLATFORM_ADMIN_GRANTED, { targetUserId });
        }
        return { granted };
      },
    );
  }

  async revoke(actorCtx: Pick<AuthContext, 'userId' | 'organisationId'>, targetUserId: string): Promise<{ revoked: boolean }> {
    return this.tenantContext.runInTenantContext(
      { organisationId: actorCtx.organisationId, workspaceId: null, userId: actorCtx.userId, role: '' },
      async (manager) => {
        const isAdmin = await this.isPlatformAdminTx(manager, actorCtx);
        if (!isAdmin) throw new ConflictException('Only an existing platform administrator can revoke platform admin status.');

        const [, rowCount] = await manager.query<[unknown[], number]>(
          `UPDATE core.platform_admin SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
          [targetUserId, actorCtx.userId],
        );
        const revoked = rowCount > 0;
        if (revoked) {
          await this.auditService.record(manager, actorCtx, AuditAction.PLATFORM_ADMIN_REVOKED, { targetUserId });
        }
        return { revoked };
      },
    );
  }
}
