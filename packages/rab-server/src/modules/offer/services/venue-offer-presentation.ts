import { isLateClockIn } from '../../scheduling/services/late-clock-in';

/**
 * Every lane is a real, distinguishable persisted state (offer → assignment → attendance → attendance review). Seat
 * metrics (Required / Filled / Open) are summary-only and never lanes. Each staff member occupies exactly ONE lane:
 * see `resolveVenueOfferKanbanStage` for the precedence.
 */
export const PIPELINE_STAGES = [
  'OFFERED',
  'WAITING',
  'STAFF ACCEPTED',
  'CONFIRMED',
  'LATE STAFF',
  'CLOCKED IN',
  'PENDING REVIEW',
  'CLOCKED OUT',
  'NO SHOW',
  'REJECTED',
  'CANCELLED',
  'DELETED OFFER',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export function resolveVenueOfferStatus(input: {
  status: string;
  required: number;
  confirmed: number;
  accepted: number;
  rejected: number;
}): string {
  if (input.status === 'declined') return 'Declined';
  if (input.status === 'pending_manager_approval') return 'Pending approval';
  if (input.confirmed >= input.required && input.required > 0)
    return 'Fully filled';
  if (input.rejected > 0) return `${input.rejected} staff rejected`;
  if (input.confirmed + input.accepted > 0) return 'Partially filled';
  return 'Offered';
}
/**
 * One lane per staff member, first match wins (later facts override earlier labels; history rows are never changed):
 *  1. attendance with a clock-out → PENDING REVIEW while a correction/dispute awaits the attendance review, else
 *     CLOCKED OUT;
 *  2. attendance with a clock-in only → PENDING REVIEW when flagged missing_clock_out / disputed, else CLOCKED IN;
 *  3. assignment no_show → NO SHOW (never Clocked In);
 *  4. shift cancelled or booking cancelled → CANCELLED;
 *  5. declined by staff, or acceptance rejected by the manager → REJECTED (never an active offer);
 *  6. offer expired / withdrawn before acceptance → DELETED OFFER;
 *  7. confirmed booking past start + grace with no clock-in → LATE STAFF, else CONFIRMED (not merely "accepted");
 *  8. staff accepted, awaiting confirmation → STAFF ACCEPTED;
 *  9. pending offer → WAITING once the staff member has opened it, else OFFERED.
 * Anything not listed (an unknown combination) lands in DELETED OFFER — never presented as a live offer.
 */
export function resolveVenueOfferKanbanStage(input: {
  offerStatus: string;
  assignmentStatus: string;
  shiftStatus: string;
  startsAt: Date;
  serverNow: Date;
  graceMinutes: number;
  hasAttendance: boolean;
  attendanceStatus?: string | null;
  attendanceReviewedAt?: Date | string | null;
  clockInAt?: Date | null;
  clockOutAt?: Date | null;
  notificationReadAt?: Date | null;
}): PipelineStage {
  const attendance = input.attendanceStatus ?? null;
  if (input.clockOutAt) {
    return ['under_review', 'disputed'].includes(attendance ?? '') && !input.attendanceReviewedAt
      ? 'PENDING REVIEW'
      : 'CLOCKED OUT';
  }
  if (input.clockInAt) {
    return ['missing_clock_out', 'disputed'].includes(attendance ?? '') ? 'PENDING REVIEW' : 'CLOCKED IN';
  }
  if (input.assignmentStatus === 'no_show') return 'NO SHOW';
  if (input.shiftStatus === 'cancelled' || input.assignmentStatus === 'cancelled') return 'CANCELLED';
  if (
    input.offerStatus === 'declined' ||
    input.assignmentStatus === 'declined' ||
    input.offerStatus === 'manager_rejected' ||
    input.assignmentStatus === 'rejected'
  )
    return 'REJECTED';
  if (['expired', 'withdrawn'].includes(input.offerStatus) || input.assignmentStatus === 'withdrawn')
    return 'DELETED OFFER';
  if (input.assignmentStatus === 'confirmed' || input.assignmentStatus === 'completed')
    return isLateClockIn(input) ? 'LATE STAFF' : 'CONFIRMED';
  if (input.assignmentStatus === 'staff_accepted' && input.offerStatus === 'staff_accepted') return 'STAFF ACCEPTED';
  if (input.assignmentStatus === 'offered' && input.offerStatus === 'pending')
    return input.notificationReadAt ? 'WAITING' : 'OFFERED';
  return 'DELETED OFFER';
}
export function canCancelVenueOffer(input: {
  startsAt: Date;
  serverNow: Date;
  shiftStatus: string;
  assignmentStatus: string;
  offerStatus: string;
  hasAttendance: boolean;
}): boolean {
  return (
    ![
      'cancelled',
      'completed',
      'declined',
      'pending_manager_approval',
    ].includes(input.shiftStatus) &&
    input.serverNow.getTime() < input.startsAt.getTime() - 15 * 60_000 &&
    !input.hasAttendance &&
    ((input.offerStatus === 'pending' &&
      input.assignmentStatus === 'offered') ||
      (input.offerStatus === 'staff_accepted' &&
        input.assignmentStatus === 'staff_accepted') ||
      (input.offerStatus === 'manager_confirmed' &&
        input.assignmentStatus === 'confirmed'))
  );
}
