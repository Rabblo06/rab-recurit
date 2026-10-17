import { ConflictException } from '@nestjs/common';
import { formatWeekdayList, LondonCalendarDay } from '@rab/shared';

export const STAFF_AVAILABILITY_CONFLICT = 'STAFF_AVAILABILITY_CONFLICT';

export interface StaffAvailabilityConflict {
  staffProfileId: string;
  staffName: string;
  /** Declared available weekdays, calendar order. */
  availableDays: string[];
  /** The London calendar days of this recipient's shift window outside `availableDays`. */
  conflictDates: LondonCalendarDay[];
}

export interface StaffAvailabilityUnknown {
  staffProfileId: string;
  staffName: string;
}

function conflictMessage(totalRecipients: number, conflicts: StaffAvailabilityConflict[]): string {
  if (totalRecipients === 1 && conflicts.length === 1) {
    const [c] = conflicts;
    const days = formatWeekdayList([...new Set(c.conflictDates.map((d) => d.weekday))]);
    return `${c.staffName} has marked themselves as unavailable on ${days}. Available days: ${formatWeekdayList(c.availableDays)}.`;
  }
  return `${conflicts.length} of ${totalRecipients} selected Staff have availability conflicts.`;
}

/**
 * 409 before anything is dispatched: one or more recipients fall outside their declared weekday availability and the
 * sender has not acknowledged those exact dates. Nothing was created; resending with `acknowledgedAvailabilityConflicts`
 * covering every listed date proceeds through the normal (unchanged) offer path.
 */
export class StaffAvailabilityConflictException extends ConflictException {
  constructor(totalRecipients: number, conflicts: StaffAvailabilityConflict[], unknownAvailability: StaffAvailabilityUnknown[]) {
    super({
      statusCode: 409,
      code: STAFF_AVAILABILITY_CONFLICT,
      message: conflictMessage(totalRecipients, conflicts),
      totalRecipients,
      conflicts,
      unknownAvailability,
    });
  }
}
