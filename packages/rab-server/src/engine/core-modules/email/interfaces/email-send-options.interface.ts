export interface EmailSendOptions {
  to: string;
  /** Defaults to EMAIL_FROM_ADDRESS when omitted — see EmailService.send(). */
  from?: string;
  subject: string;
  html?: string;
  text?: string;
}
