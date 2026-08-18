import {
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
