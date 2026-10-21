/**
 * The real `notify()` call sites that exist today — not an invented
 * category list. Every value here must also exist in `notification_
 * preference.notification_type`'s own CHECK constraint
 * (`NotificationPreferenceTypeWiden1786673000000`, itself superseding
 * `SettingsSchema1786666500000`'s original 6-value `OFFER_*`-only list) — a
 * value added here without a matching migration widening that CHECK is a
 * live bug: `UpdateNotificationPreferenceDto`'s `@IsIn(Object.values(
 * NotificationType))` accepts it immediately, so the first user who
 * customizes a preference for it 500s on the CHECK violation. Most values
 * have no preference ROW yet regardless (safe defaults apply: in-app on,
 * email off) since no UI lets a user customize most of these — but the
 * CHECK constraint must always already allow the value before that day
 * comes.
 */
export const NotificationType = {
  OFFER_SENT: 'offer_sent',
  OFFER_EXPIRED: 'offer_expired',
  OFFER_ACCEPTED: 'offer_accepted',
  OFFER_DECLINED: 'offer_declined',
  OFFER_CONFIRMED: 'offer_confirmed',
  OFFER_REJECTED: 'offer_rejected',
  SHIFT_REMINDER_24H: 'shift_reminder_24h',
  SHIFT_REMINDER_2H: 'shift_reminder_2h',
  SHIFT_REMINDER_30M: 'shift_reminder_30m',
  SHIFT_ASSIGNMENT_NO_SHOW: 'shift_assignment_no_show',
  ATTENDANCE_MISSING_CLOCK_OUT: 'attendance_missing_clock_out',
  // Venue-Manager-submits / Internal-Manager-approves workflow — no
  // `notification_preference` CHECK-constraint entry needed (that table is
  // only ever written when a user has explicitly customized a preference;
  // reading a type with no row just falls back to the same safe in-app-on/
  // email-off defaults every other type already has).
  SHIFT_REQUEST_SUBMITTED: 'shift_request_submitted',
  SHIFT_REQUEST_APPROVED: 'shift_request_approved',
  SHIFT_REQUEST_DECLINED: 'shift_request_declined',
  // Internal Manager edits a still-pending request's staff selection before
  // approving it (Venue Offers workflow) — the removed Staff never received
  // an offer, so this is the Venue Manager's only signal that their
  // selection changed underneath them.
  SHIFT_REQUEST_STAFF_REMOVED: 'shift_request_staff_removed',
  // rab-worker package migration additions. Deliberately NOT adding a
  // separate "staff response timeout" type — an unanswered offer past its
  // deadline is already OFFER_EXPIRED (see offer-expiry.job.ts); this list
  // only grows for genuinely new events, never a second name for one that
  // already exists.
  LATE_CLOCK_IN: 'late_clock_in',
  SHIFT_CANCELLED: 'shift_cancelled',
  REPLACEMENT_REQUIRED: 'replacement_required',
  MANAGER_CONFIRMATION_TIMEOUT: 'manager_confirmation_timeout',
  // Staff Shift Reminders completion — fires once, when `shift.startsAt -
  // CLOCK_IN_EARLY_MINUTES` is first reached for a still-confirmed
  // assignment (see shift-monitor.job.ts's REMINDER_WINDOWS). Informational
  // only: never performs a clock-in, never bypasses AttendanceService's own
  // location/geofence/QR validation.
  CLOCK_IN_WINDOW_OPEN: 'clock_in_window_open',
  // Payroll approval (ApprovedShiftStatement1786719100000, which also widens the preference CHECK): the worker generated
  // the staff member's Approved Shift Statement for an approved payroll record. Sent only once the document exists.
  SHIFT_STATEMENT_READY: 'shift_statement_ready',
  // PayrollCalendarRunsPayslips1786719200000: the provider's official payslip PDF was uploaded for a finalised run.
  PAYSLIP_AVAILABLE: 'payslip_available',
  // ...and a calendar period ended with records still waiting for a timesheet or approval (workspace owner).
  PAYROLL_PERIOD_ATTENTION: 'payroll_period_attention',
} as const;

export type NotificationTypeType = (typeof NotificationType)[keyof typeof NotificationType];
