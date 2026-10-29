import { PermissionFlag } from '@rab/shared';
import { EntityManager } from 'typeorm';

import type { PermissionsService } from '@rab/server/engine/core-modules/permissions/permissions.service';

/**
 * WHO may receive a report email (pre-shift roster + Shift QR, final timesheet) — the ONE rule, used at enqueue time by
 * `shift-report-scheduler.job.ts` and `final-timesheet.job.ts`, and again immediately before sending by
 * `email-send.processor.ts`. Both PDFs carry other people's attendance data, and the roster carries a signed Shift QR
 * clock-in token, so a recipient who has lost access must not receive either.
 *
 * A recipient is eligible for a report about venue V in (organisation O, workspace W) only when ALL of these hold:
 *  1. they are still assigned to V in W (`manager_venue` row: venue_id = V, organisation_id = O, workspace_id = W);
 *  2. their account is active and not soft-deleted (`core.user.status = 'active' AND deleted_at IS NULL`) — a
 *     deactivated manager is `suspended` (ManagerService.setActive), an archived one is suspended too;
 *  3. their manager profile is not archived (`core.manager_profile.archived_at IS NULL`);
 *  4. their organisation membership is not revoked (no `core.organisation_member` row for (user, O) with a status other
 *     than 'active'; that table is not populated for every user yet, so a missing row is not treated as revoked);
 *  5. they hold an ACTIVE workspace membership in W, in an active workspace — read through the existing login resolver
 *     `core.resolve_membership_for_user` (SECURITY DEFINER, already granted to the runtime role), because
 *     `workspace_membership`'s RLS only shows a row to its own user or the workspace owner, and the worker is neither.
 *     Deactivation suspends this membership (`core.suspend_workspace_membership`);
 *  6. organisation O is not suspended (`core.organisation.suspended_at IS NULL`; a missing row counts as suspended);
 *  7. they hold `report.view` — the SAME flag `ReportFilePolicy` requires to download these PDFs — resolved server-side by
 *     the existing `PermissionsService.userHasPermissionTx` for (O, W, that user), in the caller's transaction, so a
 *     REVOKE override or a role change takes effect on the next enqueue/send.
 *
 * Every query runs on the caller's EntityManager, i.e. inside the caller's own tenant transaction with O AND W bound and
 * its search_path routed to W's tables (`runInTenantContext`/`runInWorkspaceContext` with the workspace set: the
 * physical workspace schema under HWS, `core` otherwise). `manager_venue` is one of the physical workspace tables, so it
 * is deliberately left unqualified and resolves through that search_path; every core table is `core.`-qualified. RLS
 * still applies underneath these explicit predicates. Nothing here changes RLS or context.
 * Fail closed: no workspace → nobody can be proven to belong to it → no recipients.
 */
export interface ReportRecipientScope {
  organisationId: string;
  workspaceId: string | null;
  venueId: string;
}

export interface ReportRecipient {
  userId: string;
  email: string;
}

export interface ReportRecipientSelection {
  recipients: ReportRecipient[];
  /** Venue-manager links that were NOT eligible (counts only — never logged with addresses). */
  excluded: number;
  organisationSuspended: boolean;
}

/** The one method used from PermissionsService (its `userHasPermissionTx` never touches the service's own tenant context). */
export type ReportPermissionChecker = Pick<PermissionsService, 'userHasPermissionTx'>;

/** Stable, PII-free code written to `email_outbox.last_error_code` when a queued report email is cancelled at send time. */
export const REPORT_RECIPIENT_INELIGIBLE = 'REPORT_RECIPIENT_INELIGIBLE';

interface CandidateRow {
  user_id: string;
  email: string;
  base_eligible: boolean;
}

export async function selectReportRecipients(
  manager: EntityManager,
  scope: ReportRecipientScope,
  permissions: ReportPermissionChecker,
  onlyUserId: string | null = null,
): Promise<ReportRecipientSelection> {
  if (!scope.workspaceId || !scope.organisationId || !scope.venueId) return { recipients: [], excluded: 0, organisationSuspended: false };

  const candidates = await manager.query<CandidateRow[]>(
    `SELECT u.id AS user_id, u.email,
            (u.status = 'active'
             AND u.deleted_at IS NULL
             AND mp.archived_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM core.organisation_member om
                              WHERE om.user_id = u.id AND om.organisation_id = $2 AND om.status <> 'active')
            ) AS base_eligible
       FROM manager_venue mv
       JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id AND mp.organisation_id = mv.organisation_id
       JOIN core."user" u ON u.id = mp.user_id AND u.organisation_id = mv.organisation_id
      WHERE mv.venue_id = $1
        AND mv.organisation_id = $2
        AND mv.workspace_id = $3
        AND ($4::uuid IS NULL OR u.id = $4::uuid)
      ORDER BY u.id`,
    [scope.venueId, scope.organisationId, scope.workspaceId, onlyUserId],
  );

  const [org] = await manager.query<Array<{ suspended_at: Date | null }>>(`SELECT suspended_at FROM core.organisation WHERE id = $1`, [scope.organisationId]);
  const organisationSuspended = !org || !!org.suspended_at;

  const seen = new Set<string>();
  const recipients: ReportRecipient[] = [];
  let linksChecked = 0;
  for (const row of candidates) {
    if (seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    linksChecked += 1;
    if (organisationSuspended || !row.base_eligible) continue;
    if (!(await holdsActiveWorkspaceMembership(manager, row.user_id, scope))) continue;
    const ctx = { organisationId: scope.organisationId, workspaceId: scope.workspaceId, userId: row.user_id, role: '' };
    if (!(await permissions.userHasPermissionTx(manager, ctx, PermissionFlag.REPORT_VIEW))) continue;
    recipients.push({ userId: row.user_id, email: row.email });
  }
  return { recipients, excluded: linksChecked - recipients.length, organisationSuspended };
}

/** Send-time re-check for one queued report email: true only if `userId` still passes every rule above. */
export async function isEligibleReportRecipient(
  manager: EntityManager,
  scope: ReportRecipientScope,
  permissions: ReportPermissionChecker,
  userId: string | null | undefined,
): Promise<boolean> {
  return (await checkReportRecipient(manager, scope, permissions, userId)).eligible;
}

/** Audit reason code (S-6) for a report email withheld or cancelled because the organisation is suspended. A code, never PII. */
export const REPORT_EMAIL_REASON_ORGANISATION_SUSPENDED = 'ORGANISATION_SUSPENDED';

/** The same send-time re-check, also saying whether a suspended organisation is the reason (for the audit reason code). */
export async function checkReportRecipient(
  manager: EntityManager,
  scope: ReportRecipientScope,
  permissions: ReportPermissionChecker,
  userId: string | null | undefined,
): Promise<{ eligible: boolean; organisationSuspended: boolean }> {
  if (!userId) return { eligible: false, organisationSuspended: false };
  const { recipients, organisationSuspended } = await selectReportRecipients(manager, scope, permissions, userId);
  return { eligible: recipients.some((r) => r.userId === userId), organisationSuspended };
}

async function holdsActiveWorkspaceMembership(manager: EntityManager, userId: string, scope: ReportRecipientScope): Promise<boolean> {
  // Returns the user's organisation and their ONE active workspace in an active workspace (NULL workspace when none).
  // It restores the transaction's own organisation/user GUCs before returning, so the caller's context is unchanged.
  const rows = await manager.query<Array<{ organisation_id: string | null; workspace_id: string | null }>>(
    `SELECT organisation_id, workspace_id FROM core.resolve_membership_for_user($1)`,
    [userId],
  );
  return rows.length === 1 && rows[0]!.organisation_id === scope.organisationId && rows[0]!.workspace_id === scope.workspaceId;
}
