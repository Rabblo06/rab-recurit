import { EmailOutboxStatus } from '@rab/shared';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EmailOutbox, User } from '../../../modules/identity/entities';
import { AuditAction, AuditService } from '../audit/audit.service';
import { PlatformAdminService } from '../platform-admin/platform-admin.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { RefreshTokenService } from '../auth/token/services/refresh-token.service';
import { SchemaResolverService, WorkspaceRoutingError, workspaceSchemaName } from '../tenant/schema-resolver.service';

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
    private readonly schemaResolver: SchemaResolverService,
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

    const blockingReason = await this.findProtectedHistoryInEverySchema(manager, ctx, targetUserId);
    if (blockingReason) {
      throw new UserDeletionBlockedException(
        'USER_HAS_PROTECTED_HISTORY',
        'This account has historical workforce records and cannot be permanently deleted. Suspend the account instead.',
      );
    }
  }

  /**
   * Part C1 (HWS-AUDIT.md §0.1, BROKEN 4.6): the protected-history check in EVERY schema the target can have rows in, not
   * only the one the caller's transaction happens to be bound to. With one schema per workspace, a workspace-less CEO's
   * transaction reads the `core` copies and a workspace-bound caller reads only its own schema, so history in another
   * workspace's schema was invisible — and the deletion then cascaded (`staff_profile.user_id` ON DELETE CASCADE and
   * everything hanging off it), set attribution to NULL (`job_offer.created_by` ON DELETE SET NULL) or failed on a raw FK
   * error instead of the structured 409.
   *
   * Order, all inside the caller's own transaction (one snapshot per statement, no second connection, never nested):
   *   1. the scope the transaction is already bound to (unchanged behaviour);
   *   2. for every candidate workspace W of the caller's organisation (below): rab.workspace_id bound to W so the
   *      workspace-tenant RLS predicates (`workspace_id = core.current_workspace()`) can match, then
   *        a. the `core` copies (search_path 'core': the authoritative data with HWS off, the pre-cutover copies with it on —
   *           a hard delete would cascade into those too), and
   *        b. W's own schema when its registry row resolves READY (search_path = the resolved, validated name;
   *           SchemaResolverService is the only source of that name). No registry row → no schema, nothing to check. A
   *           registry row that is not READY (or any other routing refusal) while the schema exists in the catalogue → the
   *           delete is refused ('workspace_schema_unverifiable'): data in a schema that cannot be checked is never deleted
   *           blind (fail closed).
   *   3. rab.workspace_id and search_path restored to their values on entry (only on the success path; any throw aborts
   *      the transaction anyway).
   * Candidate workspaces: every workspace of the organisation the caller can see under RLS (an organisation-wide
   * `manager.manage` holder — the ManagerService.deleteUser route — sees all of them), plus the target's own workspace(s)
   * from `manager_profile` and `workspace_membership`, plus the caller's bound workspace. Same-organisation is guaranteed:
   * the lookup is pinned to ctx.organisationId and every row carries a composite same-organisation key.
   * RESIDUAL (not changed here, see C1-STATUS.md): RLS still decides what a check can see inside a schema — a caller who is
   * not a manager of W cannot see W's `staff_profile` rows, and `payroll_record` is visible only to a payroll manager; the
   * no-ON-DELETE foreign keys still refuse those deletes at the database layer, a staff profile's CASCADE does not.
   */
  private async findProtectedHistoryInEverySchema(manager: EntityManager, ctx: AuthContext, userId: string): Promise<string | null> {
    const here = await this.findProtectedHistory(manager, userId);
    if (here) return here;
    if (!ctx.organisationId) return null;

    const [entry] = await manager.query<Array<{ ws: string | null; sp: string }>>(
      `SELECT current_setting('rab.workspace_id', true) AS ws, current_setting('search_path') AS sp`,
    );
    const candidates = await manager.query<Array<{ workspace_id: string }>>(
      `SELECT id AS workspace_id FROM core.manager_workspace WHERE organisation_id = $1
       UNION SELECT workspace_id FROM core.manager_profile WHERE organisation_id = $1 AND user_id = $2 AND workspace_id IS NOT NULL
       UNION SELECT workspace_id FROM core.workspace_membership WHERE organisation_id = $1 AND user_id = $2 AND workspace_id IS NOT NULL
       ORDER BY 1`,
      [ctx.organisationId, userId],
    );
    const workspaceIds = new Set(candidates.map((row) => row.workspace_id));
    if (ctx.workspaceId) workspaceIds.add(ctx.workspaceId);

    let found: string | null = null;
    for (const workspaceId of workspaceIds) {
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true), set_config('search_path', 'core', true)`, [workspaceId]);
      found = await this.findProtectedHistory(manager, userId);
      if (found) break;
      const schema = await this.checkableWorkspaceSchema(manager, workspaceId);
      if (schema === 'unverifiable') {
        found = 'workspace_schema_unverifiable';
        break;
      }
      if (schema) {
        await manager.query(`SELECT set_config('search_path', $1, true)`, [schema]);
        found = await this.findProtectedHistory(manager, userId);
        if (found) break;
      }
    }
    await manager.query(`SELECT set_config('rab.workspace_id', $1, true), set_config('search_path', $2, true)`, [entry?.ws ?? '', entry?.sp ?? 'core']);
    return found;
  }

  /** W's READY schema name (validated by SchemaResolverService), null when W has no schema, 'unverifiable' otherwise. */
  private async checkableWorkspaceSchema(manager: EntityManager, workspaceId: string): Promise<string | null | 'unverifiable'> {
    try {
      return await this.schemaResolver.resolve(manager, workspaceId);
    } catch (error) {
      if (!(error instanceof WorkspaceRoutingError)) throw error;
      const [{ present }] = await manager.query<Array<{ present: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS present`,
        [workspaceSchemaName(workspaceId)],
      );
      return present ? 'unverifiable' : null;
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
      ['shift_created_by', `SELECT 1 FROM shift WHERE created_by = $1 LIMIT 1`],
      ['job_role_created_by', `SELECT 1 FROM job_role WHERE created_by = $1 LIMIT 1`],
      ['venue_created_by', `SELECT 1 FROM venue WHERE created_by = $1 LIMIT 1`],
      // payroll_record.approved_by / rejected_by are no-ON-DELETE FKs to core.user (a decision is evidence). Only visible
      // to a workspace payroll manager under RLS; when hidden, the FK itself still refuses the delete (fail closed).
      ['payroll_decision_actor', `SELECT 1 FROM payroll_record WHERE approved_by = $1 OR rejected_by = $1 LIMIT 1`],
      // attendance.clock_in_by / clock_out_by: the Venue Manager of an on-behalf punch (no-ON-DELETE FKs; evidence).
      ['attendance_on_behalf_actor', `SELECT 1 FROM attendance WHERE clock_in_by = $1 OR clock_out_by = $1 LIMIT 1`],
      [
        'job_offer_actor',
        `SELECT 1 FROM job_offer WHERE created_by = $1 OR confirmed_by = $1 OR rejected_by = $1 LIMIT 1`,
      ],
      [
        'staff_operational_history',
        `SELECT 1 FROM staff_profile sp
           WHERE sp.user_id = $1
             AND (
               EXISTS (SELECT 1 FROM shift_assignment sa WHERE sa.staff_profile_id = sp.id)
               OR EXISTS (SELECT 1 FROM job_offer jo WHERE jo.staff_profile_id = sp.id)
               OR EXISTS (SELECT 1 FROM attendance at WHERE at.staff_profile_id = sp.id)
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
    await this.refreshTokenService.revokeAllForUser(manager, targetUserId, 'account_deleted');

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
