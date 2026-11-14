import { EmailOutboxStatus } from '@rab/shared';
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';

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
  // Part C1 review L2: a workspace schema of the organisation exists but is not READY, so its rows cannot be checked. Fail
  // closed, but say what is actually wrong (an operator problem, not the target's history); the workspace id is logged
  // server-side only.
  | 'USER_DELETION_UNVERIFIABLE'
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
/** One place the checks below can see rows: the transaction's bound scope, or a workspace W's `core` copy / own schema. */
interface CheckScope {
  readonly label: string;
}

const PROTECTED_HISTORY_MESSAGE = 'This account has historical workforce records and cannot be permanently deleted. Suspend the account instead.';

@Injectable()
export class UserDeletionService {
  private readonly logger = new Logger(UserDeletionService.name);

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
   *
   * Must run directly in the caller's tenant transaction — never inside a savepoint or a block that catches and continues:
   * the per-workspace checks move `rab.workspace_id` / `search_path` (transaction-local) and restore them only on the
   * success path; any throw is meant to abort the whole transaction. The same holds for `deleteUser`.
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

    const workspaces = await this.candidateWorkspaces(manager, ctx, targetUserId);
    const blockingReason = await this.inEveryScope(manager, ctx, workspaces, () => this.findProtectedHistory(manager, targetUserId));
    if (blockingReason) {
      throw new UserDeletionBlockedException('USER_HAS_PROTECTED_HISTORY', PROTECTED_HISTORY_MESSAGE);
    }
  }

  /**
   * Part C1 (HWS-AUDIT.md §0.1, BROKEN 4.6): runs `visit` in EVERY scope the target can have rows in, not only the one the
   * caller's transaction happens to be bound to, and returns the first non-null result. With one schema per workspace, a
   * workspace-less CEO's transaction reads the `core` copies and a workspace-bound caller reads only its own schema, so
   * history in another workspace's schema was invisible — and the deletion then cascaded (`staff_profile.user_id` ON DELETE
   * CASCADE and everything hanging off it), set attribution to NULL (`job_offer.created_by` ON DELETE SET NULL) or failed on
   * a raw FK error instead of the structured 409.
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
   *           delete is refused with USER_DELETION_UNVERIFIABLE (the workspace id logged server-side only): data in a
   *           schema that cannot be checked is never deleted blind (fail closed).
   *   3. rab.workspace_id and search_path restored to their values on entry (only on the success path; any throw aborts
   *      the transaction anyway — which is why the callers must never catch and continue).
   * Candidate workspaces: every workspace of the organisation the caller can see under RLS (an organisation-wide
   * `manager.manage` holder — the ManagerService.deleteUser route — sees all of them), plus the target's own workspace(s)
   * from `manager_profile` and `workspace_membership`, plus the caller's bound workspace. Same-organisation is guaranteed:
   * the lookup is pinned to ctx.organisationId and every row carries a composite same-organisation key.
   * RESIDUAL (C1-STATUS.md, SQL draft for owner review): RLS still decides what a check can see inside a schema — a caller
   * who is not a manager of W cannot see W's `staff_profile` rows, so the pre-delete staff-history check cannot match them.
   * Interim (no new SQL): `deleteUser` re-checks after the delete that no visible operational history disappeared with an
   * invisible staff profile (historyLost), and maps the no-ON-DELETE foreign-key refusals to the same 409.
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

    let found: T | null = null;
    for (const workspaceId of workspaceIds) {
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true), set_config('search_path', 'core', true)`, [workspaceId]);
      found = await visit({ label: `core:${workspaceId}` });
      if (found !== null) break;
      const schema = await this.checkableWorkspaceSchema(manager, workspaceId);
      if (schema === 'unverifiable') {
        this.logger.warn(`user deletion refused: workspace ${workspaceId} has a schema that is not READY, so its rows cannot be checked`);
        throw new UserDeletionBlockedException(
          'USER_DELETION_UNVERIFIABLE',
          'This account cannot be deleted right now: a workspace of this organisation is not ready, so its records cannot be checked. Try again later or contact support.',
        );
      }
      if (schema) {
        await manager.query(`SELECT set_config('search_path', $1, true)`, [schema]);
        found = await visit({ label: schema });
        if (found !== null) break;
      }
    }
    await manager.query(`SELECT set_config('rab.workspace_id', $1, true), set_config('search_path', $2, true)`, [entry?.ws ?? '', entry?.sp ?? 'core']);
    return found;
  }

  /** The candidate workspaces (see inEveryScope), read once per call so the pre- and post-delete passes cover the same set. */
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
      // A note ABOUT the user (user_note.subject_user_id ON DELETE CASCADE) is a manager's record, not the user's own data.
      ['user_note_subject', `SELECT 1 FROM user_note WHERE subject_user_id = $1 LIMIT 1`],
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
    // Part C1 review L1: a staff profile the caller cannot see (another workspace's schema, staff_profile_select) would
    // cascade away with its history. Record, in every scope, which INVISIBLE staff profiles have operational history BEFORE
    // the delete, and re-check after it (historyLost). The history tables themselves are tenant-wide under RLS; the profiles
    // the caller can see were already checked by assertCanDelete (re-review N3: snapshot only what it could not check).
    const workspaces = await this.candidateWorkspaces(manager, ctx, targetUserId);
    const historyBefore = new Map<string, string[]>();
    await this.inEveryScope(manager, ctx, workspaces, async (scope) => {
      historyBefore.set(scope.label, await this.staffWithHistory(manager));
      return null;
    });

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
    try {
      await manager.delete(User, { id: targetUserId });
    } catch (error) {
      // A no-ON-DELETE / RESTRICT reference the checks could not see (shift.approved_by, payroll rows visible only to a
      // payroll manager, ...): the database refused, which is the right outcome — reported as the structured 409, never a
      // raw FK 500. The transaction is aborted either way; the callers must not catch and continue.
      const driverError = error instanceof QueryFailedError ? (error.driverError as { code?: string; constraint?: string; table?: string } | undefined) : undefined;
      if (driverError?.code === '23503') {
        // Re-review N4: a refusal here also means a check is missing for that reference — name it (identifiers only, never
        // row data) so a future foreign key without a matching check is visible in the logs instead of hidden behind the 409.
        this.logger.warn(
          `user deletion refused by the database: foreign key ${driverError.constraint ?? 'unknown'} on ${driverError.table ?? 'unknown'} (no matching pre-delete check)`,
        );
        throw new UserDeletionBlockedException('USER_HAS_PROTECTED_HISTORY', PROTECTED_HISTORY_MESSAGE);
      }
      throw error;
    }

    const lost = await this.inEveryScope(manager, ctx, workspaces, (scope) => this.historyLost(manager, historyBefore.get(scope.label) ?? []));
    if (lost) {
      // Throwing aborts the caller's transaction: the user row, the cascaded profile and its history all stay.
      throw new UserDeletionBlockedException('USER_HAS_PROTECTED_HISTORY', PROTECTED_HISTORY_MESSAGE);
    }
  }

  /**
   * Staff profile ids that have operational history in the current scope but no staff_profile row the caller can see —
   * exactly the profiles assertCanDelete could not check (a visible profile of the target was checked there; a visible
   * profile of anyone else is not touched by deleting the target). A manager of the scope sees every profile, so the set
   * is empty and the post-delete pass costs nothing.
   */
  private async staffWithHistory(manager: EntityManager): Promise<string[]> {
    const [row] = await manager.query<Array<{ ids: string[] | null }>>(
      `SELECT array_agg(h.staff_profile_id) AS ids FROM (
         SELECT staff_profile_id FROM shift_assignment UNION SELECT staff_profile_id FROM job_offer UNION SELECT staff_profile_id FROM attendance
       ) h
       WHERE NOT EXISTS (SELECT 1 FROM staff_profile sp WHERE sp.id = h.staff_profile_id)`,
    );
    return row?.ids ?? [];
  }

  /** The first of `before` whose visible history is entirely gone in the current scope (cascaded with its staff profile). */
  private async historyLost(manager: EntityManager, before: string[]): Promise<string | null> {
    if (before.length === 0) return null;
    const rows = await manager.query<Array<{ id: string }>>(
      `SELECT p.id FROM unnest($1::uuid[]) AS p(id)
        WHERE NOT EXISTS (SELECT 1 FROM shift_assignment WHERE staff_profile_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM job_offer WHERE staff_profile_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM attendance WHERE staff_profile_id = p.id)
        LIMIT 1`,
      [before],
    );
    return rows[0]?.id ?? null;
  }
}
