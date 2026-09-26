/** Read-only projection. Never changes Offer, Assignment, Attendance or payroll. */
export function resolveStaffShiftPresentation(input: {
  offerStatus: string;
  assignmentStatus: string;
  shiftStatus: string;
  attendanceStatus?: string | null;
  clockInAt?: Date | null;
  clockOutAt?: Date | null;
  completedAt?: Date | null;
  expiredAt?: Date | null;
  startsAt: Date;
  endsAt: Date;
  serverNow: Date;
  timezone: string;
}) {
  const { serverNow, clockInAt, clockOutAt } = input;
  const now = serverNow.getTime();
  let state: string;
  let nextTransitionAt: Date | null = null;
  if (clockOutAt && now >= clockOutAt.getTime()) {
    const complete = clockOutAt.getTime() + 2 * 3600000;
    const expired = clockOutAt.getTime() + 6 * 3600000;
    state = input.expiredAt
      ? 'expired'
      : input.completedAt
        ? 'complete'
        : 'clockedOut';
    nextTransitionAt = input.expiredAt
      ? null
      : input.completedAt
        ? new Date(expired)
        : new Date(complete);
  } else if (
    clockInAt &&
    (clockOutAt ||
      ['clocked_in', 'on_break'].includes(input.attendanceStatus ?? ''))
  ) {
    state = 'live';
    nextTransitionAt = clockOutAt ?? null;
  } else if (
    input.shiftStatus === 'cancelled' ||
    ['cancelled', 'withdrawn'].includes(input.assignmentStatus)
  ) {
    state = 'cancelled';
  } else if (
    ['expired', 'declined', 'withdrawn', 'manager_rejected'].includes(
      input.offerStatus,
    )
  ) {
    state =
      input.offerStatus === 'withdrawn'
        ? 'cancelled'
        : input.offerStatus === 'manager_rejected'
          ? 'rejected'
          : input.offerStatus;
  } else if (
    input.assignmentStatus === 'confirmed' &&
    input.offerStatus === 'manager_confirmed'
  ) {
    state = now >= input.endsAt.getTime() ? 'ended' : 'confirmed';
  } else if (['no_show', 'completed'].includes(input.assignmentStatus)) {
    state = 'ended';
  } else {
    state = 'pending';
  }
  const day = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: input.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  const isToday =
    day(input.startsAt) === day(serverNow) ||
    (now >= input.startsAt.getTime() && now < input.endsAt.getTime());
  const homeLabel =
    state === 'live'
      ? 'Live Shift'
      : ['clockedOut', 'complete', 'expired'].includes(state)
        ? (
            {
              clockedOut: 'Clocked Out',
              complete: 'Complete',
              expired: 'Expired',
            } as Record<string, string>
          )[state]
        : isToday
          ? "Today's Shift"
          : 'Next Shift';
  return {
    state,
    homeLabel,
    isToday,
    serverNow,
    nextTransitionAt,
    clockInAt: clockInAt ?? null,
    clockOutAt: clockOutAt ?? null,
    timezone: input.timezone,
  };
}
