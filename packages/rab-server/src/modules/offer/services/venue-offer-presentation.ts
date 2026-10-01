import { isLateClockIn } from '../../scheduling/services/late-clock-in';

export const PIPELINE_STAGES = [
  'OFFERED',
  'WAITING',
  'STAFF ACCEPTED',
  'LATE STAFF',
  'CLOCKED IN',
  'CLOCKED OUT',
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
export function resolveVenueOfferKanbanStage(input: {
  offerStatus: string;
  assignmentStatus: string;
  shiftStatus: string;
  startsAt: Date;
  serverNow: Date;
  graceMinutes: number;
  hasAttendance: boolean;
  clockInAt?: Date | null;
  clockOutAt?: Date | null;
  notificationReadAt?: Date | null;
}): PipelineStage {
  if (input.clockOutAt) return 'CLOCKED OUT';
  if (input.clockInAt) return 'CLOCKED IN';
  if (
    ['declined', 'expired', 'withdrawn', 'manager_rejected'].includes(
      input.offerStatus,
    ) ||
    ['cancelled', 'withdrawn', 'declined', 'rejected'].includes(
      input.assignmentStatus,
    ) ||
    input.shiftStatus === 'cancelled'
  )
    return 'DELETED OFFER';
  if (isLateClockIn(input)) return 'LATE STAFF';
  if (['staff_accepted', 'manager_confirmed'].includes(input.offerStatus))
    return 'STAFF ACCEPTED';
  return input.notificationReadAt ? 'WAITING' : 'OFFERED';
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
