import { ConflictException, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { EmploymentStatus, UserStatus } from '@rab/shared';
import { User } from '../../identity/entities';
import { ScheduledWindow } from '../../scheduling/utils/assignment-time';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '../../scheduling/utils/tstzrange';
import { StaffProfile } from '../../staff/entities/staff-profile.entity';

/**
 * DOM-01 — the single canonical "can this staff member receive/hold an offer
 * for this shift, in this window" check. `OfferService.sendOne` (and
 * therefore every offer-creation path that funnels through it — `send`,
 * `sendBulk`, `createShiftAndSend`, `sendOneWithManager`, and through that
 * last one both `approveShiftRequest` and the replacement workflow) calls
 * this exact function. Nothing re-implements or subsets it.
 *
 * Before this, `sendOne` never checked `StaffProfile.employmentStatus` at
 * all — only `approveShiftRequest` and the replacement workflow's own
 * `assertStillEligible` separately bolted that check on themselves, each
 * with its own hand-rolled copy of the duplicate/overlap queries too. The
 * result: the exact same staff fixture (`User.status = 'active'`,
 * `employmentStatus = 'suspended'` — a real, reachable combination, since a
 * manager can suspend employment status without touching account status)
 * could receive a direct offer through `send()`/`sendBulk()`/
 * `createShiftAndSend()` while being correctly rejected by
 * `approveShiftRequest()` and the replacement workflow. Consolidating here
 * closes that drift at its root instead of patching each caller separately.
 *
 * Deliberately does NOT include `assertVenueTeamSelection` (team-pool
 * scope) — that's a separate authorization dimension (which manager may
 * offer to which staff at all), already enforced exactly once, by every
 * caller, inside `sendOne` itself.
 */
export async function assertStaffEligibleForOffer(
  manager: EntityManager,
  staffProfileId: string,
  shiftId: string,
  window: ScheduledWindow,
): Promise<StaffProfile> {
  const staffProfile = await manager.findOne(StaffProfile, { where: { id: staffProfileId } });
  if (!staffProfile) throw new NotFoundException('Staff member not found.');

  if (staffProfile.employmentStatus !== EmploymentStatus.ACTIVE) {
    throw new ConflictException('This staff member is not actively employed.');
  }

  // Re-validated here, not trusted from whatever the caller (Venue Manager
  // at request time, Internal Manager at approval time, the "All Users"
  // picker, or the replacement-staff worker's own shortlist snapshot) had
  // displayed — an account/employment state can change between selection
  // and this call.
  const staffUser = await manager.findOne(User, { where: { id: staffProfile.userId } });
  if (!staffUser || staffUser.status !== UserStatus.ACTIVE) {
    throw new ConflictException('This staff member is not an active account.');
  }

  const existing = await manager.findOne(ShiftAssignment, { where: { shiftId, staffProfileId } });
  if (existing) throw new ConflictException('This staff member has already been offered this shift.');

  // Proactive read of the same invariant `shift_assignment_no_double_booking`
  // (the GiST exclusion constraint, WHERE status IN ('confirmed','completed'))
  // enforces at INSERT time on confirm — checked here too so a conflicting
  // staff member gets a clear message at send time instead of only ever
  // discovering the conflict much later, at confirm time.
  const conflicting = await manager.query(
    `SELECT 1 FROM core.shift_assignment
       WHERE staff_profile_id = $1 AND status IN ('confirmed', 'completed')
         AND period && $2::tstzrange
       LIMIT 1`,
    [staffProfileId, toTstzRange(window.startsAt, window.endsAt)],
  );
  if (conflicting.length > 0) {
    throw new ConflictException('This staff member already has a confirmed shift that overlaps this time.');
  }

  return staffProfile;
}
