import { PayrollPeriodStatus, PayrollRecordStatus } from '../types';
import { PAYROLL_PERIOD_TRANSITIONS, PAYROLL_RECORD_TRANSITIONS } from './payroll-transitions';
import { expectExhaustiveTransitionTable } from './test-helpers';

describe('PAYROLL_RECORD_TRANSITIONS', () => {
  it('exhaustively matches the documented table (§1.1)', () => {
    expectExhaustiveTransitionTable(PAYROLL_RECORD_TRANSITIONS, Object.values(PayrollRecordStatus));
  });

  it('corrected is terminal', () => {
    expect(PAYROLL_RECORD_TRANSITIONS[PayrollRecordStatus.CORRECTED]).toEqual([]);
  });

  it('a rejected record returns to draft, not straight back to pending', () => {
    expect(PAYROLL_RECORD_TRANSITIONS[PayrollRecordStatus.REJECTED]).toEqual([PayrollRecordStatus.DRAFT]);
  });
});

describe('PAYROLL_PERIOD_TRANSITIONS', () => {
  it('exhaustively matches the documented table', () => {
    expectExhaustiveTransitionTable(PAYROLL_PERIOD_TRANSITIONS, Object.values(PayrollPeriodStatus));
  });

  it('closed is terminal', () => {
    expect(PAYROLL_PERIOD_TRANSITIONS[PayrollPeriodStatus.CLOSED]).toEqual([]);
  });
});
