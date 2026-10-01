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
