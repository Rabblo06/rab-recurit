/**
 * Pure checks for a multi-shift send (`OfferService.sendOffersToShifts`) that no single-shift path needs: the same
 * staff member offered two shifts of THIS batch whose times overlap. Each offer is otherwise checked by `sendOne`
 * exactly like a single send (eligibility, duplicate, confirmed-overlap, availability, team scope, deadline).
 *
 * Why refuse a pending overlap at all: today one person may hold pending offers for overlapping shifts, and the GiST
 * exclusion `shift_assignment_no_double_booking` refuses the second CONFIRMATION. A bulk action that plans overlapping
 * work for one person in one go is almost certainly a mistake, so it is refused up front (flagged assumption).
 */
export interface PlannedOffer {
  shiftId: string;
  staffProfileId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface PlannedOfferFailure {
  shiftId: string;
  staffProfileId: string;
  message: string;
}

/** Every (shift, staff) row of the batch whose window overlaps another row for the same staff member. */
export function overlappingWithinBatch(rows: PlannedOffer[]): PlannedOfferFailure[] {
  const byStaff = new Map<string, PlannedOffer[]>();
  for (const row of rows) byStaff.set(row.staffProfileId, [...(byStaff.get(row.staffProfileId) ?? []), row]);
  const failures: PlannedOfferFailure[] = [];
  for (const list of byStaff.values()) {
    for (const row of list) {
      const clash = list.some((other) => other !== row && other.shiftId !== row.shiftId && other.startsAt < row.endsAt && row.startsAt < other.endsAt);
      if (clash) failures.push({ shiftId: row.shiftId, staffProfileId: row.staffProfileId, message: 'This staff member is also being offered an overlapping shift in this batch.' });
    }
  }
  return failures;
}
