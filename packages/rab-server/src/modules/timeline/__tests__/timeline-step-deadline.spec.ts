import { timelineStepFor } from '../constants/timeline-steps';

describe('timeline step for system close-outs (owner rule 2026-11-06)', () => {
  it('a withdrawal at the manager-confirmation deadline is "offer_confirmation_deadline"', () => {
    expect(timelineStepFor('offer.rejected_by_worker', { reason: 'confirmation_deadline_passed' })).toBe('offer_confirmation_deadline');
  });
  it('the shift-cancellation close-out (same audit action, other reason) keeps no step, as before', () => {
    expect(timelineStepFor('offer.rejected_by_worker', { reason: 'shift_cancelled' })).toBeNull();
    expect(timelineStepFor('offer.rejected_by_worker', null)).toBeNull();
  });
  it('every other action maps exactly as before', () => {
    expect(timelineStepFor('offer.confirmed', {})).toBe('offer_approved');
    expect(timelineStepFor('offer.rejected', {})).toBe('offer_rejected');
    expect(timelineStepFor('unknown.action', {})).toBeNull();
  });
});
