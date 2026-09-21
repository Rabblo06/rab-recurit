export const ShiftStatus = {
  DRAFT: 'draft',
  // A Venue Manager's submitted shift request, awaiting an Internal
  // Manager's approve/decline — reachable only via direct INSERT (the
  // Venue-Manager-submit endpoint), never via assertTransition from another
  // status. Distinct from DRAFT: a DRAFT shift is the *same* manager's own
  // unpublished work; PENDING_MANAGER_APPROVAL is a different person's
  // request awaiting someone else's decision.
  PENDING_MANAGER_APPROVAL: 'pending_manager_approval',
  // Terminal rejection of a request — distinct from CANCELLED, which means
  // "was approved/open, then called off," not "never approved."
  DECLINED: 'declined',
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
