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
