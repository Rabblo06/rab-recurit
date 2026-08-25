import { EmploymentStatus, UserStatus } from '../types';
import { EMPLOYMENT_STATUS_TRANSITIONS, USER_STATUS_TRANSITIONS } from './account-status-transitions';
import { expectExhaustiveTransitionTable } from './test-helpers';

describe('EMPLOYMENT_STATUS_TRANSITIONS', () => {
  it('exhaustively matches the documented table', () => {
    expectExhaustiveTransitionTable(EMPLOYMENT_STATUS_TRANSITIONS, Object.values(EmploymentStatus));
  });

  it('never allows PENDING_COMPLIANCE straight to ACTIVE — reactivate must not double as compliance approval', () => {
    expect(EMPLOYMENT_STATUS_TRANSITIONS[EmploymentStatus.PENDING_COMPLIANCE]).not.toContain(EmploymentStatus.ACTIVE);
  });
});

describe('USER_STATUS_TRANSITIONS', () => {
  it('exhaustively matches the documented table', () => {
    expectExhaustiveTransitionTable(USER_STATUS_TRANSITIONS, Object.values(UserStatus));
  });

  it('has no transitions out of deactivated — terminal state', () => {
    expect(USER_STATUS_TRANSITIONS[UserStatus.DEACTIVATED]).toEqual([]);
  });
});
