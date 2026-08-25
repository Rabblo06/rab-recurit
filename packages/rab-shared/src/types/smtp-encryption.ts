export const SmtpEncryption = {
  NONE: 'none',
  STARTTLS: 'starttls',
  TLS: 'tls',
} as const;

export type SmtpEncryptionType = (typeof SmtpEncryption)[keyof typeof SmtpEncryption];
