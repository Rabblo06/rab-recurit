import {
  PayrollAdjustmentStatus,
  PayrollAdjustmentStatusType,
  PayrollPeriodStatus,
  PayrollPeriodStatusType,
  PayrollRecordStatus,
  PayrollRecordStatusType,
} from '../types';
import { TransitionTable } from './assert-transition';

export const PAYROLL_RECORD_TRANSITIONS: TransitionTable<PayrollRecordStatusType> = {
  [PayrollRecordStatus.DRAFT]: [PayrollRecordStatus.PENDING_APPROVAL],
  [PayrollRecordStatus.PENDING_APPROVAL]: [PayrollRecordStatus.APPROVED, PayrollRecordStatus.REJECTED],
  [PayrollRecordStatus.APPROVED]: [PayrollRecordStatus.PROCESSING],
  [PayrollRecordStatus.PROCESSING]: [PayrollRecordStatus.PAID, PayrollRecordStatus.CORRECTED],
  [PayrollRecordStatus.PAID]: [PayrollRecordStatus.CORRECTED],
  [PayrollRecordStatus.REJECTED]: [PayrollRecordStatus.DRAFT],
  [PayrollRecordStatus.CORRECTED]: [],
};

export const PAYROLL_PERIOD_TRANSITIONS: TransitionTable<PayrollPeriodStatusType> = {
  [PayrollPeriodStatus.OPEN]: [PayrollPeriodStatus.LOCKED],
  [PayrollPeriodStatus.LOCKED]: [PayrollPeriodStatus.CLOSED, PayrollPeriodStatus.OPEN],
  [PayrollPeriodStatus.CLOSED]: [],
};

/**
 * Payroll adjustment (owner decision 3): created pending, then approved or rejected by a DIFFERENT person than the
 * creator (and never by the staff member it pays). Both decisions are terminal: an approved line is never edited (a
 * mistake is fixed by another correction); being included in a payroll run, and that run being finalised, are recorded
 * on the row (run_id / locked_at), not as statuses. Mirrored by core.payroll_adjustment_guard().
 */
export const PAYROLL_ADJUSTMENT_TRANSITIONS: TransitionTable<PayrollAdjustmentStatusType> = {
  [PayrollAdjustmentStatus.PENDING_APPROVAL]: [PayrollAdjustmentStatus.APPROVED, PayrollAdjustmentStatus.REJECTED],
  [PayrollAdjustmentStatus.APPROVED]: [],
  [PayrollAdjustmentStatus.REJECTED]: [],
};
