export const EmailOutboxJobType = {
  ACCOUNT_INVITATION: 'ACCOUNT_INVITATION',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PASSWORD_UPDATED: 'PASSWORD_UPDATED',
  WELCOME: 'WELCOME',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  NOTIFICATION: 'NOTIFICATION',
  /** Email-first member invitation: no target user exists until the invitation is accepted. See `member-invitation.ts`. */
  MEMBER_INVITATION: 'MEMBER_INVITATION',
} as const;
export type EmailOutboxJobTypeType = (typeof EmailOutboxJobType)[keyof typeof EmailOutboxJobType];

export const EmailOutboxStatus = {
  PENDING: 'PENDING',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  RETRY: 'RETRY',
  SENT: 'SENT',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type EmailOutboxStatusType = (typeof EmailOutboxStatus)[keyof typeof EmailOutboxStatus];
