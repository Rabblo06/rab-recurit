import { MANAGER_CONFIRMATION_LEAD_MINUTES, OFFER_CLOSED_REASON } from '@rab/shared';
import { BadRequestException } from '@nestjs/common';

export interface ScheduledWindow { startsAt: Date; endsAt: Date }

/** Existing assignment.period is the canonical scheduled window (and exclusion key).
 * Historical rows with no period use the parent without mutating history. */
export function effectiveAssignmentTime(assignment: { period?: string | null } | null, shift: ScheduledWindow): ScheduledWindow {
  if (!assignment?.period) return { startsAt: shift.startsAt, endsAt: shift.endsAt };
  const match = /^\["?([^",]+)"?,"?([^",]+)"?\)$/.exec(assignment.period);
  if (!match) throw new BadRequestException('Invalid assignment period.');
  const startsAt = new Date(match[1]);
  const endsAt = new Date(match[2]);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || startsAt >= endsAt) throw new BadRequestException('Invalid assignment period.');
  return { startsAt, endsAt };
}

/** Only trusted SQL aliases from source code; never accepts request values. */
export function assignmentTimeSql(assignment = 'sa', shift = 's') {
  if (![assignment, shift].every(a => /^[a-z][a-z0-9_]*$/.test(a))) throw new Error('Invalid SQL alias');
  return { start: `COALESCE(lower(${assignment}.period), ${shift}.starts_at)`, end: `COALESCE(upper(${assignment}.period), ${shift}.ends_at)` };
}

/**
 * The ONE definition of an offer's manager-confirmation deadline (owner rule 2026-11-06), as a SQL expression evaluated by
 * PostgreSQL — never computed in Node or on a client:
 *  - STANDARD offer: the individual assignment start − MANAGER_CONFIRMATION_LEAD_MINUTES;
 *  - REPLACEMENT / STANDBY offer: the end of its booked window (owner decision Q1b — they keep their existing window).
 * `timestamptz − interval` is absolute-instant arithmetic (minute units never follow the session TimeZone), so the
 * deadline is exactly 1,800 s before the start on BST/GMT change days too.
 *
 * Every reader and writer uses this: the accept CAS (refuses at/after it), the confirm CAS (`clock_timestamp() < it`),
 * the withdrawal CAS (`clock_timestamp() >= it`), the due-work pointer and timer trigger due time, the backstop scan and
 * the projections. `sa.period` is fixed once an offer exists (published shift times are not editable; only a replacement
 * CONFIRM narrows it, after which the offer is no longer awaiting confirmation). A future feature that edits the period
 * of an awaiting offer MUST re-arm the pointer (`schedulePointer`) with the new deadline.
 *
 * Only trusted SQL aliases from source code; never accepts request values.
 */
export function confirmationDeadlineSql(offer = 'o', assignment = 'sa', shift = 's'): string {
  if (!/^[a-z][a-z0-9_]*$/.test(offer)) throw new Error('Invalid SQL alias');
  const t = assignmentTimeSql(assignment, shift);
  return `(CASE WHEN COALESCE(${offer}.offer_kind, 'standard') = 'standard' THEN ${t.start} - make_interval(mins => ${MANAGER_CONFIRMATION_LEAD_MINUTES}) ELSE ${t.end} END)`;
}

/**
 * Projection columns for the deadline contract (`OfferConfirmationDeadlineFields` in @rab/shared), on the database clock:
 * `approval_deadline_at`, `awaiting_manager_confirmation`, `closed_reason`, `can_accept` (the staff accept preconditions,
 * display only — the accept CAS stays the authority). Needs `o` (job_offer), `sa`, `s` joined.
 * `closed_reason` precedence: a persisted deadline withdrawal; then a cancelled shift (or the cancellation follow-up's
 * close-out text); then — projection only, before the Worker has run — a staff_accepted offer already past its deadline.
 */
export function confirmationProjectionSql(offer = 'o', assignment = 'sa', shift = 's'): string {
  const deadline = confirmationDeadlineSql(offer, assignment, shift);
  const code = OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED;
  return `${deadline} AS approval_deadline_at,
    (${offer}.status = 'staff_accepted' AND clock_timestamp() < ${deadline}) AS awaiting_manager_confirmation,
    (CASE WHEN ${offer}.status = 'manager_rejected' AND ${offer}.rejected_by IS NULL AND ${offer}.rejection_reason = '${code}' THEN '${code}'
          WHEN ${shift}.status = 'cancelled' OR ${offer}.rejection_reason = 'This shift was cancelled.' THEN '${OFFER_CLOSED_REASON.SHIFT_CANCELLED}'
          WHEN ${offer}.status = 'staff_accepted' AND clock_timestamp() >= ${deadline} THEN '${code}'
          ELSE NULL END) AS closed_reason,
    (${offer}.status = 'pending' AND ${assignment}.status = 'offered' AND ${offer}.expires_at > now()
       AND ${shift}.status <> 'cancelled' AND clock_timestamp() < ${deadline}) AS can_accept`;
}

export function validateAssignmentTime(parent: ScheduledWindow, proposed: ScheduledWindow, breakMinutes = 0): ScheduledWindow {
  const values = [parent.startsAt, parent.endsAt, proposed.startsAt, proposed.endsAt];
  if (values.some(d => !Number.isFinite(d.getTime())) || parent.startsAt >= parent.endsAt || proposed.startsAt >= proposed.endsAt) throw new BadRequestException('Staff end must be after start.');
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes >= (proposed.endsAt.getTime() - proposed.startsAt.getTime()) / 60000) throw new BadRequestException('Break must be shorter than every selected assignment.');
  return proposed;
}

export function effectiveAssignmentBreakMinutes(assignment: { breakMinutes?: number | null } | null, shift: { breakMinutes: number }): number {
  return assignment?.breakMinutes ?? shift.breakMinutes;
}

export function defaultAssignmentTime(shift: ScheduledWindow & { defaultStartsAt?: Date | null; defaultEndsAt?: Date | null }): ScheduledWindow {
  return { startsAt: shift.defaultStartsAt ?? shift.startsAt, endsAt: shift.defaultEndsAt ?? shift.endsAt };
}

export function assignmentEnvelope(parent: ScheduledWindow, windows: ScheduledWindow[]): ScheduledWindow {
  return {
    startsAt: new Date(Math.min(parent.startsAt.getTime(), ...windows.map(w => w.startsAt.getTime()))),
    endsAt: new Date(Math.max(parent.endsAt.getTime(), ...windows.map(w => w.endsAt.getTime()))),
  };
}
