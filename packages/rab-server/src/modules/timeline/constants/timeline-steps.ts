/**
 * Wave 5 timeline — presentation keys for the shift / booking lifecycle, derived from the audit action. Display only:
 * a step is never a state, never accepted from a client and never used for an authorisation decision.
 */
export const TIMELINE_STEPS: Readonly<Record<string, string>> = {
  'shift.created': 'shift_created',
  'shift.published': 'shift_published',
  'shift.request_submitted': 'shift_requested',
  'shift.request_approved': 'shift_request_approved',
  'shift.cancelled': 'shift_cancelled',
  'shift.archived': 'archived',
  'shift.restored': 'restored',
  'offer.sent': 'offer_sent',
  'offer.accepted': 'offer_accepted',
  'offer.declined': 'offer_declined',
  'offer.confirmed': 'offer_approved',
  'offer.rejected': 'offer_rejected',
  'offer.withdrawn': 'offer_withdrawn',
  'offer.expired': 'offer_expired',
  'offer.expired_by_worker': 'offer_expired',
  'attendance.checked_in': 'check_in',
  'attendance.clocked_in': 'clock_in',
  'attendance.clocked_in_on_behalf': 'clock_in',
  'attendance.clocked_out': 'clock_out',
  'attendance.clocked_out_on_behalf': 'clock_out',
  'attendance.auto_clocked_out_geofence': 'clock_out',
  'attendance.manager_recorded': 'attendance_recorded',
  'attendance.corrected': 'attendance_corrected',
  'attendance.reviewed': 'review',
  'attendance.no_show_confirmed': 'no_show',
  'attendance.report_finalised': 'timesheet',
  'payroll_record.approved': 'payroll_approved',
  'payroll_record.rejected': 'payroll_rejected',
  'payroll_record.shift_statement_generated': 'statement',
  'staff.archived': 'archived',
  'staff.restored': 'restored',
};

/**
 * Metadata keys a timeline may show. Everything else in `audit_log.metadata` is dropped (allowlist, not denylist):
 * no emails, hashes, file checksums, coordinates, IPs or other people's identifiers ever leave through the timeline.
 * Values are returned only when they are primitives (or short arrays of primitives).
 */
export const TIMELINE_METADATA_KEYS: ReadonlySet<string> = new Set([
  'reason',
  'previousStatus',
  'status',
  'method',
  'source',
  'outcome',
  'checkedIn',
  'signedOff',
  'staffCount',
  'bulk',
  'provisionalMarkedBy',
  'created',
  'kind',
  'offerKind',
  'requiredCount',
  'name',
  'staffRef',
  'type',
  'workDate',
  'workedMinutes',
  'locationVerified',
  'clockInMethod',
  'clockOutMethod',
  'shiftId',
  'offerId',
  'attendanceId',
  'staffProfileId',
]);

/** Money keys: shown only when the caller may access payroll (payroll.view and not venue-scoped). */
export const TIMELINE_MONEY_KEYS: ReadonlySet<string> = new Set(['amountPence', 'payRatePence', 'earnedPence', 'grossPence', 'estimatedPayPence']);
