export interface EmailSendOptions {
  to: string;
  /** Defaults to EMAIL_FROM_ADDRESS when omitted — see EmailService.send(). */
  from?: string;
  /** Defaults to EMAIL_REPLY_TO when omitted — see EmailService.send(). */
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
}
