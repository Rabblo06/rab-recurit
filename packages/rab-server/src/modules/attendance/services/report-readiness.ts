/** Shared report readiness: unresolved confirmed seats and open attendance fail closed; no-shows are resolved non-working outcomes. */
export function isReportReady(
  rows: Array<{
    assignmentStatus: string;
    clockOutAt?: Date | string | null;
    attendanceStatus?: string | null;
  }>,
): boolean {
  return (
    rows.length > 0 &&
    rows.every(
      (r) =>
        !['clocked_in', 'on_break'].includes(r.attendanceStatus ?? '') &&
        (r.assignmentStatus === 'no_show' || !!r.clockOutAt),
    )
  );
}

/**
 * Finalise & send gate (owner brief 2026-10-18): attendance resolved (`isReportReady`) AND every seat's attendance
 * review completed (`shift_assignment.attendance_reviewed_at`, set only by the explicit review action and cleared by
 * any later correction). A staff performance rating is separate and never part of this gate.
 */
export function isReportFinalisable(
  rows: Array<{
    assignmentStatus: string;
    clockOutAt?: Date | string | null;
    attendanceStatus?: string | null;
    attendanceReviewed: boolean;
  }>,
): boolean {
  return isReportReady(rows) && rows.every((r) => r.attendanceReviewed);
}
