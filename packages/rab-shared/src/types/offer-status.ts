export const OfferStatus = {
  PENDING: 'pending',
  // Two-step acceptance: staff accepting only reserves the offer for
  // manager review — it does not claim a seat or confirm the shift.
  STAFF_ACCEPTED: 'staff_accepted',
  MANAGER_CONFIRMED: 'manager_confirmed',
  MANAGER_REJECTED: 'manager_rejected',
  DECLINED: 'declined',
  EXPIRED: 'expired',
  WITHDRAWN: 'withdrawn',
} as const;

export type OfferStatusType = (typeof OfferStatus)[keyof typeof OfferStatus];
