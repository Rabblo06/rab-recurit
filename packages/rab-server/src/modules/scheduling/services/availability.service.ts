import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/**
 * Single authoritative "is this Staff member busy?" calculation — reused by
 * every caller that needs it (the venue-facing staff directory/pool list,
 * the Venue Manager's shift-request submission, the Internal Manager's
 * Venue Offers staff add/replace flow) so there is exactly one definition
 * of "busy," never a Flutter-only or web-only reimplementation.
 *
 * "Busy" means: a `shift_assignment` row for this staff member whose
 * `status = 'confirmed'` (the same status the database's own
 * `shift_assignment_no_double_booking` GiST exclusion constraint —
 * SchedulingSchema migration — already treats as the one binding
 * commitment) has a `period` (a `tstzrange`, real timestamps, not string
 * comparison) that overlaps the requested window. `completed` is
 * deliberately excluded here (unlike the DB constraint, which also covers
 * it) — a completed assignment is necessarily in the past and cannot
 * overlap a shift being requested now or in the future; including it would
 * only add a redundant check, not change any real answer.
 *
 * Explicitly NOT busy because of: `offered`, `declined`, `withdrawn`,
 * `cancelled`, `no_show` — an offer that was never accepted, or was
 * declined/withdrawn/cancelled, was never a real commitment of this
 * person's time.
 */
@Injectable()
export class AvailabilityService {
  /**
   * Returns the subset of `staffProfileIds` that are BUSY for the given
   * window — a single bulk query, never one query per staff row (the
   * directory/pool endpoints that call this can return hundreds of rows).
   * `excludeShiftId` is for editing an already-published shift: the
   * staff member's own existing assignment on that same shift must not
   * make them appear unavailable for it.
   */
  async findBusyStaffIds(
    manager: EntityManager,
    staffProfileIds: string[],
    startsAt: Date,
    endsAt: Date,
    excludeShiftId?: string,
  ): Promise<Set<string>> {
    if (staffProfileIds.length === 0) return new Set();
    const rows = await manager.query<{ staff_profile_id: string }[]>(
      `SELECT DISTINCT staff_profile_id
         FROM core.shift_assignment
        WHERE staff_profile_id = ANY($1::uuid[])
          AND status = 'confirmed'
          AND period && tstzrange($2, $3)
          AND ($4::uuid IS NULL OR shift_id != $4)`,
      [staffProfileIds, startsAt, endsAt, excludeShiftId ?? null],
    );
    return new Set(rows.map((r) => r.staff_profile_id));
  }

  /** Convenience wrapper for a single staff member — still one query, used by server-side revalidation paths that already loop per-id for other reasons (eligibility, workspace match) and want one clear yes/no alongside those checks. */
  async isAvailable(
    manager: EntityManager,
    staffProfileId: string,
    startsAt: Date,
    endsAt: Date,
    excludeShiftId?: string,
  ): Promise<boolean> {
    const busy = await this.findBusyStaffIds(manager, [staffProfileId], startsAt, endsAt, excludeShiftId);
    return !busy.has(staffProfileId);
  }
}
