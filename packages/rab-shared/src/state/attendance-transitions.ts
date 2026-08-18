import { AttendanceStatus, AttendanceStatusType } from '../types';
import { TransitionTable } from './assert-transition';

export const ATTENDANCE_TRANSITIONS: TransitionTable<AttendanceStatusType> = {
  [AttendanceStatus.SCHEDULED]: [AttendanceStatus.CLOCKED_IN, AttendanceStatus.ABSENT],
  [AttendanceStatus.CLOCKED_IN]: [AttendanceStatus.ON_BREAK, AttendanceStatus.CLOCKED_OUT, AttendanceStatus.MISSING_CLOCK_OUT],
  [AttendanceStatus.ON_BREAK]: [AttendanceStatus.CLOCKED_IN, AttendanceStatus.CLOCKED_OUT],
  [AttendanceStatus.CLOCKED_OUT]: [AttendanceStatus.UNDER_REVIEW, AttendanceStatus.APPROVED],
  [AttendanceStatus.MISSING_CLOCK_OUT]: [AttendanceStatus.CLOCKED_OUT, AttendanceStatus.DISPUTED],
  [AttendanceStatus.LATE]: [AttendanceStatus.CLOCKED_OUT, AttendanceStatus.UNDER_REVIEW],
  [AttendanceStatus.UNDER_REVIEW]: [AttendanceStatus.APPROVED, AttendanceStatus.DISPUTED],
  [AttendanceStatus.DISPUTED]: [AttendanceStatus.APPROVED, AttendanceStatus.CLOCKED_OUT],
  // Terminal: reopening an approved record requires an attendance_correction
  // row (rab-workforce-architecture.md §11), never a direct status write.
  [AttendanceStatus.APPROVED]: [],
  [AttendanceStatus.ABSENT]: [AttendanceStatus.DISPUTED],
};
