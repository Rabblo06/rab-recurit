import { ReplacementCandidateSnapshot, getLondonDateParts } from '@rab/shared';

/**
 * Owner decision 8 (21 Nov 2026): replacement suggestions are "eligible staff, with the reasons shown". There is no
 * score, no AI ordering and no shortlist cut by rank: every eligible person is listed, the not-eligible ones are
 * listed with the reasons why, and the manager chooses. UK GDPR Art. 22 / the AI rules forbid ranking named people;
 * losing a shift affects income.
 *
 * Order is by NAME only (last name, first name, then id for a stable tie-break), eligible first. The manager may
 * re-sort by any shown field; the server never orders people by a computed value.
 *
 * Eligibility (the decision's list, mapped to real columns; nothing invented):
 *  - has the role: `staff_profile.job_role_id` equals the shift's job role;
 *  - available: `staff_profile.available_days` (if ever set) contains the shift's London weekday;
 *  - no clash: no CONFIRMED/COMPLETED assignment whose period overlaps (the GiST constraint's own condition);
 *  - not already offered this exact shift.
 *  The query only loads ACTIVE employment + ACTIVE accounts, so those are not repeated here.
 * NOT CHECKED YET, flagged for the owner rather than invented: "Right to Work valid" (no staff document model on main
 * yet; Lane D) and "under the hours limit" (no configured limit exists; the 48-hour figure is a report warning).
 */
export interface CandidateFacts {
  staff_profile_id: string;
  first_name: string;
  last_name: string;
  job_role_id: string | null;
  available_days: string[] | null;
  no_overlap: boolean;
  not_already_offered: boolean;
}

/** Not-eligible rows listed per request at most (bounds the stored snapshot); eligible rows are never capped. */
export const MAX_NOT_ELIGIBLE_LISTED = 200;

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** London weekday name for the shift start (ISO 1..7 -> Sun..Sat index via % 7). */
export function londonWeekdayName(startsAt: Date): string {
  return WEEKDAY_NAMES[getLondonDateParts(startsAt).weekday % 7]!;
}

/** No preference recorded = available (unknown data is never held against anyone). */
export function isAvailableOnDay(availableDays: string[] | null, startsAt: Date): boolean {
  if (!availableDays || availableDays.length === 0) return true;
  return availableDays.includes(londonWeekdayName(startsAt));
}

const byName = (a: ReplacementCandidateSnapshot, b: ReplacementCandidateSnapshot): number =>
  a.lastName.localeCompare(b.lastName, 'en-GB', { sensitivity: 'base' }) ||
  a.firstName.localeCompare(b.firstName, 'en-GB', { sensitivity: 'base' }) ||
  (a.staffProfileId < b.staffProfileId ? -1 : a.staffProfileId > b.staffProfileId ? 1 : 0);

export function buildReplacementCandidates(
  rows: readonly CandidateFacts[],
  shift: { jobRoleId: string; startsAt: Date },
  jobRoleName: string | null,
): ReplacementCandidateSnapshot[] {
  const role = jobRoleName ?? 'shift';
  const weekday = londonWeekdayName(shift.startsAt);
  const eligible: ReplacementCandidateSnapshot[] = [];
  const notEligible: ReplacementCandidateSnapshot[] = [];
  for (const r of rows) {
    const hasRole = r.job_role_id !== null && r.job_role_id === shift.jobRoleId;
    const available = isAvailableOnDay(r.available_days, shift.startsAt);
    const base = { staffProfileId: r.staff_profile_id, firstName: r.first_name, lastName: r.last_name };
    const missing: string[] = [];
    if (!hasRole) missing.push(r.job_role_id === null ? 'No job role recorded' : `Does not have the ${role} role`);
    if (!available) missing.push(`Not available on ${weekday}`);
    if (!r.no_overlap) missing.push('Already on a confirmed shift at this time');
    if (!r.not_already_offered) missing.push('Already offered this shift');
    if (missing.length === 0) {
      eligible.push({
        ...base,
        eligible: true,
        reasons: [
          `Has the ${role} role`,
          r.available_days && r.available_days.length > 0 ? `Available on ${weekday}` : 'No unavailable days recorded',
          'No clash with a confirmed shift',
          'Not already offered this shift',
        ],
      });
    } else {
      notEligible.push({ ...base, eligible: false, reasons: missing });
    }
  }
  return [...eligible.sort(byName), ...notEligible.sort(byName).slice(0, MAX_NOT_ELIGIBLE_LISTED)];
}
