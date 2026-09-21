import { ShiftAssignmentStatus, ShiftAssignmentStatusType, ShiftStatus, ShiftStatusType } from '../types';
import { TransitionTable } from './assert-transition';

export const SHIFT_TRANSITIONS: TransitionTable<ShiftStatusType> = {
  [ShiftStatus.DRAFT]: [ShiftStatus.OPEN, ShiftStatus.CANCELLED],
  // Reachable only from an Internal Manager's approve/decline action on a
  // Venue Manager's submitted request — never entered via assertTransition
  // itself (the request row is INSERTed directly at this status).
  [ShiftStatus.PENDING_MANAGER_APPROVAL]: [ShiftStatus.OPEN, ShiftStatus.DECLINED],
  [ShiftStatus.DECLINED]: [],
  [ShiftStatus.OPEN]: [ShiftStatus.OFFERED, ShiftStatus.CANCELLED],
  [ShiftStatus.OFFERED]: [ShiftStatus.PARTIALLY_FILLED, ShiftStatus.FULLY_FILLED, ShiftStatus.CANCELLED],
  [ShiftStatus.PARTIALLY_FILLED]: [ShiftStatus.FULLY_FILLED, ShiftStatus.IN_PROGRESS, ShiftStatus.CANCELLED],
  [ShiftStatus.FULLY_FILLED]: [ShiftStatus.CONFIRMED, ShiftStatus.IN_PROGRESS, ShiftStatus.CANCELLED],
  [ShiftStatus.CONFIRMED]: [ShiftStatus.IN_PROGRESS, ShiftStatus.CANCELLED],
  [ShiftStatus.IN_PROGRESS]: [ShiftStatus.COMPLETED, ShiftStatus.CANCELLED],
  [ShiftStatus.COMPLETED]: [],
  [ShiftStatus.CANCELLED]: [],
};

export const SHIFT_ASSIGNMENT_TRANSITIONS: TransitionTable<ShiftAssignmentStatusType> = {
  [ShiftAssignmentStatus.OFFERED]: [
    ShiftAssignmentStatus.STAFF_ACCEPTED,
    ShiftAssignmentStatus.DECLINED,
    ShiftAssignmentStatus.WITHDRAWN,
  ],
  // Mirrors OFFER_TRANSITIONS' STAFF_ACCEPTED edge. Reached either by an
  // Internal Manager's explicit confirm action (offers on a directly-
  // created shift), or immediately server-side within `staffAccept` itself
  // for offers on a Venue-Manager-request-originated shift (`Shift.requestedBy
  // IS NOT NULL`) — see OfferService.staffAccept's own doc comment. Either
  // way the edge itself, and the seat-claiming logic it gates, stays the
  // same; only who/what triggers it differs.
  [ShiftAssignmentStatus.STAFF_ACCEPTED]: [ShiftAssignmentStatus.CONFIRMED, ShiftAssignmentStatus.REJECTED],
  [ShiftAssignmentStatus.CONFIRMED]: [ShiftAssignmentStatus.CANCELLED, ShiftAssignmentStatus.NO_SHOW, ShiftAssignmentStatus.COMPLETED],
  [ShiftAssignmentStatus.DECLINED]: [],
  [ShiftAssignmentStatus.REJECTED]: [],
  [ShiftAssignmentStatus.WITHDRAWN]: [],
  [ShiftAssignmentStatus.CANCELLED]: [],
  [ShiftAssignmentStatus.NO_SHOW]: [],
  [ShiftAssignmentStatus.COMPLETED]: [],
};
