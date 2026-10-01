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
