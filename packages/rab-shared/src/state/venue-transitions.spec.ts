import { VenueStatus } from '../types';
import { VENUE_TRANSITIONS } from './venue-transitions';
import { expectExhaustiveTransitionTable } from './test-helpers';

describe('VENUE_TRANSITIONS', () => {
  it('exhaustively matches the documented table', () => {
    expectExhaustiveTransitionTable(VENUE_TRANSITIONS, Object.values(VenueStatus));
  });

  it('archived → active is the named restore action (wave 5); nothing else leaves archived', () => {
    expect(VENUE_TRANSITIONS[VenueStatus.ARCHIVED]).toEqual([VenueStatus.ACTIVE]);
  });
});
