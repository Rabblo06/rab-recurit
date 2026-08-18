export const PasswordResetTokenPurpose = {
  INITIAL_SETUP: 'initial_setup',
  FORGOT_PASSWORD: 'forgot_password',
  ADMIN_RESET: 'admin_reset',
} as const;

export type PasswordResetTokenPurposeType = (typeof PasswordResetTokenPurpose)[keyof typeof PasswordResetTokenPurpose];
