import { VenueStatus } from '../types';
import { VENUE_TRANSITIONS } from './venue-transitions';
import { expectExhaustiveTransitionTable } from './test-helpers';

describe('VENUE_TRANSITIONS', () => {
  it('exhaustively matches the documented table', () => {
    expectExhaustiveTransitionTable(VENUE_TRANSITIONS, Object.values(VenueStatus));
  });

  it('has no transitions out of archived — terminal, no unarchive path', () => {
    expect(VENUE_TRANSITIONS[VenueStatus.ARCHIVED]).toEqual([]);
  });
});
