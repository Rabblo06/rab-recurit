import { assertTransition, EmailOutboxStatus, USER_STATUS_TRANSITIONS, UserStatus, UserStatusType } from '@rab/shared';
import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';

import { EmailOutbox, User } from '../../../modules/identity/entities';
import { AuditAction, AuditService } from '../audit/audit.service';
import { PlatformAdminService } from '../platform-admin/platform-admin.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { RefreshTokenService } from '../auth/token/services/refresh-token.service';
import { AccountInviteService } from '../auth/services/account-invite.service';
import { SecurityVersionService } from '../auth/services/security-version.service';
import { FileService } from '../storage/file.service';
import { StoredFile } from '../storage/entities/stored-file.entity';
import { WorkspaceMembershipService } from '../tenant/workspace-membership.service';
import { bindBusinessSchema, businessSearchPath, businessTables, CORE_BUSINESS_SCHEMA, restoreBusinessSchema, snapshotBusinessSchema } from '../tenant/business-tables';
import { SchemaResolverService, WorkspaceRoutingError, workspaceSchemaName } from '../tenant/schema-resolver.service';
import { clearWorkspaceUserReferences, workspaceRestrictReference } from '../core-references/workspace-user-references';

/**
 * Codes the frontend maps to a specific, safe message — never the raw FK detail. Since owner decision 0g (2026-11-14) a
 * delete no longer refuses because of history (history means a SOFT delete); the remaining refusals are the account-level
 * gates below, plus USER_NOT_DELETED for an erasure of an account that was not deleted first.
 */
export type UserDeletionBlockCode =
  | 'MANAGER_OWNS_WORKSPACE'
  | 'CANNOT_DELETE_SELF'
  | 'CANNOT_DELETE_PLATFORM_ADMIN'
  | 'USER_NOT_DELETED';

export class UserDeletionBlockedException extends ConflictException {
  constructor(public readonly code: UserDeletionBlockCode, message: string) {
    super({ statusCode: 409, code, message });
  }
}

/** What `deleteUser` did: the row is kept (soft) or gone (only a never-activated invite with no history). */
export type UserDeletionOutcome = 'soft_deleted' | 'hard_deleted';

/** The anonymised values GDPR erasure writes into core."user" (the row and its id stay, so history keeps resolving). */
export const ERASED_FIRST_NAME = 'Deleted';
export const ERASED_LAST_NAME = 'user';
export const erasedEmailFor = (userId: string): string => `erased+${userId}@deleted.invalid`;

/** Thrown inside the hard-delete savepoint only: the never-activated invite turned out not to be safe to remove → soft delete. */
class HardDeleteNotSafe extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

interface TargetRow {
  readonly id: string;
  readonly email: string;
  readonly status: UserStatusType;
  readonly deleted: boolean;
  readonly erased: boolean;
  readonly avatar_file_id: string | null;
  readonly never_activated: boolean;
}

/** One place the hard-delete history checks can see rows: the transaction's bound scope, or a workspace W's `core` copy / own schema. */
interface CheckScope {
  readonly label: string;
}

/**
 * User deletion, the Twenty way (owner decision 0g, 2026-11-14). Re-implemented (AGPL: never copied) from
 * twentyhq/twenty @ eedb0a73 `packages/twenty-server/src/engine/core-modules/user/services/user.service.ts`:
 *   - `deleteUser` (:259-283): remove every workspace membership, then SOFT delete the user row (`softDelete`, :275) and
 *     invalidate the user cache (:276; here the callers' `invalidateUserDisplay` after commit). The row stays, so
 *     everything that references it keeps resolving.
 *   - `removeUserFromWorkspaceAndPotentiallyDeleteWorkspace` (:325-431): refuse to remove the last admin of a workspace
 *     (`assertUserWorkspaceIsNotUniqueAdminOrThrow`, :353, mapped to CANNOT_DELETE_LAST_ADMIN_USER). Crewflow's "only
 *     admin" of a workspace is its OWNER (exactly one per workspace, `manager_workspace.owner_user_id`; the member
 *     administrator IS the owner, MemberInvitationService.isWorkspaceAdministratorTx), so the existing MANAGER_OWNS_WORKSPACE
 *     refusal is the last-admin check, kept unchanged, with the platform-admin and self refusals.
 * Crewflow differences, all deliberate: a hard delete is still allowed for a never-activated invite with no history (owner
 * 0g); every session and credential is revoked in the same transaction; per-workspace memberships are SUSPENDED (no
 * application write path may delete core.workspace_membership or set it to 'removed'; see USER-DELETION.md for the optional
 * definer draft).
 *
 * The ONE place a user is deleted from an API path. Called by `ManagerService.deleteUser` and `StaffService.deleteUser`
 * AFTER each has run its own authorisation (StaffService's creator-private `assertOwned`, ManagerService's org-wide
 * MANAGER_MANAGE + CEO carve-out). This service re-runs the account-level gates itself (layer 2: a job or another service
 * calling it directly gets the same refusals) and never trusts a caller-supplied e-mail or status: it reads and locks the
 * target row first.
 *
 * Must run directly in the caller's tenant transaction — never inside a savepoint or a block that catches and continues:
 * the hard-delete attempt opens its own savepoint and rolls it back on purpose; any other throw is meant to abort the whole
 * transaction.
 */
@Injectable()
export class UserDeletionService {
  private readonly logger = new Logger(UserDeletionService.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly schemaResolver: SchemaResolverService,
    private readonly securityVersion: SecurityVersionService,
    private readonly workspaceMembership: WorkspaceMembershipService,
    private readonly accountInvite: AccountInviteService,
    private readonly fileService: FileService,
  ) {}

  /**
   * The account-level gates (409): never yourself, never the platform administrator, never the last admin (the workspace
   * owner: deleting them would orphan the workspace). Reads through the SECURITY DEFINER lookups
   * `core.is_active_platform_admin` / `core.user_owns_manager_workspace`: both tables' own RLS shows a caller only their OWN
   * row (UserOwnsManagerWorkspaceCheck1786670300000). Never mutates anything.
   */
  async assertCanDelete(manager: EntityManager, ctx: AuthContext, targetUserId: string): Promise<void> {
    if (targetUserId === ctx.userId || (ctx.inspectedBy && targetUserId === ctx.inspectedBy)) {
      throw new UserDeletionBlockedException('CANNOT_DELETE_SELF', 'You cannot delete your own account.');
    }
    if (await this.platformAdmin.isPlatformAdminTx(manager, { userId: targetUserId })) {
      throw new UserDeletionBlockedException('CANNOT_DELETE_PLATFORM_ADMIN', 'This account holds the platform administrator claim and cannot be deleted.');
    }
    const [owns] = await manager.query<Array<{ owns: boolean }>>(`SELECT core.user_owns_manager_workspace($1) AS owns`, [targetUserId]);
    if (owns?.owns) {
      throw new UserDeletionBlockedException('MANAGER_OWNS_WORKSPACE', 'This manager owns a Workspace and cannot be deleted while they own it.');
    }
  }

  /**
   * Deletes the account. A never-activated invite (status invited / invite_expired, never signed in, no refresh token or
   * session ever: the Worker cleanup's own NEVER_ACTIVATED predicate) with no history anywhere is hard-deleted; every other
   * account, and any invite whose hard delete turns out not to be safe, is SOFT deleted: the row stays with `deleted_at`
   * set, so shifts, attendance, payroll and audit history keep their references. Unknown, another organisation's or an
   * already-deleted account → 404.
   */
  async deleteUser(manager: EntityManager, ctx: AuthContext, targetUserId: string): Promise<UserDeletionOutcome> {
    assertNotInspecting(ctx);
    const target = await this.lockTarget(manager, ctx, targetUserId);
    if (!target || target.deleted) throw new NotFoundException('User not found.');
    await this.assertCanDelete(manager, ctx, target.id);

    if (target.never_activated && (await this.tryHardDelete(manager, ctx, target))) return 'hard_deleted';
    await this.softDelete(manager, ctx, target);
    return 'soft_deleted';
  }

  /**
   * GDPR erasure (owner 0g): a separate, explicit action on an account that is ALREADY soft-deleted. Anonymises every
   * personal field of the core."user" row (name, e-mail, phone, avatar pointer + the stored file tombstoned, password
   * hashes, e-mail-verification time) and keeps the row and its id, so payroll / attendance / shift history still resolve
   * and now show "Deleted user". TOTP secret and recovery codes were already cleared by the soft delete. Copies of personal
   * data OUTSIDE core."user" (audit metadata, login history, e-mail outbox, staff profile, identity links) are listed for
   * the owner in USER-DELETION.md and are not touched here. Idempotent: an erased row is left as it is.
   */
  async erasePersonalData(manager: EntityManager, ctx: AuthContext, targetUserId: string): Promise<void> {
    assertNotInspecting(ctx);
    const target = await this.lockTarget(manager, ctx, targetUserId);
    if (!target) throw new NotFoundException('User not found.');
    if (!target.deleted) {
      throw new UserDeletionBlockedException('USER_NOT_DELETED', 'Delete this account before erasing its personal data.');
    }
    if (target.erased) return;

    await manager.query(
      `UPDATE core."user"
          SET first_name = $3, last_name = $4, email = $5, phone = NULL, avatar_file_id = NULL, avatar_key = NULL,
              password_hash = NULL, temporary_password_hash = NULL, email_verified_at = NULL, updated_at = now()
        WHERE id = $1 AND organisation_id = $2 AND deleted_at IS NOT NULL`,
      [target.id, ctx.organisationId, ERASED_FIRST_NAME, ERASED_LAST_NAME, erasedEmailFor(target.id)],
    );
    if (target.avatar_file_id) {
      const file = await manager.findOne(StoredFile, { where: { id: target.avatar_file_id } });
      if (file) await this.fileService.tombstone(manager, file, { removeObject: false });
    }
    await this.auditService.record(manager, ctx, AuditAction.USER_PERSONAL_DATA_ERASED, { targetUserId: target.id });
  }

  /** The target, row-locked for the rest of the transaction (a concurrent delete / erase / reactivate waits). Deleted rows included. */
  private async lockTarget(manager: EntityManager, ctx: AuthContext, targetUserId: string): Promise<TargetRow | null> {
    if (!ctx.organisationId) return null;
    const [row] = await manager.query<TargetRow[]>(
      `SELECT u.id, u.email::text AS email, u.status, u.deleted_at IS NOT NULL AS deleted, u.avatar_file_id,
              u.email OPERATOR(public.=) $3::public.citext AS erased,
              (u.status IN ('invited', 'invite_expired') AND u.last_login_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM core.refresh_token rt WHERE rt.user_id = u.id)
               AND NOT EXISTS (SELECT 1 FROM core.user_session us WHERE us.user_id = u.id)) AS never_activated
         FROM core."user" u
        WHERE u.id = $1 AND u.organisation_id = $2
        FOR UPDATE OF u`,
      [targetUserId, ctx.organisationId, erasedEmailFor(targetUserId)],
    );
    return row ?? null;
  }

  /**
   * Soft delete (Twenty user.service.ts:275). In this transaction the account loses every way in and every membership:
   * TOTP + recovery codes cleared (core.mfa_disable), security version bumped (every cached auth snapshot is stale at once),
   * workspace memberships suspended, roles and permission overrides removed, organisation membership revoked, every refresh
   * token / web session / push device revoked, open invites and password-reset links made unusable, OIDC identity links
   * removed, open e-mail cancelled, then status → deactivated (terminal; invite_expired keeps its own terminal status) and
   * `deleted_at` set. Touches only this user's rows: no other user's row and no workspace table (pg_locks test in
   * user-soft-delete.integration.spec.ts).
   */
  private async softDelete(manager: EntityManager, ctx: AuthContext, target: TargetRow): Promise<void> {
    const orgId = ctx.organisationId!;
    const nextStatus = this.softDeletedStatus(target.status);
    await manager.query(`SELECT core.mfa_disable($1::uuid)`, [target.id]);
    await this.securityVersion.bumpUser(manager, target.id);
    await this.workspaceMembership.suspendForUser(manager, target.id);
    await manager.query(`DELETE FROM core.user_role WHERE user_id = $1 AND organisation_id = $2`, [target.id, orgId]);
    await manager.query(`DELETE FROM core.user_permission_override WHERE user_id = $1 AND organisation_id = $2`, [target.id, orgId]);
    await manager.query(
      `UPDATE core.organisation_member SET status = 'revoked', updated_at = now() WHERE user_id = $1 AND organisation_id = $2 AND status = 'active'`,
      [target.id, orgId],
    );
    await this.refreshTokenService.revokeAllForUser(manager, target.id, 'account_deleted');
    await this.accountInvite.revokeActive(manager, target.id);
    await manager.query(`UPDATE core.password_reset_token SET used_at = now() WHERE user_id = $1 AND organisation_id = $2 AND used_at IS NULL`, [target.id, orgId]);
    // OIDC identity links (they also hold the verified e-mail snapshot) — the same definer EmailChangeService.confirm uses.
    // An open e-mail-change request needs no write here: EmailChangeService.confirm cancels it for any non-active account
    // (and core.email_change_request writes stay with their owning service, tools/check-protected-table-writes.cjs).
    await manager.query(`SELECT core.unlink_provider_identities_for_user($1)`, [target.id]);
    await this.cancelOpenEmail(manager, target.id);
    await manager.query(
      `UPDATE core."user" SET status = $3, deleted_at = now(), updated_at = now() WHERE id = $1 AND organisation_id = $2 AND deleted_at IS NULL`,
      [target.id, orgId, nextStatus],
    );
    // The row stays, so the audit row names its target directly; no personal data in the metadata.
    await this.auditService.record(manager, ctx, AuditAction.USER_DELETED, { targetUserId: target.id, metadata: { deletion: 'soft' } });
  }

  /** deactivated where the account state machine allows it; invite_expired is already terminal and cannot sign in. */
  private softDeletedStatus(current: UserStatusType): UserStatusType {
    if (current === UserStatus.DEACTIVATED || current === UserStatus.INVITE_EXPIRED) return current;
    assertTransition(USER_STATUS_TRANSITIONS, current, UserStatus.DEACTIVATED);
    return UserStatus.DEACTIVATED;
  }

  private async cancelOpenEmail(manager: EntityManager, targetUserId: string): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(EmailOutbox)
      .set({ status: EmailOutboxStatus.CANCELLED, cancelledAt: () => 'now()' })
      .where('target_user_id = :targetUserId AND status IN (:...open)', {
        targetUserId,
        open: [EmailOutboxStatus.PENDING, EmailOutboxStatus.QUEUED, EmailOutboxStatus.PROCESSING, EmailOutboxStatus.RETRY],
      })
      .execute();
  }

  /**
   * Hard delete of a never-activated invite, inside its own savepoint. The pre-0g history checks are kept for this path
   * only, because a hard delete cascades (`staff_profile.user_id` ON DELETE CASCADE and everything hanging off it) and an
   * invited staff member can already have been offered or assigned a shift. Any sign that the delete is not safe — history
   * in any scope (the bound one, every workspace's core copy and READY schema), a workspace schema that cannot be checked,
   * operational history that disappeared with an invisible staff profile (C1b L1), a no-ON-DELETE foreign key the checks
   * could not see (23503), or the lock table / lock timeout giving out on the referencing tables (53200 / 55P03,
   * C1-STATUS §5) — rolls the savepoint back (rows, GUCs and the attempt's locks with it) and returns false: the caller
   * soft-deletes instead. Never a 409 for history, never data deleted blind.
   */
  private async tryHardDelete(manager: EntityManager, ctx: AuthContext, target: TargetRow): Promise<boolean> {
    await manager.query('SAVEPOINT user_hard_delete');
    try {
      const workspaces = await this.candidateWorkspaces(manager, ctx, target.id);
      // Security review M2: lock the target's staff profiles in every scope BEFORE reading their history. A concurrent
      // insert of an offer / assignment / request / team row holds FOR KEY SHARE on its profile until it commits; FOR UPDATE
      // waits for it, and the history read that follows (a new READ COMMITTED snapshot) then sees the committed row and the
      // delete falls back to soft. Without the lock the row would commit after the check and be cascaded away. Residual
      // (USER-DELETION.md §3.9): a profile the caller cannot see or update under RLS cannot be locked here; the post-delete
      // historyLost check still covers history that existed when its snapshot was taken.
      const blocking = await this.inEveryScope(manager, ctx, workspaces, async () => {
        const t = businessTables(manager); // C2: the scope inEveryScope bound for this visit
        await manager.query(`SELECT id FROM ${t.staff_profile} WHERE user_id = $1 FOR UPDATE`, [target.id]);
        // Part D 0a (structure level 22): a workspace schema no longer RESTRICTs the delete through foreign keys to core."user";
        // every former no-ON-DELETE user column is probed instead (Q3). A hit means not safe: soft delete.
        return (await this.findProtectedHistory(manager, target.id)) ?? (await workspaceRestrictReference(manager, target.id));
      });
      if (blocking) throw new HardDeleteNotSafe(`history:${blocking}`);

      // The profiles the caller cannot see were not checked above: snapshot their visible history, re-check after the delete.
      const historyBefore = new Map<string, string[]>();
      await this.inEveryScope(manager, ctx, workspaces, async (scope) => {
        historyBefore.set(scope.label, await this.staffWithHistory(manager));
        return null;
      });

      await this.refreshTokenService.revokeAllForUser(manager, target.id, 'account_deleted');
      await this.cancelOpenEmail(manager, target.id);
      // Before the delete and without targetUserId (the row is about to disappear): the id survives in the metadata, the same
      // idiom as the Worker's `user.invite_cleaned_up`. No e-mail (security review L4: audit_log is insert-only and shipped
      // off-host, so a copy there could never be erased).
      await this.auditService.record(manager, ctx, AuditAction.USER_DELETED, {
        metadata: { deletion: 'hard', deletedUserId: target.id },
      });
      await manager.delete(User, { id: target.id });
      // Part D 0a (Q2): what the dropped workspace foreign keys did ON DELETE (CASCADE the target's own staff profile and the
      // notes about them, SET NULL the attribution columns), in every scope, inside this savepoint, BEFORE the historyLost
      // re-check (which then sees what the in-schema cascades removed). In `core` the real foreign keys already did it (no-op).
      // A row that still needs the profile raises 23503: the savepoint rolls back and the account is soft-deleted instead.
      await this.inEveryScope(manager, ctx, workspaces, async () => {
        await clearWorkspaceUserReferences(manager, target.id);
        return null;
      });

      const lost = await this.inEveryScope(manager, ctx, workspaces, (scope) => this.historyLost(manager, historyBefore.get(scope.label) ?? []));
      if (lost) throw new HardDeleteNotSafe('history_lost');
      await manager.query('RELEASE SAVEPOINT user_hard_delete');
      return true;
    } catch (error) {
      const reason = hardDeleteFallbackReason(error);
      if (!reason) throw error;
      await manager.query('ROLLBACK TO SAVEPOINT user_hard_delete');
      await manager.query('RELEASE SAVEPOINT user_hard_delete');
      // Identifiers of the schema only, never row data (C1b re-review N4).
      this.logger.log(`user hard delete not safe (${reason}); the account is soft-deleted instead`);
      return false;
    }
  }

  /**
   * Part C1 (HWS-AUDIT.md §0.1, BROKEN 4.6), hard-delete path only: runs `visit` in EVERY scope the target can have rows
   * in (the bound scope, then for every candidate workspace W, with rab.workspace_id bound to W, its `core` copies and its
   * own READY schema) and returns the first non-null result. A schema of the organisation that exists but is not READY
   * cannot be checked → UnverifiableWorkspace (soft delete instead). rab.workspace_id / search_path are restored on the
   * success path; a throw rolls the savepoint back, GUCs included.
   */
  private async inEveryScope<T>(
    manager: EntityManager,
    ctx: AuthContext,
    workspaceIds: ReadonlySet<string>,
    visit: (scope: CheckScope) => Promise<T | null>,
  ): Promise<T | null> {
    const here = await visit({ label: 'bound' });
    if (here !== null) return here;
    if (!ctx.organisationId || workspaceIds.size === 0) return null;

    const [entry] = await manager.query<Array<{ ws: string | null; sp: string }>>(
      `SELECT current_setting('rab.workspace_id', true) AS ws, current_setting('search_path') AS sp`,
    );
    // C2-0: the businessTables(manager) binding follows every search_path switch below and is restored with it.
    const entryBinding = snapshotBusinessSchema(manager);

    // Restored from the binding when there was one (the same value the binder set; under the test-only trap the entry
    // search_path is '' and cannot be re-set from its quoted text form), else from the entry setting, as before.
    const restorePath = entryBinding.schema !== undefined ? businessSearchPath(entryBinding.schema) : entry?.sp ?? 'core';
    const restoreSession = () =>
      manager.query(`SELECT set_config('rab.workspace_id', $1, true), set_config('search_path', $2, true)`, [entry?.ws ?? '', restorePath]);
    let restored = false;
    let found: T | null = null;
    try {
      for (const workspaceId of workspaceIds) {
        bindBusinessSchema(manager, CORE_BUSINESS_SCHEMA, workspaceId); // validated and recorded before set_config
        await manager.query(`SELECT set_config('rab.workspace_id', $1, true), set_config('search_path', $2, true)`, [workspaceId, businessSearchPath(CORE_BUSINESS_SCHEMA)]);
        found = await visit({ label: `core:${workspaceId}` });
        if (found !== null) break;
        const schema = await this.checkableWorkspaceSchema(manager, workspaceId);
        if (schema === 'unverifiable') {
          this.logger.warn(`user hard delete: workspace ${workspaceId} has a schema that is not READY, so its rows cannot be checked`);
          throw new UnverifiableWorkspace();
        }
        if (schema) {
          bindBusinessSchema(manager, schema, workspaceId);
          await manager.query(`SELECT set_config('search_path', $1, true)`, [businessSearchPath(schema)]);
          found = await visit({ label: schema });
          if (found !== null) break;
        }
      }
      await restoreSession();
      restored = true;
    } finally {
      // C2-0 review #4: the businessTables binding is put back however the loop ends (a throw included).
      restoreBusinessSchema(manager, entryBinding);
      // A JS-level throw (UnverifiableWorkspace / HardDeleteNotSafe) leaves the transaction usable, so search_path and
      // rab.workspace_id are put back too (the hard-delete savepoint rollback would restore them anyway). Best effort: after
      // a database error the transaction is aborted, this statement fails as well, and the ORIGINAL error propagates.
      if (!restored) await restoreSession().catch(() => undefined);
    }
    return found;
  }

  /** Every workspace of the organisation the caller can see, the target's own workspace(s), and the caller's bound one. */
  private async candidateWorkspaces(manager: EntityManager, ctx: AuthContext, userId: string): Promise<Set<string>> {
    if (!ctx.organisationId) return new Set();
    const candidates = await manager.query<Array<{ workspace_id: string }>>(
      `SELECT id AS workspace_id FROM core.manager_workspace WHERE organisation_id = $1
       UNION SELECT workspace_id FROM core.manager_profile WHERE organisation_id = $1 AND user_id = $2 AND workspace_id IS NOT NULL
       UNION SELECT workspace_id FROM core.workspace_membership WHERE organisation_id = $1 AND user_id = $2 AND workspace_id IS NOT NULL
       ORDER BY 1`,
      [ctx.organisationId, userId],
    );
    const workspaceIds = new Set(candidates.map((row) => row.workspace_id));
    if (ctx.workspaceId) workspaceIds.add(ctx.workspaceId);
    return workspaceIds;
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
   * Every reference to the user that a hard delete would cascade away or be refused for (hard-delete path only). Includes
   * the C1b re-review additions (shift_request_staff, venue_manager_staff, replacement_request.selected_staff_profile_id).
   */
  private async findProtectedHistory(manager: EntityManager, userId: string): Promise<string | null> {
    const t = businessTables(manager); // C2: the scope inEveryScope bound for this visit
    const checks: Array<[string, string]> = [
      ['shift_created_by', `SELECT 1 FROM ${t.shift} WHERE created_by = $1 LIMIT 1`],
      ['job_role_created_by', `SELECT 1 FROM ${t.job_role} WHERE created_by = $1 LIMIT 1`],
      ['venue_created_by', `SELECT 1 FROM ${t.venue} WHERE created_by = $1 LIMIT 1`],
      ['payroll_decision_actor', `SELECT 1 FROM ${t.payroll_record} WHERE approved_by = $1 OR rejected_by = $1 LIMIT 1`],
      ['attendance_on_behalf_actor', `SELECT 1 FROM ${t.attendance} WHERE clock_in_by = $1 OR clock_out_by = $1 LIMIT 1`],
      ['job_offer_actor', `SELECT 1 FROM ${t.job_offer} WHERE created_by = $1 OR confirmed_by = $1 OR rejected_by = $1 LIMIT 1`],
      ['user_note_subject', `SELECT 1 FROM ${t.user_note} WHERE subject_user_id = $1 LIMIT 1`],
      [
        'staff_operational_history',
        `SELECT 1 FROM ${t.staff_profile} sp
           WHERE sp.user_id = $1
             AND (
               EXISTS (SELECT 1 FROM ${t.shift_assignment} sa WHERE sa.staff_profile_id = sp.id)
               OR EXISTS (SELECT 1 FROM ${t.job_offer} jo WHERE jo.staff_profile_id = sp.id)
               OR EXISTS (SELECT 1 FROM ${t.attendance} at WHERE at.staff_profile_id = sp.id)
               OR EXISTS (SELECT 1 FROM ${t.shift_request_staff} rs WHERE rs.staff_profile_id = sp.id)
               OR EXISTS (SELECT 1 FROM ${t.venue_manager_staff} vs WHERE vs.staff_profile_id = sp.id)
               OR EXISTS (SELECT 1 FROM ${t.replacement_request} rr WHERE rr.selected_staff_profile_id = sp.id)
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

  /** Staff profile ids with operational history in the current scope but no staff_profile row the caller can see. */
  private async staffWithHistory(manager: EntityManager): Promise<string[]> {
    const t = businessTables(manager);
    const [row] = await manager.query<Array<{ ids: string[] | null }>>(
      `SELECT array_agg(h.staff_profile_id) AS ids FROM (
         SELECT staff_profile_id FROM ${t.shift_assignment} UNION SELECT staff_profile_id FROM ${t.job_offer} UNION SELECT staff_profile_id FROM ${t.attendance}
         UNION SELECT staff_profile_id FROM ${t.shift_request_staff} UNION SELECT staff_profile_id FROM ${t.venue_manager_staff}
         UNION SELECT selected_staff_profile_id FROM ${t.replacement_request} WHERE selected_staff_profile_id IS NOT NULL
       ) h
       WHERE NOT EXISTS (SELECT 1 FROM ${t.staff_profile} sp WHERE sp.id = h.staff_profile_id)`,
    );
    return row?.ids ?? [];
  }

  /** The first of `before` whose visible history is entirely gone in the current scope (cascaded with its staff profile). */
  private async historyLost(manager: EntityManager, before: string[]): Promise<string | null> {
    if (before.length === 0) return null;
    const t = businessTables(manager);
    const rows = await manager.query<Array<{ id: string }>>(
      `SELECT p.id FROM unnest($1::uuid[]) AS p(id)
        WHERE NOT EXISTS (SELECT 1 FROM ${t.shift_assignment} WHERE staff_profile_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM ${t.job_offer} WHERE staff_profile_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM ${t.attendance} WHERE staff_profile_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM ${t.shift_request_staff} WHERE staff_profile_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM ${t.venue_manager_staff} WHERE staff_profile_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM ${t.replacement_request} WHERE selected_staff_profile_id = p.id)
        LIMIT 1`,
      [before],
    );
    return rows[0]?.id ?? null;
  }
}

/** A workspace schema of the organisation exists but is not READY: the hard delete cannot be verified (soft delete instead). */
class UnverifiableWorkspace extends Error {
  constructor() {
    super('unverifiable workspace');
  }
}

/**
 * Admin Inspect is read-only. JwtAuthGuard already refuses every state-changing request under inspect (INSPECT_READ_ONLY);
 * this is the same refusal at the service layer, for a caller that reaches the service with an inspect context.
 */
function assertNotInspecting(ctx: AuthContext): void {
  if (ctx.inspectedBy) {
    throw new ForbiddenException({ code: 'INSPECT_READ_ONLY', message: 'Admin Inspect is read-only. End the inspect session to make changes.' });
  }
}

/** Why a failed hard-delete attempt may fall back to a soft delete; null = a genuine error that must abort the transaction. */
export function hardDeleteFallbackReason(error: unknown): string | null {
  if (error instanceof HardDeleteNotSafe) return error.reason;
  if (error instanceof UnverifiableWorkspace) return 'unverifiable_workspace';
  if (error instanceof QueryFailedError) {
    const driver = error.driverError as { code?: string; constraint?: string; table?: string } | undefined;
    if (driver?.code === '23503') return `foreign_key:${driver.constraint ?? 'unknown'}:${driver.table ?? 'unknown'}`;
    if (driver?.code === '53200' || driver?.code === '55P03') return `locks:${driver.code}`;
  }
  return null;
}
