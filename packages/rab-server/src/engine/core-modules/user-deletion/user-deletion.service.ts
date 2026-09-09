import { EmailOutboxStatus } from '@rab/shared';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EmailOutbox, User } from '../../../modules/identity/entities';
import { AuditAction, AuditService } from '../audit/audit.service';
import { PlatformAdminService } from '../platform-admin/platform-admin.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { RefreshTokenService } from '../auth/token/services/refresh-token.service';

/**
 * Codes the frontend maps to a specific, safe message — never the raw FK
 * detail (per B11: "distinguish deleted / blocked due protected history /
 * blocked due workspace ownership / not authorized / not found").
 */
export type UserDeletionBlockCode =
  | 'USER_HAS_PROTECTED_HISTORY'
  | 'MANAGER_OWNS_WORKSPACE'
  | 'CANNOT_DELETE_SELF'
  | 'CANNOT_DELETE_PLATFORM_ADMIN';

export class UserDeletionBlockedException extends ConflictException {
  constructor(public readonly code: UserDeletionBlockCode, message: string) {
    super({ statusCode: 409, code, message });
  }
}

/**
 * Centralised, entity-agnostic deletion policy — the ONE place a hard
 * `DELETE FROM core."user"` is ever issued, called from both
 * `ManagerService.deleteUser()` and `StaffService.deleteUser()` AFTER each
 * has already run its own existing authorization check (StaffService's
 * creator-private `assertOwned`, ManagerService's org-wide MANAGER_MANAGE +
 * CEO carve-out) — this service never re-derives "is the caller allowed to
 * target this user," only "is deleting this specific user actually safe."
 *
 * Deliberately does NOT trust the DB's own CASCADE/RESTRICT behaviour as
 * the primary control — several of `core.user`'s FKs (`staff_profile.
 * user_id`, and everything that hangs off `staff_profile` in turn —
 * `shift_assignment`, `job_offer`, `attendance` — all CASCADE) would
 * SILENTLY DESTROY real operational/payroll history with zero DB-level
 * pushback if this service didn't check first. The `RESTRICT`/no-`ON
 * DELETE` FKs on the Manager side (`shift.created_by`, `job_offer.
 * confirmed_by`/`rejected_by`, `venue.created_by`, `job_role.created_by`,
 * `platform_admin.user_id`) DO already block at the DB layer — this
 * service checks those proactively too, purely so the caller gets a clean,
 * structured 409 instead of a raw Postgres FK-violation 500.
 */
@Injectable()
export class UserDeletionService {
  constructor(
    private readonly auditService: AuditService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly platformAdmin: PlatformAdminService,
  ) {}

  /**
   * Throws a `UserDeletionBlockedException` (409) if deletion isn't safe;
   * resolves silently otherwise. Never mutates anything — pure check.
   *
   * Both the platform-admin and workspace-ownership checks below read
   * through a `SECURITY DEFINER` function (`core.is_active_platform_admin`,
   * `core.user_owns_manager_workspace`), NEVER a raw `SELECT` against either
   * table directly — both tables' own RLS SELECT policy only shows a caller
   * their OWN row, which would make a query for the TARGET's status resolve
   * to "not found" every time the caller isn't the target (i.e. always, in
   * practice, since `CANNOT_DELETE_SELF` already rejected that case). See
   * `UserOwnsManagerWorkspaceCheck1786670300000`'s own doc comment for the
   * full security-finding writeup of the bug this replaced.
   */
  async assertCanDelete(manager: EntityManager, ctx: AuthContext, targetUserId: string): Promise<void> {
    if (targetUserId === ctx.userId) {
      throw new UserDeletionBlockedException('CANNOT_DELETE_SELF', 'You cannot delete your own account.');
    }

    const isPlatformAdmin = await this.platformAdmin.isPlatformAdminTx(manager, { userId: targetUserId });
    if (isPlatformAdmin) {
      throw new UserDeletionBlockedException('CANNOT_DELETE_PLATFORM_ADMIN', 'This account holds the platform administrator claim and cannot be deleted.');
    }

    const ownsWorkspaceRows = await manager.query<Array<{ user_owns_manager_workspace: boolean }>>(
      `SELECT core.user_owns_manager_workspace($1) AS user_owns_manager_workspace`,
      [targetUserId],
    );
    if (ownsWorkspaceRows[0]?.user_owns_manager_workspace) {
      throw new UserDeletionBlockedException('MANAGER_OWNS_WORKSPACE', 'This manager owns a private Workspace and cannot be deleted. Suspend the account instead.');
    }

    const blockingReason = await this.findProtectedHistory(manager, targetUserId);
    if (blockingReason) {
      throw new UserDeletionBlockedException(
        'USER_HAS_PROTECTED_HISTORY',
        'This account has historical workforce records and cannot be permanently deleted. Suspend the account instead.',
      );
    }
  }

  /**
   * Every real, operational reference to this user that a raw DELETE would
   * either silently cascade away (staff-side: shift_assignment, job_offer,
   * attendance, all via staff_profile CASCADE) or get correctly rejected
   * for at the DB layer anyway (manager-side: shift/job_offer/venue/
   * job_role `created_by` chains, all RESTRICT/no-ON-DELETE). Checked
   * uniformly regardless of whether the target is Staff or Manager — a
   * never-activated account structurally can't have created any of this
   * (every write path requires an authenticated session, which requires
   * ACTIVE), so in practice this only ever blocks a genuinely-operational
   * account, never a pending/cancelled/expired invite.
   */
  private async findProtectedHistory(manager: EntityManager, userId: string): Promise<string | null> {
    const checks: Array<[string, string]> = [
      ['shift_created_by', `SELECT 1 FROM core.shift WHERE created_by = $1 LIMIT 1`],
      ['job_role_created_by', `SELECT 1 FROM core.job_role WHERE created_by = $1 LIMIT 1`],
      ['venue_created_by', `SELECT 1 FROM core.venue WHERE created_by = $1 LIMIT 1`],
      [
        'job_offer_actor',
        `SELECT 1 FROM core.job_offer WHERE created_by = $1 OR confirmed_by = $1 OR rejected_by = $1 LIMIT 1`,
      ],
      [
        'staff_operational_history',
        `SELECT 1 FROM core.staff_profile sp
           WHERE sp.user_id = $1
             AND (
               EXISTS (SELECT 1 FROM core.shift_assignment sa WHERE sa.staff_profile_id = sp.id)
               OR EXISTS (SELECT 1 FROM core.job_offer jo WHERE jo.staff_profile_id = sp.id)
               OR EXISTS (SELECT 1 FROM core.attendance at WHERE at.staff_profile_id = sp.id)
             )
           LIMIT 1`,
      ],
    ];

    for (const [reason, sql] of checks) {
      const rows = await manager.query(sql, [userId]);
      if (rows.length > 0) return reason;
    }
    return null;
  }

  /**
   * Actually deletes — call only after `assertCanDelete` has already
   * passed (both `ManagerService.deleteUser`/`StaffService.deleteUser`
   * call it first; this doesn't re-check, so it must never be exposed as
   * its own reachable entry point). Order matters: sessions revoked and
   * pending email cancelled BEFORE the row disappears, so nothing racing
   * this transaction can observe a half-deleted account, and the worker's
   * own defense-in-depth revalidation (email-send.processor.ts) is backed
   * up by this proactive cancel, not relied on alone (Part C).
   */
  async deleteUser(manager: EntityManager, ctx: AuthContext, targetUserId: string, targetEmail: string): Promise<void> {
    await this.refreshTokenService.revokeAllForUser(manager, targetUserId);

    await manager
      .createQueryBuilder()
      .update(EmailOutbox)
      .set({ status: EmailOutboxStatus.CANCELLED, cancelledAt: () => 'now()' })
      .where('target_user_id = :targetUserId AND status IN (:...open)', {
        targetUserId,
        open: [EmailOutboxStatus.PENDING, EmailOutboxStatus.QUEUED, EmailOutboxStatus.PROCESSING, EmailOutboxStatus.RETRY],
      })
      .execute();

    // Written BEFORE the delete, with `targetUserId` omitted (not merely
    // left to go NULL later) — `audit_log.target_user_id` is a real FK
    // (`ON DELETE SET NULL`), which governs what happens to an EXISTING
    // row when its target later disappears, not whether a NEW row may be
    // inserted referencing an id that's already gone. Inserting after the
    // delete with `targetUserId: targetUserId` would be a live FK
    // violation. The deleted user's id/email survive in `metadata` instead
    // — same idiom `account-invite-cleanup.job.ts` already established for
    // its own `user.invite_cleaned_up` entry.
    await this.auditService.record(manager, ctx, AuditAction.USER_DELETED, {
      metadata: { deletedUserId: targetUserId, deletedUserEmail: targetEmail },
    });

    // AccountInvite/PasswordResetToken/RefreshToken/OrganisationMember/
    // UserRole/UserPermissionOverride/Notification/UserPreference/
    // AdminInspectSession/ManagerProfile/StaffProfile all CASCADE from
    // `user_id` — verified against every migration that FKs to core.user
    // before this service was written (see its own doc comment); nothing
    // protected can still be attached by the time this runs, since
    // `assertCanDelete` already rejected anything that would make this
    // unsafe.
    await manager.delete(User, { id: targetUserId });
  }
}
