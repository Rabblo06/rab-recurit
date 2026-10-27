import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../audit/audit.service';
import { StepUpReauthService } from '../auth/services/step-up-reauth.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { isUuid, refuseInspection, requireReason } from './admin-actor';
import { AdminInspectService } from './admin-inspect.service';
import { revokeSessionsForPrivilegedGrant } from './privileged-grant-session-reset';

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
    private readonly stepUpReauth: StepUpReauthService,
    private readonly adminInspect: AdminInspectService,
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
   * Guarded grant/revoke — only callable by an existing active platform admin (enforced here, service-layer, and again
   * at the RLS `WITH CHECK` layer via `core.is_active_platform_admin()`, CLAUDE.md's "layer 2 is the one people skip").
   * The very first grant can never go through this method (there is no existing admin yet to authorize it) — that is
   * what the `grant-platform-admin` / `bootstrap-admin` CLIs are for.
   *
   * Idempotent: granting an already-active admin, or revoking an already-inactive one, changes nothing and writes no
   * audit row (`{granted:false}` / `{revoked:false}`).
   *
   * Admin panel follow-up (B3, owner-approved 2026-10-25), in this order, each step throwing (fail closed):
   *   1. Admin Inspect refused; 2. the actor is an ACTIVE platform admin (layer 2); 3. a reason (trimmed, 3–500) → 400;
   *   4. revoke only: never yourself → 409 `PLATFORM_ADMIN_SELF_REMOVAL`;
   *   5. a recent step-up of THIS session (`assertRecentStepUp`, 'platform.admin.grant' / 'platform.admin.revoke'):
   *      a password step-up, an SSO re-authentication (so an admin WITHOUT a password can act) or a fresh sign-in, plus
   *      the actor's own code ONLY when the actor is enrolled — there is no "actor must have MFA" rule. This replaces the
   *      inline-password path (`assertCurrentPassword`), which an SSO-only admin could never satisfy;
   *   6. one transaction holding `PLATFORM_ADMIN_MEMBERSHIP_LOCK` (`pg_advisory_xact_lock`): every grant/revoke is
   *      serialised, the actor's status is re-read UNDER the lock, and a revoke that would leave no active platform admin
   *      is refused → 409 `LAST_PLATFORM_ADMIN`. Two admins revoking each other at the same moment therefore cannot both
   *      succeed: the second one runs after the first one's commit and is refused because it is no longer an admin (403;
   *      `platform_admin`'s SELECT policy then shows it only its own row). With "never yourself" plus that re-check, an
   *      active actor always remains, so `LAST_PLATFORM_ADMIN` is defence in depth for a future caller (e.g. a CLI that
   *      acts for an actor who is not itself an admin row) rather than a path today's routes can reach.
   * Grant ends every session and refresh token the target holds in the same transaction (CF-07,
   * `revokeSessionsForPrivilegedGrant`); revoke ends the demoted admin's inspect sessions (CF-02). Both audit rows carry
   * the reason.
   */
  async grant(actorCtx: PlatformAdminActor, targetUserId: string, input: { reason?: unknown }): Promise<{ granted: boolean; revokedSessions: number }> {
    const reason = await this.preflight(actorCtx, input);
    if (!isUuid(targetUserId)) throw new NotFoundException('User not found.');
    await this.stepUpReauth.assertRecentStepUp(stepUpCtxOf(actorCtx), 'platform.admin.grant');
    // Bound to the ACTOR's own organisation: `platform_admin`'s own policies never reference `current_org()`, but the audit
    // row must satisfy `audit_log`'s FORCEd `organisation_id = current_org()` policy in the same transaction.
    return this.tenantContext.runInTenantContext(
      { organisationId: actorCtx.organisationId, workspaceId: null, userId: actorCtx.userId, role: '' },
      async (manager) => {
        await lockMembership(manager);
        if (!(await this.isPlatformAdminTx(manager, actorCtx))) throw notAnAdmin();
        // The target must be a real user (the DEFINER function restores the caller's binding itself).
        const [membership] = await manager.query<Array<{ organisation_id: string }>>(`SELECT organisation_id FROM core.resolve_membership_for_user($1)`, [targetUserId]);
        if (!membership) throw new NotFoundException('User not found.');

        const result = await manager.query<Array<{ user_id: string }>>(
          `INSERT INTO core.platform_admin (user_id, granted_by)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE
             SET granted_at = now(), granted_by = $2, revoked_at = NULL, revoked_by = NULL,
                 security_version = core.platform_admin.security_version + 1
             WHERE core.platform_admin.revoked_at IS NOT NULL
           RETURNING user_id`,
          [targetUserId, actorCtx.userId],
        );
        if (result.length === 0) return { granted: false, revokedSessions: 0 };
        // CF-07: no pre-existing (longer-lived, lower-privilege) session survives the promotion.
        const { revokedSessions } = await revokeSessionsForPrivilegedGrant(manager, targetUserId);
        await this.auditService.record(manager, actorCtx, AuditAction.PLATFORM_ADMIN_GRANTED, { targetUserId, metadata: { reason, revokedSessions } });
        return { granted: true, revokedSessions };
      },
    );
  }

  /** See `grant()`: same order, plus never yourself and never the last active platform admin (race-safe). */
  async revoke(actorCtx: PlatformAdminActor, targetUserId: string, input: { reason?: unknown }): Promise<{ revoked: boolean }> {
    const reason = await this.preflight(actorCtx, input);
    if (!isUuid(targetUserId)) throw new NotFoundException('User not found.');
    if (targetUserId === actorCtx.userId) {
      throw new ConflictException({ code: 'PLATFORM_ADMIN_SELF_REMOVAL', message: 'You can’t remove yourself as a platform admin. Ask another platform admin to do it.' });
    }
    await this.stepUpReauth.assertRecentStepUp(stepUpCtxOf(actorCtx), 'platform.admin.revoke');
    return this.tenantContext.runInTenantContext(
      { organisationId: actorCtx.organisationId, workspaceId: null, userId: actorCtx.userId, role: '' },
      async (manager) => {
        await lockMembership(manager);
        // Under the lock. READ COMMITTED: each statement below sees every grant/revoke committed before we got the lock.
        const [counts] = await manager.query<Array<{ target_active: boolean; others: number }>>(
          `SELECT EXISTS (SELECT 1 FROM core.platform_admin WHERE user_id = $1 AND revoked_at IS NULL) AS target_active,
                  (SELECT count(*)::int FROM core.platform_admin WHERE user_id <> $1 AND revoked_at IS NULL) AS others`,
          [targetUserId],
        );
        if (counts?.target_active && Number(counts.others) === 0) {
          throw new ConflictException({ code: 'LAST_PLATFORM_ADMIN', message: 'This is the last platform admin. Add another platform admin first.' });
        }
        if (!(await this.isPlatformAdminTx(manager, actorCtx))) throw notAnAdmin();
        if (!counts?.target_active) return { revoked: false };

        const [, rowCount] = await manager.query<[unknown[], number]>(
          `UPDATE core.platform_admin SET revoked_at = now(), revoked_by = $2, security_version = security_version + 1
           WHERE user_id = $1 AND revoked_at IS NULL`,
          [targetUserId, actorCtx.userId],
        );
        if (rowCount === 0) return { revoked: false };
        // CF-02: a demoted admin's open inspect sessions end in the same transaction (the guard's per-request
        // current-authority check already refuses them; this removes the rows too).
        const endedInspectSessions = await this.adminInspect.endAllForAdminTx(manager, targetUserId);
        await this.auditService.record(manager, actorCtx, AuditAction.PLATFORM_ADMIN_REVOKED, { targetUserId, metadata: { reason, endedInspectSessions } });
        return { revoked: true };
      },
    );
  }

  /** Steps 1–3 of grant/revoke: inspect refused, layer-2 admin check (a check that throws denies), reason. */
  private async preflight(actorCtx: PlatformAdminActor, input: { reason?: unknown } | undefined): Promise<string> {
    refuseInspection(actorCtx);
    let allowed = false;
    try {
      allowed = Boolean(actorCtx?.userId) && (await this.isPlatformAdmin(actorCtx));
    } catch {
      allowed = false;
    }
    if (!allowed) throw notAnAdmin();
    return requireReason(input?.reason);
  }
}

export type PlatformAdminActor = Pick<AuthContext, 'userId' | 'organisationId'> & Partial<Pick<AuthContext, 'workspaceId' | 'sessionId' | 'inspectedBy'>>;

/**
 * Transaction-scoped advisory lock key serialising every platform-admin grant/revoke (B3). A constant ("crewpa01" as a
 * 64-bit integer), so it never collides with the hash-derived keys of the worker's locks; released at COMMIT/ROLLBACK.
 */
export const PLATFORM_ADMIN_MEMBERSHIP_LOCK = '7165901520760811569';

async function lockMembership(manager: EntityManager): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock($1::bigint)', [PLATFORM_ADMIN_MEMBERSHIP_LOCK]);
}

function stepUpCtxOf(actorCtx: PlatformAdminActor) {
  return { organisationId: actorCtx.organisationId, workspaceId: actorCtx.workspaceId ?? null, userId: actorCtx.userId, sessionId: actorCtx.sessionId, inspectedBy: actorCtx.inspectedBy };
}

function notAnAdmin(): ForbiddenException {
  return new ForbiddenException('Only an active platform administrator can change platform admins.');
}
