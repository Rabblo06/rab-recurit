/** The real `notify()` call sites that exist today (all in offer.service.ts) — not an invented category list. */
export const NotificationType = {
  OFFER_SENT: 'offer_sent',
  OFFER_EXPIRED: 'offer_expired',
  OFFER_ACCEPTED: 'offer_accepted',
  OFFER_DECLINED: 'offer_declined',
  OFFER_CONFIRMED: 'offer_confirmed',
  OFFER_REJECTED: 'offer_rejected',
} as const;

export type NotificationTypeType = (typeof NotificationType)[keyof typeof NotificationType];
