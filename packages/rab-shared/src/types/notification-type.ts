/**
 * The real `notify()` call sites that exist today — not an invented
 * category list. The 6 `OFFER_*` values are also the only ones present in
 * `notification_preference`'s own CHECK constraint (`SettingsSchema
 * 1786666500000`) — the 5 worker-originated values below have no
 * preference-row support yet (safe defaults apply: in-app on, email off),
 * since nothing lets a user customize them yet.
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
} as const;

export type NotificationTypeType = (typeof NotificationType)[keyof typeof NotificationType];
