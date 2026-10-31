import { EntityManager } from 'typeorm';

/**
 * Phase C1b — who is told about a committed change. Every recipient set here is computed SERVER-SIDE, from the
 * database as it is at emit time, inside the SAME transaction (and therefore the same tenant binding and RLS) as the
 * business write it describes — never from a client-supplied id list, never from a cached scope. Each function mirrors
 * an existing read rule rather than inventing a new one:
 *
 *  - staff target user: `staff_profile.user_id` of the offer/assignment/attendance (the person the row is about);
 *  - the shift's owner: `shift.created_by` (`SchedulingService.assertShiftOwned`'s "owner" scope) and the offer's
 *    sender `shift_assignment.assigned_by` (the same recipient the existing `offer_*` notifications use);
 *  - venue managers of the venue: `ResourceScopeService.resolveTx`'s venue rule — a `venue_manager` role holder with a
 *    `manager_venue` row for that venue — plus an active, not-deleted account;
 *  - payroll: workspace members holding `payroll.view` (the `PermissionsService.userHasPermissionTx` override-then-role
 *    rule, verbatim) who are not venue managers (`PayrollService.canAccessPayroll` refuses venue scope).
 *
 * Fail closed: a row RLS hides from the acting transaction simply yields no recipient (fewer events, never more); the
 * client's poll still reconciles. Plain SQL only — no `modules/` import (engine never imports modules). Unqualified
 * names are the business tables the caller's own queries use (they resolve through the transaction's search_path,
 * core or the physical workspace schema); identity tables are always `core.`.
 *
 * `workspaceId` on a recipient is the workspace the gateway re-checks against that recipient's session
 * (`envelopeMatchesConnection`): the entity's workspace for people who work inside it, and NULL only for org-wide
 * recipients whose own session is bound to a different workspace (shift-request approvers). NULL never widens the
 * audience — the row is still addressed to exactly one `target_user_id` in exactly one organisation.
 */
export interface RealtimeRecipient {
  userId: string;
  workspaceId: string | null;
}

const ACTIVE_USER = `u.status = 'active' AND u.deleted_at IS NULL`;

/** Collapses duplicates (the same person can be owner, sender and venue manager at once) — one row per person. */
export function uniqueRecipients(recipients: Array<RealtimeRecipient | null | undefined>): RealtimeRecipient[] {
  const byUser = new Map<string, RealtimeRecipient>();
  for (const r of recipients) {
    if (!r?.userId) continue;
    const existing = byUser.get(r.userId);
    // A person reachable both inside the workspace and org-wide keeps the narrower (workspace-bound) form.
    if (!existing || (existing.workspaceId === null && r.workspaceId !== null)) byUser.set(r.userId, r);
  }
  return [...byUser.values()];
}

export async function venueManagerUserIds(manager: EntityManager, venueId: string): Promise<string[]> {
  const rows = await manager.query<Array<{ user_id: string }>>(
    `SELECT DISTINCT mp.user_id
       FROM manager_venue mv
       JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
       JOIN core."user" u ON u.id = mp.user_id AND ${ACTIVE_USER}
      WHERE mv.venue_id = $1
        AND EXISTS (SELECT 1 FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id
                     WHERE ur.user_id = mp.user_id AND r.key = 'venue_manager')`,
    [venueId],
  );
  return rows.map((r) => r.user_id);
}

/** The shift's owner + the venue's managers, bound to the shift's workspace. */
export async function shiftAudience(manager: EntityManager, shiftId: string): Promise<RealtimeRecipient[]> {
  const [shift] = await manager.query<Array<{ workspace_id: string | null; venue_id: string; created_by: string; requested_by: string | null }>>(
    `SELECT workspace_id, venue_id, created_by, requested_by FROM shift WHERE id = $1`,
    [shiftId],
  );
  if (!shift) return [];
  const ws = shift.workspace_id;
  const venueManagers = await venueManagerUserIds(manager, shift.venue_id);
  return uniqueRecipients([
    { userId: shift.created_by, workspaceId: ws },
    shift.requested_by ? { userId: shift.requested_by, workspaceId: ws } : null,
    ...venueManagers.map((userId) => ({ userId, workspaceId: ws })),
  ]);
}

/** Staff with a live seat on the shift (offered / accepted / confirmed) — the people whose offers or upcoming shifts change. */
export async function shiftStaffAudience(manager: EntityManager, shiftId: string): Promise<RealtimeRecipient[]> {
  const rows = await manager.query<Array<{ user_id: string; workspace_id: string | null }>>(
    `SELECT DISTINCT sp.user_id, sa.workspace_id
       FROM shift_assignment sa JOIN staff_profile sp ON sp.id = sa.staff_profile_id
      WHERE sa.shift_id = $1 AND sa.status IN ('offered', 'staff_accepted', 'confirmed')`,
    [shiftId],
  );
  return rows.map((r) => ({ userId: r.user_id, workspaceId: r.workspace_id }));
}

/** An offer's staff member, its sender, the shift's owner and the venue's managers. */
export async function offerAudience(manager: EntityManager, offerId: string): Promise<RealtimeRecipient[]> {
  const [row] = await manager.query<Array<{ workspace_id: string | null; staff_user_id: string; assigned_by: string | null; shift_id: string }>>(
    `SELECT o.workspace_id, sp.user_id AS staff_user_id, sa.assigned_by, sa.shift_id
       FROM job_offer o
       JOIN shift_assignment sa ON sa.id = o.shift_assignment_id
       JOIN staff_profile sp ON sp.id = o.staff_profile_id
      WHERE o.id = $1`,
    [offerId],
  );
  if (!row) return [];
  const ws = row.workspace_id;
  return uniqueRecipients([
    { userId: row.staff_user_id, workspaceId: ws },
    row.assigned_by ? { userId: row.assigned_by, workspaceId: ws } : null,
    ...(await shiftAudience(manager, row.shift_id)),
  ]);
}

/** An attendance row's staff member + the shift's owner and venue managers (the shift report's readers). */
export async function attendanceAudience(manager: EntityManager, attendanceId: string): Promise<RealtimeRecipient[]> {
  const [row] = await manager.query<Array<{ workspace_id: string | null; staff_user_id: string; shift_id: string }>>(
    `SELECT a.workspace_id, sp.user_id AS staff_user_id, a.shift_id
       FROM attendance a JOIN staff_profile sp ON sp.id = a.staff_profile_id
      WHERE a.id = $1`,
    [attendanceId],
  );
  if (!row) return [];
  return uniqueRecipients([{ userId: row.staff_user_id, workspaceId: row.workspace_id }, ...(await shiftAudience(manager, row.shift_id))]);
}

/**
 * Workspace members who may read payroll there: `payroll.view` by the same override-then-role rule
 * `PermissionsService.userHasPermissionTx` applies, minus venue managers (`PayrollService.canAccessPayroll`).
 */
export async function payrollAudience(manager: EntityManager, workspaceId: string): Promise<RealtimeRecipient[]> {
  const rows = await manager.query<Array<{ user_id: string }>>(
    `SELECT DISTINCT wm.user_id
       FROM core.workspace_membership wm
       JOIN core."user" u ON u.id = wm.user_id AND ${ACTIVE_USER}
      WHERE wm.workspace_id = $1 AND wm.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM core.user_permission_override o JOIN core.permission p ON p.id = o.permission_id
                         WHERE o.user_id = wm.user_id AND p.key = 'payroll.view' AND o.effect = 'revoke')
        AND (EXISTS (SELECT 1 FROM core.user_permission_override o JOIN core.permission p ON p.id = o.permission_id
                      WHERE o.user_id = wm.user_id AND p.key = 'payroll.view' AND o.effect = 'grant')
             OR EXISTS (SELECT 1 FROM core.user_role ur
                          JOIN core.role r ON r.id = ur.role_id
                          JOIN core.role_permission rp ON rp.role_id = ur.role_id
                          JOIN core.permission p ON p.id = rp.permission_id
                         WHERE ur.user_id = wm.user_id AND p.key = 'payroll.view'))
        AND NOT EXISTS (SELECT 1 FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id
                         WHERE ur.user_id = wm.user_id AND r.key = 'venue_manager')`,
    [workspaceId],
  );
  return rows.map((r) => ({ userId: r.user_id, workspaceId }));
}

/**
 * Shift-request approvers: every Internal Manager / CEO of the organisation — the exact set
 * `SchedulingService.listApprovers` notifies (`manager_profile.type`, the roles that hold STAFFING_REQUEST_APPROVE).
 * Written with workspace NULL (an approver's session is bound to their own workspace). `manager_profile` RLS limits the
 * set to approvers the acting transaction can see — exactly the set the existing `shift_request_*` notifications reach;
 * the event never widens it (an approver of another workspace can read neither the request nor its notification today).
 */
export async function approverAudience(manager: EntityManager, organisationId: string): Promise<RealtimeRecipient[]> {
  const rows = await manager.query<Array<{ user_id: string }>>(
    `SELECT mp.user_id FROM core.manager_profile mp
       JOIN core."user" u ON u.id = mp.user_id AND ${ACTIVE_USER}
      WHERE mp.organisation_id = $1 AND mp.type IN ('internal', 'ceo')`,
    [organisationId],
  );
  return rows.map((r) => ({ userId: r.user_id, workspaceId: null }));
}
