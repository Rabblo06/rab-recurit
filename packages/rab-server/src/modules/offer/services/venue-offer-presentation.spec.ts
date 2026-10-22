import {
  canCancelVenueOffer,
  PIPELINE_STAGE_GROUPS,
  PIPELINE_STAGES,
  resolveVenueOfferKanbanStage,
  resolveVenueOfferStatus,
} from './venue-offer-presentation';
const base = {
  offerStatus: 'pending',
  assignmentStatus: 'offered',
  shiftStatus: 'offered',
  startsAt: new Date('2030-01-01T12:00:00Z'),
  serverNow: new Date('2030-01-01T10:00:00Z'),
  graceMinutes: 5,
  hasAttendance: false,
};
describe('Venue Offer presentation', () => {
  it.each([
    ['pending_manager_approval', 0, 0, 0, 'Pending approval'],
    ['declined', 0, 0, 0, 'Declined'],
    ['offered', 0, 0, 0, 'Offered'],
    ['partially_filled', 1, 0, 0, 'Partially filled'],
    ['offered', 0, 1, 0, 'Partially filled'],
    ['offered', 0, 0, 1, '1 staff rejected'],
    ['offered', 1, 0, 2, '2 staff rejected'],
    ['confirmed', 2, 0, 2, 'Fully filled'],
  ])(
    'projects %s counts (%i,%i,%i)',
    (status, confirmed, accepted, rejected, expected) =>
      expect(
        resolveVenueOfferStatus({
          status,
          required: 2,
          confirmed,
          accepted,
          rejected,
        }),
      ).toBe(expected),
  );
  const confirmed = { offerStatus: 'manager_confirmed', assignmentStatus: 'confirmed' };
  const working = { ...confirmed, hasAttendance: true, clockInAt: new Date('2030-01-01T12:01:00Z') };
  it.each([
    [{}, 'offered'],
    [{ notificationReadAt: new Date() }, 'waiting'],
    [{ offerStatus: 'staff_accepted', assignmentStatus: 'staff_accepted' }, 'staff_accepted'],
    // Confirmed staff are not shown as merely "accepted" while waiting for the start.
    [confirmed, 'confirmed'],
    [{ ...confirmed, serverNow: new Date('2030-01-01T12:05:00Z') }, 'late'],
    [{ ...working, attendanceStatus: 'clocked_in' }, 'clocked_in'],
    [{ ...working, attendanceStatus: 'on_break' }, 'clocked_in'],
    [{ ...working, attendanceStatus: 'missing_clock_out' }, 'pending_review'],
    [{ ...working, attendanceStatus: 'clocked_out', clockOutAt: new Date() }, 'clocked_out'],
    // A corrected record waits for the attendance review; once reviewed it is simply clocked out.
    [{ ...working, attendanceStatus: 'under_review', clockOutAt: new Date() }, 'pending_review'],
    [{ ...working, attendanceStatus: 'under_review', clockOutAt: new Date(), attendanceReviewedAt: new Date() }, 'clocked_out'],
    [{ ...working, attendanceStatus: 'approved', clockOutAt: new Date() }, 'clocked_out'],
    // The worker's provisional mark needs review; only a manager-confirmed no-show is NO SHOW (owner rule 2026-10-21).
    [{ ...confirmed, assignmentStatus: 'no_show' }, 'attendance_missing'],
    [{ ...confirmed, assignmentStatus: 'no_show', attendanceReviewedAt: new Date() }, 'no_show'],
    // Check In (arrival evidence) without a clock-in; it beats LATE STAFF; past the booking's end it needs review.
    [{ ...confirmed, checkedInAt: new Date('2030-01-01T11:55:00Z') }, 'checked_in'],
    [{ ...confirmed, checkedInAt: new Date('2030-01-01T11:55:00Z'), serverNow: new Date('2030-01-01T12:20:00Z') }, 'checked_in'],
    [{ ...confirmed, checkedInAt: new Date('2030-01-01T11:55:00Z'), endsAt: new Date('2030-01-01T13:00:00Z'), serverNow: new Date('2030-01-01T13:00:00Z') }, 'attendance_missing'],
    [{ ...working, checkedInAt: new Date('2030-01-01T11:55:00Z'), attendanceStatus: 'clocked_in' }, 'clocked_in'],
    [{ offerStatus: 'declined', assignmentStatus: 'declined' }, 'rejected'],
    [{ offerStatus: 'manager_rejected', assignmentStatus: 'rejected' }, 'rejected'],
    // Manager pipeline cancellation of an accepted/confirmed booking: assignment cancelled.
    [{ offerStatus: 'manager_rejected', assignmentStatus: 'cancelled' }, 'cancelled'],
    [{ ...confirmed, assignmentStatus: 'cancelled' }, 'cancelled'],
    [{ ...confirmed, shiftStatus: 'cancelled' }, 'cancelled'],
    // Withdrawn before acceptance / never answered.
    [{ offerStatus: 'withdrawn', assignmentStatus: 'withdrawn' }, 'deleted'],
    [{ offerStatus: 'expired' }, 'deleted'],
    // Unknown combination: never shown as a live offer.
    [{ offerStatus: 'pending', assignmentStatus: 'mystery' }, 'deleted'],
  ])('stage reconstructs from persisted facts %#', (changes, stage) =>
    expect(resolveVenueOfferKanbanStage({ ...base, ...changes })).toBe(stage),
  );
  it('a no-show is never Clocked In and rejected staff are never an active offer', () => {
    expect(resolveVenueOfferKanbanStage({ ...base, ...confirmed, assignmentStatus: 'no_show', attendanceReviewedAt: new Date(), serverNow: new Date('2030-01-01T13:00:00Z') })).toBe('no_show');
    expect(resolveVenueOfferKanbanStage({ ...base, offerStatus: 'declined', notificationReadAt: new Date() })).toBe('rejected');
  });
  it('every lane is reachable and listed exactly once', () => {
    expect(new Set(PIPELINE_STAGES).size).toBe(PIPELINE_STAGES.length);
    expect(PIPELINE_STAGES).toHaveLength(14);
    const grouped = [...PIPELINE_STAGE_GROUPS.staffing, ...PIPELINE_STAGE_GROUPS.attendance, ...PIPELINE_STAGE_GROUPS.closed];
    expect(grouped).toEqual([...PIPELINE_STAGES]);
  });
  it.each([
    [-1, true],
    [0, false],
    [1000, false],
  ])('cutoff offset %i ms', (offset, allowed) =>
    expect(
      canCancelVenueOffer({
        ...base,
        serverNow: new Date(base.startsAt.getTime() - 900000 + offset),
      }),
    ).toBe(allowed),
  );
  it.each([
    { hasAttendance: true },
    { shiftStatus: 'cancelled' },
    { shiftStatus: 'completed' },
    { assignmentStatus: 'cancelled' },
  ])('blocks resolved/working booking', (changes) =>
    expect(canCancelVenueOffer({ ...base, ...changes })).toBe(false),
  );
  it('late clock-in and geofence clock-out override late stage', () => {
    const late = {
      ...base,
      offerStatus: 'manager_confirmed',
      assignmentStatus: 'confirmed',
      serverNow: new Date('2030-01-01T12:10:00Z'),
    };
    expect(resolveVenueOfferKanbanStage(late)).toBe('late');
    expect(
      resolveVenueOfferKanbanStage({
        ...late,
        hasAttendance: true,
        clockInAt: late.serverNow,
      }),
    ).toBe('clocked_in');
    expect(
      resolveVenueOfferKanbanStage({
        ...late,
        hasAttendance: true,
        clockInAt: late.serverNow,
        clockOutAt: late.serverNow,
        attendanceStatus: 'clocked_out',
      }),
    ).toBe('clocked_out');
  });
});
