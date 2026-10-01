import {
  canCancelVenueOffer,
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
  it.each([
    [{}, 'OFFERED'],
    [{ notificationReadAt: new Date() }, 'WAITING'],
    [
      { offerStatus: 'staff_accepted', assignmentStatus: 'staff_accepted' },
      'STAFF ACCEPTED',
    ],
    [
      {
        offerStatus: 'manager_confirmed',
        assignmentStatus: 'confirmed',
        serverNow: new Date('2030-01-01T12:05:00Z'),
      },
      'LATE STAFF',
    ],
    [{ clockInAt: new Date(), hasAttendance: true }, 'CLOCKED IN'],
    [
      { clockInAt: new Date(), clockOutAt: new Date(), hasAttendance: true },
      'CLOCKED OUT',
    ],
    [{ offerStatus: 'declined' }, 'DELETED OFFER'],
    [{ offerStatus: 'withdrawn' }, 'DELETED OFFER'],
    [
      { offerStatus: 'manager_confirmed', assignmentStatus: 'cancelled' },
      'DELETED OFFER',
    ],
  ])('stage reconstructs from persisted facts', (changes, stage) =>
    expect(resolveVenueOfferKanbanStage({ ...base, ...changes })).toBe(stage),
  );
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
      }),
    ).toBe('CLOCKED OUT');
  });
});
