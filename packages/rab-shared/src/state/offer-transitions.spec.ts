import { OfferStatus } from '../types';
import { OFFER_TRANSITIONS } from './offer-transitions';
import { expectExhaustiveTransitionTable } from './test-helpers';

describe('OFFER_TRANSITIONS', () => {
  it('exhaustively matches the documented table (§1.1)', () => {
    expectExhaustiveTransitionTable(OFFER_TRANSITIONS, Object.values(OfferStatus));
  });

  it('only pending offers can be responded to by staff', () => {
    expect(OFFER_TRANSITIONS[OfferStatus.PENDING]).toEqual(
      expect.arrayContaining([OfferStatus.STAFF_ACCEPTED, OfferStatus.DECLINED]),
    );
  });

  it('staff acceptance can only be confirmed or rejected by a manager, never confirmed directly', () => {
    expect(OFFER_TRANSITIONS[OfferStatus.STAFF_ACCEPTED]).toEqual(
      expect.arrayContaining([OfferStatus.MANAGER_CONFIRMED, OfferStatus.MANAGER_REJECTED]),
    );
    expect(OFFER_TRANSITIONS[OfferStatus.PENDING]).not.toContain(OfferStatus.MANAGER_CONFIRMED);
  });

  it('manager-confirmed and manager-rejected are terminal', () => {
    expect(OFFER_TRANSITIONS[OfferStatus.MANAGER_CONFIRMED]).toEqual([]);
    expect(OFFER_TRANSITIONS[OfferStatus.MANAGER_REJECTED]).toEqual([]);
  });
});
