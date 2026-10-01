/** Phase 3 late predicate, shared by the worker and read projections. */
export function isLateClockIn(input: {
  assignmentStatus: string;
  shiftStatus: string;
  startsAt: Date;
  serverNow: Date;
  graceMinutes: number;
  hasAttendance: boolean;
}): boolean {
  return (
    input.assignmentStatus === 'confirmed' &&
    !['cancelled', 'completed'].includes(input.shiftStatus) &&
    !input.hasAttendance &&
    input.startsAt.getTime() <=
      input.serverNow.getTime() - input.graceMinutes * 60_000
  );
}
