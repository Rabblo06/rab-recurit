import {
  canCancelVenueOffer,
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
    [{}, 'OFFERED'],
    [{ notificationReadAt: new Date() }, 'WAITING'],
    [{ offerStatus: 'staff_accepted', assignmentStatus: 'staff_accepted' }, 'STAFF ACCEPTED'],
    // Confirmed staff are not shown as merely "accepted" while waiting for the start.
    [confirmed, 'CONFIRMED'],
    [{ ...confirmed, serverNow: new Date('2030-01-01T12:05:00Z') }, 'LATE STAFF'],
    [{ ...working, attendanceStatus: 'clocked_in' }, 'CLOCKED IN'],
    [{ ...working, attendanceStatus: 'on_break' }, 'CLOCKED IN'],
    [{ ...working, attendanceStatus: 'missing_clock_out' }, 'PENDING REVIEW'],
    [{ ...working, attendanceStatus: 'clocked_out', clockOutAt: new Date() }, 'CLOCKED OUT'],
    // A corrected record waits for the attendance review; once reviewed it is simply clocked out.
    [{ ...working, attendanceStatus: 'under_review', clockOutAt: new Date() }, 'PENDING REVIEW'],
    [{ ...working, attendanceStatus: 'under_review', clockOutAt: new Date(), attendanceReviewedAt: new Date() }, 'CLOCKED OUT'],
    [{ ...working, attendanceStatus: 'approved', clockOutAt: new Date() }, 'CLOCKED OUT'],
    [{ ...confirmed, assignmentStatus: 'no_show' }, 'NO SHOW'],
    [{ offerStatus: 'declined', assignmentStatus: 'declined' }, 'REJECTED'],
    [{ offerStatus: 'manager_rejected', assignmentStatus: 'rejected' }, 'REJECTED'],
    // Manager pipeline cancellation of an accepted/confirmed booking: assignment cancelled.
    [{ offerStatus: 'manager_rejected', assignmentStatus: 'cancelled' }, 'CANCELLED'],
    [{ ...confirmed, assignmentStatus: 'cancelled' }, 'CANCELLED'],
    [{ ...confirmed, shiftStatus: 'cancelled' }, 'CANCELLED'],
    // Withdrawn before acceptance / never answered.
    [{ offerStatus: 'withdrawn', assignmentStatus: 'withdrawn' }, 'DELETED OFFER'],
    [{ offerStatus: 'expired' }, 'DELETED OFFER'],
    // Unknown combination: never shown as a live offer.
    [{ offerStatus: 'pending', assignmentStatus: 'mystery' }, 'DELETED OFFER'],
  ])('stage reconstructs from persisted facts %#', (changes, stage) =>
    expect(resolveVenueOfferKanbanStage({ ...base, ...changes })).toBe(stage),
  );
  it('a no-show is never Clocked In and rejected staff are never an active offer', () => {
    expect(resolveVenueOfferKanbanStage({ ...base, ...confirmed, assignmentStatus: 'no_show', serverNow: new Date('2030-01-01T13:00:00Z') })).toBe('NO SHOW');
    expect(resolveVenueOfferKanbanStage({ ...base, offerStatus: 'declined', notificationReadAt: new Date() })).toBe('REJECTED');
  });
  it('every lane is reachable and listed exactly once', () => {
    expect(new Set(PIPELINE_STAGES).size).toBe(PIPELINE_STAGES.length);
    expect(PIPELINE_STAGES).toHaveLength(12);
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
    expect(resolveVenueOfferKanbanStage(late)).toBe('LATE STAFF');
    expect(
      resolveVenueOfferKanbanStage({
        ...late,
        hasAttendance: true,
        clockInAt: late.serverNow,
      }),
    ).toBe('CLOCKED IN');
    expect(
      resolveVenueOfferKanbanStage({
        ...late,
        hasAttendance: true,
        clockInAt: late.serverNow,
        clockOutAt: late.serverNow,
        attendanceStatus: 'clocked_out',
      }),
    ).toBe('CLOCKED OUT');
  });
});
