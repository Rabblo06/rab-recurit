export const ShiftStatus = {
  DRAFT: 'draft',
  OPEN: 'open',
  OFFERED: 'offered',
  PARTIALLY_FILLED: 'partially_filled',
  FULLY_FILLED: 'fully_filled',
  CONFIRMED: 'confirmed',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const;

export type ShiftStatusType = (typeof ShiftStatus)[keyof typeof ShiftStatus];

export const ShiftAssignmentStatus = {
  OFFERED: 'offered',
  // Staff has accepted the offer but the manager has not confirmed it yet —
  // does not count toward shift.filledCount and is not subject to the
  // no-double-booking exclusion constraint (only CONFIRMED is).
  STAFF_ACCEPTED: 'staff_accepted',
  CONFIRMED: 'confirmed',
  DECLINED: 'declined',
  // Manager explicitly declined a staff acceptance (distinct from CANCELLED,
  // which covers a previously-confirmed assignment being called off).
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
  CANCELLED: 'cancelled',
  NO_SHOW: 'no_show',
  COMPLETED: 'completed',
} as const;

export type ShiftAssignmentStatusType =
  (typeof ShiftAssignmentStatus)[keyof typeof ShiftAssignmentStatus];
