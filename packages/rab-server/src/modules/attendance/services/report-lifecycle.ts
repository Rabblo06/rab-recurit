import { SHIFT_ACTION_WINDOW_HOURS } from '../../scheduling/utils/shift-action-window';

/**
 * Report / shift display lifecycle (owner decision 2026-10-17, "five-hour policy"). Two independent deadlines, both
 * anchored on server-authoritative timestamps and evaluated against DATABASE time at read:
 *
 *  A. Action window — a shift stops being actionable `ACTION_WINDOW_HOURS` after its scheduled end. After that it is
 *     never shown as "In progress"; it reads "Action expired", flagged when attendance is still unresolved. The
 *     canonical `shift.status`, assignments and attendance are NOT changed by this (no forced completion).
 *  B. History move — a report whose final timesheet was actually DELIVERED (every non-cancelled outbox row SENT) moves
 *     from current Reports to History `SENT_VISIBLE_HOURS` after the last delivery. An undelivered/unfinalised report is
 *     never silently archived: past the action window it is listed in History AND kept in Reports as needing attention.
 *
 * This is display/listing only. It does not touch the QR attendance window (CLOCK_IN_EARLY_MINUTES /
 * QR_POST_SHIFT_GRACE_MINUTES), offer expiry, or the no-show / missing-clock-out jobs. `REPORT_BUCKET_SQL` below is the
 * same rule in SQL (used to filter and paginate); a spec asserts the two agree.
 */
export const ACTION_WINDOW_HOURS = SHIFT_ACTION_WINDOW_HOURS;
export const SENT_VISIBLE_HOURS = 5;
const HOUR_MS = 3_600_000;

export type DeliveryState = 'not_finalised' | 'generating' | 'queued' | 'sent' | 'failed' | 'no_recipients';

export type ReportDisplayStatus =
  | 'cancelled'
  | 'upcoming'
  | 'waiting_clock_in'
  | 'in_progress'
  | 'waiting_clock_out'
  | 'needs_review'
  | 'ready_to_finalise'
  | 'generating'
  | 'queued'
  | 'sent'
  | 'delivery_failed'
  | 'action_expired';

export const REPORT_DISPLAY_LABEL: Record<ReportDisplayStatus, string> = {
  cancelled: 'Cancelled',
  upcoming: 'Upcoming',
  waiting_clock_in: 'Waiting for clock-in',
  in_progress: 'In progress',
  waiting_clock_out: 'Waiting for clock-out',
  needs_review: 'Needs review',
  ready_to_finalise: 'Ready to finalise',
  generating: 'Generating PDF',
  queued: 'Queued for delivery',
  sent: 'Sent',
  delivery_failed: 'Delivery failed',
  action_expired: 'Action expired',
};

/** Per-report email delivery counts for the FINAL timesheet file (core.email_outbox, CANCELLED rows excluded). */
export interface DeliveryCounts {
  pending: number;
  sent: number;
  failed: number;
  lastSentAt: Date | null;
}

export interface LifecycleInput {
  now: Date;
  shiftStatus: string;
  startsAt: Date;
  endsAt: Date;
  /** Confirmed / completed / no-show seats on the report. */
  staffCount: number;
  /** Attendance rows still clocked in or on break. */
  openAttendance: number;
  /** Seats with no clock-out and no no-show outcome (the report-readiness blockers). */
  unresolved: number;
  /** Seats whose attendance review is not completed yet (finalisation blocker). Optional for older callers. */
  unreviewed?: number;
  /** Any attendance row exists (someone clocked in). */
  anyClockIn: boolean;
  reportStatus: 'pending' | 'ready' | 'finalised';
  /** `shift_report.final_pdf_sent_at`: when the final PDF's emails were QUEUED (not delivered). */
  finalQueuedAt: Date | null;
  delivery: DeliveryCounts;
}

export interface ReportLifecycle {
  displayStatus: ReportDisplayStatus;
  displayLabel: string;
  actionExpiresAt: string;
  actionExpired: boolean;
  needsAttendanceReview: boolean;
  needsAttention: boolean;
  deliveryState: DeliveryState;
  sentAt: string | null;
  /** When the report moves (or moved) to History; null while that time is not yet known. */
  historyAt: string | null;
  inCurrent: boolean;
  inHistory: boolean;
}

export function deliveryState(reportStatus: LifecycleInput['reportStatus'], finalQueuedAt: Date | null, d: DeliveryCounts): DeliveryState {
  if (reportStatus !== 'finalised') return 'not_finalised';
  if (!finalQueuedAt) return 'generating';
  if (d.pending > 0) return 'queued';
  if (d.failed > 0) return 'failed';
  if (d.sent > 0) return 'sent';
  return 'no_recipients';
}

export function reportLifecycle(i: LifecycleInput): ReportLifecycle {
  const now = i.now.getTime();
  const expiresAt = i.endsAt.getTime() + ACTION_WINDOW_HOURS * HOUR_MS;
  const actionExpired = now >= expiresAt;
  const delivery = deliveryState(i.reportStatus, i.finalQueuedAt, i.delivery);
  const delivered = delivery === 'sent';
  const ended = now >= i.endsAt.getTime();
  const needsAttendanceReview = ended && !delivered && i.reportStatus !== 'finalised' && i.openAttendance + i.unresolved + (i.unreviewed ?? 0) > 0;

  let status: ReportDisplayStatus;
  if (i.shiftStatus === 'cancelled') status = 'cancelled';
  else if (delivery === 'sent') status = 'sent';
  else if (delivery === 'failed' || delivery === 'no_recipients') status = 'delivery_failed';
  else if (delivery === 'queued') status = 'queued';
  else if (delivery === 'generating') status = 'generating';
  else if (actionExpired) status = 'action_expired';
  else if (now < i.startsAt.getTime()) status = i.staffCount > 0 ? 'waiting_clock_in' : 'upcoming';
  else if (!ended) status = i.openAttendance > 0 ? 'in_progress' : i.anyClockIn ? 'in_progress' : 'waiting_clock_in';
  else if (i.openAttendance > 0) status = 'waiting_clock_out';
  else if (i.unresolved > 0 || (i.unreviewed ?? 0) > 0) status = 'needs_review';
  else status = 'ready_to_finalise';

  const historyAtMs = delivered && i.delivery.lastSentAt ? i.delivery.lastSentAt.getTime() + SENT_VISIBLE_HOURS * HOUR_MS : delivered ? null : expiresAt;
  const inHistory = historyAtMs !== null && now >= historyAtMs;
  // An obligation that is not done is never hidden: undelivered past the window, or a failed delivery at any time.
  const needsAttention = i.shiftStatus !== 'cancelled' && !delivered && (actionExpired || delivery === 'failed' || delivery === 'no_recipients');

  return {
    displayStatus: status,
    displayLabel: REPORT_DISPLAY_LABEL[status],
    actionExpiresAt: new Date(expiresAt).toISOString(),
    actionExpired,
    needsAttendanceReview,
    needsAttention,
    deliveryState: delivery,
    sentAt: delivered && i.delivery.lastSentAt ? i.delivery.lastSentAt.toISOString() : null,
    historyAt: historyAtMs === null ? null : new Date(historyAtMs).toISOString(),
    inCurrent: !inHistory || needsAttention,
    inHistory,
  };
}

/**
 * SQL twin of `inHistory` / `needsAttention` for filtering + pagination, evaluated with `now()` (transaction DB time).
 * Expects columns: `ends_at`, `shift_status`, `report_status`, `final_queued_at`, `d_pending`, `d_sent`, `d_failed`,
 * `d_last_sent_at` on the row alias `r`.
 */
const DELIVERED_SQL = `(r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND r.d_failed = 0 AND r.d_sent > 0)`;
export const REPORT_IN_HISTORY_SQL = `(CASE WHEN ${DELIVERED_SQL} THEN now() >= r.d_last_sent_at + interval '${SENT_VISIBLE_HOURS} hours'
  ELSE now() >= r.ends_at + interval '${ACTION_WINDOW_HOURS} hours' END)`;
export const REPORT_NEEDS_ATTENTION_SQL = `(r.shift_status <> 'cancelled' AND NOT ${DELIVERED_SQL} AND (now() >= r.ends_at + interval '${ACTION_WINDOW_HOURS} hours'
  OR (r.report_status = 'finalised' AND r.final_queued_at IS NOT NULL AND r.d_pending = 0 AND (r.d_failed > 0 OR r.d_sent = 0))))`;
