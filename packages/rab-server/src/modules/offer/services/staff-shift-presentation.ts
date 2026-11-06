import { OFFER_CLOSED_REASON, OfferClosedReasonType, POST_SHIFT_COMPLETE_MS, POST_SHIFT_EXPIRED_MS } from '@rab/shared';

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
  /** From `confirmationProjectionSql` (database clock). Omitted by callers with no deadline context: treated as null. */
  closedReason?: OfferClosedReasonType | null;
  /** Staff reads only: passed through unchanged (display only). */
  canAccept?: boolean;
}) {
  const { serverNow, clockInAt, clockOutAt } = input;
  const now = serverNow.getTime();
  let state: string;
  let nextTransitionAt: Date | null = null;
  if (clockOutAt && now >= clockOutAt.getTime()) {
    // PHASE 7.1 — 1h/2h (previously 2h/6h); shared with the authoritative
    // `PostShiftLifecycleService` via `@rab/shared` so this display-only
    // `nextTransitionAt` hint never drifts from the persisted milestones.
    const complete = clockOutAt.getTime() + POST_SHIFT_COMPLETE_MS;
    const expired = clockOutAt.getTime() + POST_SHIFT_EXPIRED_MS;
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
    input.offerStatus === 'staff_accepted' &&
    input.closedReason === OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED
  ) {
    // Past its manager-confirmation deadline but not yet withdrawn by the Worker: it can never be confirmed, so it is
    // already presented as closed (state value set unchanged, so old app builds show "Not confirmed", never "Awaiting").
    state = 'rejected';
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
    closedReason: input.closedReason ?? null,
    ...(input.canAccept !== undefined ? { canAccept: input.canAccept } : {}),
  };
}
