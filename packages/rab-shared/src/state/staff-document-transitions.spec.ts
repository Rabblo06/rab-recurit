import { assertTransition } from './assert-transition';
import { InvalidTransitionError } from './invalid-transition-error';
import { STAFF_DOCUMENT_TRANSITIONS } from './staff-document-transitions';
import { expectExhaustiveTransitionTable } from './test-helpers';
import { StaffDocumentStatus } from '../types';

describe('STAFF_DOCUMENT_TRANSITIONS', () => {
  it('covers every status exactly', () => {
    expectExhaustiveTransitionTable(
      STAFF_DOCUMENT_TRANSITIONS,
      Object.values(StaffDocumentStatus),
    );
  });

  it('rejected and revoked are terminal', () => {
    expect(STAFF_DOCUMENT_TRANSITIONS[StaffDocumentStatus.REJECTED]).toEqual(
      [],
    );
    expect(STAFF_DOCUMENT_TRANSITIONS[StaffDocumentStatus.REVOKED]).toEqual([]);
  });

  it('a verified document can only be revoked, never sent back to pending or rejected', () => {
    expect(() =>
      assertTransition(
        STAFF_DOCUMENT_TRANSITIONS,
        StaffDocumentStatus.VERIFIED,
        StaffDocumentStatus.PENDING,
      ),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      assertTransition(
        STAFF_DOCUMENT_TRANSITIONS,
        StaffDocumentStatus.VERIFIED,
        StaffDocumentStatus.REJECTED,
      ),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      assertTransition(
        STAFF_DOCUMENT_TRANSITIONS,
        StaffDocumentStatus.VERIFIED,
        StaffDocumentStatus.REVOKED,
      ),
    ).not.toThrow();
  });

  it('an unknown state is denied', () => {
    expect(() =>
      assertTransition(
        STAFF_DOCUMENT_TRANSITIONS,
        'archived' as never,
        StaffDocumentStatus.REVOKED,
      ),
    ).toThrow(InvalidTransitionError);
  });
});
