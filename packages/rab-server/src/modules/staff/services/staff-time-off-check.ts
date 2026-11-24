import { STAFF_TIME_OFF_CONFLICT_CODE } from '@rab/shared';
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/**
 * Owner decision 42 (decided): APPROVED time off is a HARD BLOCK on new offers for those dates, and the day is judged in the
 * ORGANISATION's time zone (core.organisation.timezone). A request that is still `requested` does NOT block (FLAGGED reading
 * of decision 42: only a manager's approval turns a request into a block). Kept separate from the acknowledgeable
 * weekday-availability warning (assertStaffAvailabilityAcknowledged): this one cannot be acknowledged away.
 *
 * Called by assertStaffEligibleForOffer (every send path) and again by applyOfferConfirmation (time off approved after the
 * offer was sent stops the confirmation; the claim rolls back with the transaction).
 */
export const STAFF_TIME_OFF_UNVERIFIABLE_CODE = 'STAFF_TIME_OFF_UNVERIFIABLE';

export class StaffTimeOffConflictException extends ConflictException {
  constructor(readonly blockedOn: string) {
    super({
      statusCode: 409,
      code: STAFF_TIME_OFF_CONFLICT_CODE,
      message: `This staff member has approved time off on ${blockedOn}.`,
    });
  }
}

/**
 * The organisation-local calendar days a window [startsAt, endsAt) touches, and the first of them covered by APPROVED time
 * off of this staff member. One statement, on the database's time-zone data:
 *   - first day: startsAt AT TIME ZONE o.timezone; last day: (endsAt - 1 microsecond) AT TIME ZONE o.timezone, so a window
 *     ending exactly at local midnight does not touch the next day, and an overnight shift touches both days;
 *   - `reader`: the bound session is a non-venue, non-archived manager of the bound workspace, or the staff member
 *     themselves — exactly the sessions whose RLS shows this staff member's time-off rows (staff_time_off_manager_select /
 *     staff_time_off_own_select). Anyone else would see no rows and pass by mistake, so the caller refuses instead;
 *   - the time-off row is matched on BOTH staff_profile_id and staff_user_id (the profile's user), so a row naming another
 *     person's profile can never block this one, nor the reverse.
 * No organisation row visible (no tenant context bound, or RLS hides it) → zero rows → the caller refuses (fail closed).
 */
export const STAFF_TIME_OFF_BLOCK_SQL = `
SELECT to_char(w.first_day, 'YYYY-MM-DD') AS first_day,
       to_char(w.last_day, 'YYYY-MM-DD') AS last_day,
       (EXISTS (SELECT 1 FROM core.manager_profile mp
                 WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org()
                   AND mp.workspace_id = core.current_workspace() AND mp.type <> 'venue' AND mp.archived_at IS NULL)
        OR core.current_uid() = $4::uuid) AS reader,
       (SELECT to_char(GREATEST(t.starts_on, w.first_day), 'YYYY-MM-DD')
          FROM core.staff_time_off t
         WHERE t.staff_profile_id = $3::uuid AND t.staff_user_id = $4::uuid AND t.status = 'approved'
           AND t.starts_on <= w.last_day AND t.ends_on >= w.first_day
         ORDER BY GREATEST(t.starts_on, w.first_day)
         LIMIT 1) AS blocked_on
  FROM (SELECT ($1::timestamptz AT TIME ZONE o.timezone)::date AS first_day,
               (($2::timestamptz - interval '1 microsecond') AT TIME ZONE o.timezone)::date AS last_day
          FROM core.organisation o
         WHERE o.id = core.current_org()) w`;

export interface StaffTimeOffWindow {
  startsAt: Date;
  endsAt: Date;
}

export interface StaffTimeOffBlockRow {
  first_day: string | null;
  last_day: string | null;
  reader: boolean | null;
  blocked_on: string | null;
}

/**
 * Decision 42, the hard block: throws StaffTimeOffConflictException (409 `STAFF_TIME_OFF`) when approved time off covers
 * any organisation-local day the window touches. Fails closed with a 409 `STAFF_TIME_OFF_UNVERIFIABLE` (never a pass) when
 * the window is invalid, no organisation time zone is visible, or the bound session could not see this staff member's time
 * off through RLS.
 */
export async function assertNoApprovedTimeOff(
  manager: EntityManager,
  staff: { staffProfileId: string; staffUserId: string },
  window: StaffTimeOffWindow,
): Promise<void> {
  const startsAt = new Date(window.startsAt);
  const endsAt = new Date(window.endsAt);
  if (
    !Number.isFinite(startsAt.getTime()) ||
    !Number.isFinite(endsAt.getTime()) ||
    endsAt.getTime() <= startsAt.getTime()
  ) {
    throw unverifiable();
  }
  const rows = (await manager.query(STAFF_TIME_OFF_BLOCK_SQL, [
    startsAt.toISOString(),
    endsAt.toISOString(),
    staff.staffProfileId,
    staff.staffUserId,
  ])) as StaffTimeOffBlockRow[];
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row?.first_day || !row.last_day || row.reader !== true)
    throw unverifiable();
  if (row.blocked_on) throw new StaffTimeOffConflictException(row.blocked_on);
}

function unverifiable(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: STAFF_TIME_OFF_UNVERIFIABLE_CODE,
    message:
      "This staff member's time off cannot be checked, so this offer cannot go ahead.",
  });
}

/**
 * Today's calendar date (`YYYY-MM-DD`) in the time zone of the organisation bound to this transaction (decision 42: days are
 * organisation-local). Same approach as organisationLocalDate (decision 40, #349), not imported from that unmerged branch.
 * Fail closed: THROWS when no organisation row is visible — a day is never judged in a guessed time zone.
 */
export async function organisationToday(
  manager: EntityManager,
): Promise<string> {
  const rows = (await manager.query(
    `SELECT to_char(now() AT TIME ZONE o.timezone, 'YYYY-MM-DD') AS day FROM core.organisation o WHERE o.id = core.current_org()`,
  )) as Array<{ day: string | null }>;
  if (rows.length !== 1 || !rows[0]!.day)
    throw new Error(
      'organisationToday: no organisation time zone is visible (missing tenant context); refusing to guess',
    );
  return rows[0]!.day;
}
