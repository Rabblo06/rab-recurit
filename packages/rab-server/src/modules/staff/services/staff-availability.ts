import { findAvailabilityConflicts, WEEKDAY_NAMES } from '@rab/shared';
import { EntityManager } from 'typeorm';

import { ScheduledWindow } from '../../scheduling/utils/assignment-time';
import { AvailabilityAcknowledgementDto } from '../dto/availability-acknowledgement.dto';
import {
  StaffAvailabilityConflict,
  StaffAvailabilityConflictException,
  StaffAvailabilityUnknown,
} from '../exceptions/staff-availability.exceptions';

export type AvailabilityRecipient = { staffProfileId: string } & ScheduledWindow;
export type AvailabilityAcknowledgement = Pick<AvailabilityAcknowledgementDto, 'staffProfileId' | 'dates'>;

interface AvailabilityRow {
  id: string;
  available_days: string[] | null;
  first_name: string | null;
  last_name: string | null;
}

/**
 * Declared weekday availability (`staff_profile.available_days`) against each recipient's own shift window. Advisory, not a
 * block: a conflict is surfaced before dispatch and may be sent anyway with an explicit, date-specific acknowledgement.
 *
 * Runs inside the caller's workspace transaction, so the staff read goes through the same RLS + search_path as every other
 * offer-path read: a staff id outside the caller's workspace returns no row and therefore no availability information (the
 * offer path then refuses it on its own, unchanged, 404). Unknown availability (NULL or []) is never a conflict.
 */
export async function evaluateStaffAvailability(
  manager: EntityManager,
  recipients: readonly AvailabilityRecipient[],
): Promise<{ conflicts: StaffAvailabilityConflict[]; unknown: StaffAvailabilityUnknown[] }> {
  const ids = [...new Set(recipients.map((r) => r.staffProfileId))];
  if (ids.length === 0) return { conflicts: [], unknown: [] };
  const rows: AvailabilityRow[] = await manager.query(
    `SELECT sp.id, sp.available_days, u.first_name, u.last_name
       FROM staff_profile sp LEFT JOIN core."user" u ON u.id = sp.user_id
      WHERE sp.id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const conflicts: StaffAvailabilityConflict[] = [];
  const unknown: StaffAvailabilityUnknown[] = [];
  for (const recipient of recipients) {
    const row = byId.get(recipient.staffProfileId);
    if (!row) continue;
    const staffName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || 'This staff member';
    const conflictDates = findAvailabilityConflicts(row.available_days, recipient.startsAt, recipient.endsAt);
    if (conflictDates === null) {
      unknown.push({ staffProfileId: row.id, staffName });
    } else if (conflictDates.length > 0) {
      const declared = row.available_days ?? [];
      conflicts.push({
        staffProfileId: row.id,
        staffName,
        availableDays: WEEKDAY_NAMES.filter((d) => declared.includes(d)),
        conflictDates,
      });
    }
  }
  return { conflicts, unknown };
}

function isAcknowledged(conflict: StaffAvailabilityConflict, acknowledgements: readonly AvailabilityAcknowledgement[]): boolean {
  const dates = new Set(acknowledgements.filter((a) => a.staffProfileId === conflict.staffProfileId).flatMap((a) => a.dates));
  return conflict.conflictDates.every((d) => dates.has(d.date));
}

/**
 * The dispatch-boundary check. Throws `StaffAvailabilityConflictException` (409, nothing created) when any recipient's
 * conflict is not fully acknowledged; otherwise returns the conflicts that WERE acknowledged so the caller can audit them.
 * The thrown body lists every conflict (acknowledged or not) so the sender sees the complete picture in one prompt.
 */
export async function assertStaffAvailabilityAcknowledged(
  manager: EntityManager,
  recipients: readonly AvailabilityRecipient[],
  acknowledgements: readonly AvailabilityAcknowledgement[] | undefined,
): Promise<StaffAvailabilityConflict[]> {
  const { conflicts, unknown } = await evaluateStaffAvailability(manager, recipients);
  const acks = acknowledgements ?? [];
  if (conflicts.some((c) => !isAcknowledged(c, acks))) {
    throw new StaffAvailabilityConflictException(new Set(recipients.map((r) => r.staffProfileId)).size, conflicts, unknown);
  }
  return conflicts;
}
