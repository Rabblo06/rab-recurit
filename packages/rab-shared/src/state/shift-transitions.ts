import { ShiftAssignmentStatus, ShiftAssignmentStatusType, ShiftStatus, ShiftStatusType } from '../types';
import { TransitionTable } from './assert-transition';

export const SHIFT_TRANSITIONS: TransitionTable<ShiftStatusType> = {
  [ShiftStatus.DRAFT]: [ShiftStatus.OPEN, ShiftStatus.CANCELLED],
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
  // Mirrors OFFER_TRANSITIONS' STAFF_ACCEPTED edge — CONFIRMED is reachable
  // only via the manager's explicit confirm action, never automatically.
  [ShiftAssignmentStatus.STAFF_ACCEPTED]: [ShiftAssignmentStatus.CONFIRMED, ShiftAssignmentStatus.REJECTED],
  [ShiftAssignmentStatus.CONFIRMED]: [ShiftAssignmentStatus.CANCELLED, ShiftAssignmentStatus.NO_SHOW, ShiftAssignmentStatus.COMPLETED],
  [ShiftAssignmentStatus.DECLINED]: [],
  [ShiftAssignmentStatus.REJECTED]: [],
  [ShiftAssignmentStatus.WITHDRAWN]: [],
  [ShiftAssignmentStatus.CANCELLED]: [],
  [ShiftAssignmentStatus.NO_SHOW]: [],
  [ShiftAssignmentStatus.COMPLETED]: [],
};
