import { UserStatus } from '@rab/shared';
import { EntityManager } from 'typeorm';

import { ManagerProfile } from '@rab/server/modules/manager/entities/manager-profile.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { User } from '@rab/server/modules/identity/entities/index';

export interface ResolvedManager {
  userId: string;
  /** Which canonical relationship produced this recipient — carried into audit metadata for observability, never used for authorization. */
  source: 'assigned_by' | 'shift_created_by';
}

/**
 * The one, canonical way any worker job resolves "which manager is
 * responsible for this shift assignment right now" — replacing the
 * historically-scattered `staffProfile.createdBy` fallback that late-clock-in
 * (and no-show/missing-clock-out) used before Phase 3.
 *
 * `staffProfile.createdBy` records who onboarded the STAFF MEMBER as an HR/
 * ownership relationship (nullable, "unrecoverable, never guessed" for
 * profiles that predate ownership tracking — see `StaffProfile`'s own doc
 * comment) — it has nothing to do with who is responsible for a SPECIFIC
 * shift assignment. A staff member onboarded by Manager A can be assigned to
 * a shift created and confirmed entirely by Manager B; the person who should
 * hear "this shift has a problem" is B, not A.
 *
 * `ShiftAssignment.assignedBy` is that specific, current, assignment-level
 * relationship — set to the acting manager's own `ctx.userId` at the moment
 * the assignment is created (`OfferService.sendOne`, offer.service.ts:367)
 * — and it is ALREADY the established recipient for every other
 * assignment-lifecycle notification in this codebase (`offer_expired`,
 * `offer_accepted`, `offer_declined` in `offer.service.ts`; the worker's own
 * `manager-confirmation-timeout` in `offer-expiry.job.ts`). This function
 * makes late-clock-in consistent with that existing, evidenced convention
 * instead of the outlier it was.
 *
 * Fallback to `shift.createdBy` (NOT NULL on every `Shift` row) only when
 * `assignedBy` is absent (legacy data, or an assignment created through a
 * path that never set it) — the manager who created the shift is the next
 * most directly responsible party, still assignment/shift-specific rather
 * than staff-history-specific. No further fallback is invented: this
 * codebase has no existing "venue manager is responsible for every
 * assignment at their venue" notification convention to extend (venue-
 * manager visibility exists for RLS *read* breadth, e.g.
 * `replacement_request`'s policy, never as a notification-recipient rule),
 * so adding one here would be exactly the "invent a business rule silently"
 * case CLAUDE.md prohibits.
 *
 * Returns `null` (never an arbitrary fallback user) when no valid recipient
 * exists: the resolved user must exist, be `ACTIVE`, and belong to the same
 * organisation as the assignment/shift being processed — the id is never
 * trusted merely because a column holds it. Callers must treat `null` as
 * "safely complete with no manager notification," never as a reason to
 * retry indefinitely (see `late-clock-in.job.ts`'s own handling).
 */
export async function resolveResponsibleManager(
  manager: EntityManager,
  organisationId: string,
  assignment: ShiftAssignment,
  shift: Shift,
): Promise<ResolvedManager | null> {
  const candidates: Array<{ userId: string; source: ResolvedManager['source'] }> = [];
  if (assignment.assignedBy) candidates.push({ userId: assignment.assignedBy, source: 'assigned_by' });
  if (shift.createdBy) candidates.push({ userId: shift.createdBy, source: 'shift_created_by' });

  // `User` carries no workspace column of its own — workspace membership
  // lives on `ManagerProfile.workspaceId`. `assignment.workspaceId` (falling
  // back to `shift.workspaceId`, since ShiftAssignment inherits it from its
  // parent Shift at creation — see that entity's own doc comment) is the
  // workspace this specific occurrence belongs to; a resolved manager whose
  // OWN current workspace membership has since diverged from it (e.g.
  // reassigned to a different workspace after being recorded as
  // assignedBy/createdBy) is not a safe recipient for this specific
  // assignment today. Nullable on both sides for legacy, pre-Workspace-
  // migration data — absent means "no workspace constraint recorded", not
  // "belongs to every workspace".
  const requiredWorkspaceId = assignment.workspaceId ?? shift.workspaceId ?? null;

  for (const candidate of candidates) {
    const user = await manager.findOne(User, { where: { id: candidate.userId } });
    if (!user) continue; // deleted/unrecoverable — try the next candidate, never invent one
    if (user.organisationId !== organisationId) continue; // never trust an id across a tenant boundary, even one read from our own canonical columns
    if (user.status !== UserStatus.ACTIVE) continue; // deactivated — not a safe notification target

    if (requiredWorkspaceId) {
      const managerProfile = await manager.findOne(ManagerProfile, { where: { userId: user.id } });
      if (!managerProfile || managerProfile.workspaceId !== requiredWorkspaceId) continue;
    }

    return { userId: user.id, source: candidate.source };
  }
  return null;
}
