export const AttendanceStatus = {
  SCHEDULED: 'scheduled',
  CLOCKED_IN: 'clocked_in',
  ON_BREAK: 'on_break',
  CLOCKED_OUT: 'clocked_out',
  LATE: 'late',
  MISSING_CLOCK_OUT: 'missing_clock_out',
  ABSENT: 'absent',
  UNDER_REVIEW: 'under_review',
  APPROVED: 'approved',
  DISPUTED: 'disputed',
} as const;

export type AttendanceStatusType = (typeof AttendanceStatus)[keyof typeof AttendanceStatus];
