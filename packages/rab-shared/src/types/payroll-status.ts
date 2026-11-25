export const PayrollRecordStatus = {
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  PROCESSING: 'processing',
  PAID: 'paid',
  REJECTED: 'rejected',
  CORRECTED: 'corrected',
} as const;

export type PayrollRecordStatusType =
  (typeof PayrollRecordStatus)[keyof typeof PayrollRecordStatus];

export const PayrollPeriodStatus = {
  OPEN: 'open',
  LOCKED: 'locked',
  CLOSED: 'closed',
} as const;

export type PayrollPeriodStatusType =
  (typeof PayrollPeriodStatus)[keyof typeof PayrollPeriodStatus];

/**
 * Payroll adjustment (owner decision 3, 21 Nov 2026): a money change added after hours are approved, as its own approved
 * line. Exactly three kinds; no free-form deduction exists (Employment Rights Act 1996 s.13). A negative CORRECTION of an
 * overpayment is the only reduction.
 */
export const PayrollAdjustmentKind = {
  CORRECTION: 'correction',
  BONUS: 'bonus',
  EXPENSE: 'expense',
} as const;

export type PayrollAdjustmentKindType =
  (typeof PayrollAdjustmentKind)[keyof typeof PayrollAdjustmentKind];

export const PayrollAdjustmentStatus = {
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;

export type PayrollAdjustmentStatusType =
  (typeof PayrollAdjustmentStatus)[keyof typeof PayrollAdjustmentStatus];
