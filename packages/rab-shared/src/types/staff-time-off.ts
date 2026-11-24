/**
 * Date-specific staff time off (`core.staff_time_off`, StaffTimeOffSchema1786722230000; owner decisions 42 and 48).
 *
 * Owner decision 42: staff REQUEST time off and a manager APPROVES it; APPROVED time off is a hard block on new offers for
 * those dates, judged in the organisation's time zone. A request that is still `requested` does not block (flagged reading
 * of decision 42). The state machine is STAFF_TIME_OFF_TRANSITIONS (state/staff-time-off-transitions.ts); no endpoint ever
 * accepts one of these values from a client — the mutations are named actions (request, approve, decline, cancel).
 */
export const StaffTimeOffStatus = {
  REQUESTED: 'requested',
  APPROVED: 'approved',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
} as const;
export type StaffTimeOffStatusType =
  (typeof StaffTimeOffStatus)[keyof typeof StaffTimeOffStatus];

/** Longest single time-off range, in calendar days, both ends inclusive (the table's CHECK: ends_on - starts_on < 366). */
export const STAFF_TIME_OFF_MAX_DAYS = 366;
/** Longest staff note and decline reason, in characters (the table's CHECKs). */
export const STAFF_TIME_OFF_TEXT_MAX = 500;

/** 409 code of the offer hard block (decision 42), at send and at confirmation. */
export const STAFF_TIME_OFF_CONFLICT_CODE = 'STAFF_TIME_OFF';
