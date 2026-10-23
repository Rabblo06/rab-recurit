import { EmailOutboxJobType } from '@rab/shared';

import { emailBodyCarriesSecret, SECRET_BEARING_EMAIL_JOB_TYPES } from './email-outbox.service';
import {
  renderAccountActivationEmail,
  renderAccountSuspendedEmail,
  renderCeoInvitationEmail,
  renderEmailChangeNoticeEmail,
  renderEmailChangeVerificationEmail,
  renderInitialManagerInvitationEmail,
  renderMemberInvitationEmail,
  renderPasswordResetEmail,
  renderPasswordUpdatedEmail,
  renderSuperAdminActivationEmail,
  renderWelcomeEmail,
} from './templates';

/**
 * F1 (Wave 1 lane S): the rule that decides which outbox bodies must not outlive delivery. It must flag EVERY rendered email
 * that carries a link token (built the way the producers build their URLs), and must not flag ordinary notices — those keep
 * their body until the retention decision (G6). The database trigger `core.email_outbox_scrub_secret_body()` implements the
 * same rule; `email-secret-body-retention.integration.spec.ts` (rab-worker) proves the two agree on a real database.
 */
const TOKEN = 'Zm9vYmFyLXJhdy10b2tlbi12YWx1ZS0wMTIzNDU2Nzg5';
const ACCOUNTS = 'https://accounts.example.test';

describe('F1: emailBodyCarriesSecret', () => {
  it('every secret-bearing job type is flagged even with no visible token (activation, reset, member invitation)', () => {
    expect([...SECRET_BEARING_EMAIL_JOB_TYPES].sort()).toEqual(
      [EmailOutboxJobType.ACCOUNT_INVITATION, EmailOutboxJobType.MEMBER_INVITATION, EmailOutboxJobType.PASSWORD_RESET].sort(),
    );
    for (const jobType of SECRET_BEARING_EMAIL_JOB_TYPES) {
      expect(emailBodyCarriesSecret({ jobType, renderedHtml: '<p>no link</p>', renderedText: 'no link' })).toBe(true);
    }
  });

  it.each([
    ['ACCOUNT_INVITATION (activation)', EmailOutboxJobType.ACCOUNT_INVITATION, renderAccountActivationEmail({ recipientEmail: 'a@x.test', activationUrl: `${ACCOUNTS}/activate-account?token=${TOKEN}` })],
    ['ACCOUNT_INVITATION (super admin)', EmailOutboxJobType.ACCOUNT_INVITATION, renderSuperAdminActivationEmail({ recipientEmail: 'a@x.test', activationUrl: `${ACCOUNTS}/activate-account?token=${TOKEN}` })],
    ['ACCOUNT_INVITATION (CEO)', EmailOutboxJobType.ACCOUNT_INVITATION, renderCeoInvitationEmail({ recipientEmail: 'a@x.test', activationUrl: `${ACCOUNTS}/activate-account?token=${TOKEN}` })],
    ['ACCOUNT_INVITATION (initial manager)', EmailOutboxJobType.ACCOUNT_INVITATION, renderInitialManagerInvitationEmail({ recipientEmail: 'a@x.test', activationUrl: `${ACCOUNTS}/activate-account?token=${TOKEN}` })],
    ['PASSWORD_RESET (self-service, with applicationTarget)', EmailOutboxJobType.PASSWORD_RESET, renderPasswordResetEmail({ firstName: 'A', resetUrl: `${ACCOUNTS}/reset-password?token=${TOKEN}&applicationTarget=web`, selfRequested: true })],
    ['PASSWORD_RESET (admin-triggered)', EmailOutboxJobType.PASSWORD_RESET, renderPasswordResetEmail({ firstName: 'A', resetUrl: `${ACCOUNTS}/reset-password?token=${TOKEN}`, selfRequested: false })],
    ['MEMBER_INVITATION', EmailOutboxJobType.MEMBER_INVITATION, renderMemberInvitationEmail({ recipientEmail: 'a@x.test', activationUrl: `${ACCOUNTS}/accept-invitation?token=${encodeURIComponent(TOKEN)}` })],
    ['NOTIFICATION (email-change verification)', EmailOutboxJobType.NOTIFICATION, renderEmailChangeVerificationEmail({ confirmUrl: `${ACCOUNTS}/confirm-email-change?token=${TOKEN}`, expiresInHours: 24 })],
  ])('%s: the rendered body carries the token and is flagged', (_label, jobType, rendered) => {
    expect(`${rendered.html ?? ''}${rendered.text ?? ''}`).toContain(TOKEN);
    expect(emailBodyCarriesSecret({ jobType, renderedHtml: rendered.html, renderedText: rendered.text })).toBe(true);
  });

  it('a token link is caught in the NOTIFICATION type by content alone, html or text, including the HTML-escaped form', () => {
    for (const body of [`<a href="${ACCOUNTS}/x?token=${TOKEN}">x</a>`, `${ACCOUNTS}/x?a=1&token=${TOKEN}`, `<a href="${ACCOUNTS}/x?a=1&amp;token=${TOKEN}">`]) {
      expect(emailBodyCarriesSecret({ jobType: EmailOutboxJobType.NOTIFICATION, renderedHtml: body, renderedText: null })).toBe(true);
      expect(emailBodyCarriesSecret({ jobType: EmailOutboxJobType.NOTIFICATION, renderedHtml: null, renderedText: body })).toBe(true);
    }
  });

  it.each([
    ['WELCOME', EmailOutboxJobType.WELCOME, renderWelcomeEmail({ firstName: 'A', organisationName: 'Org' })],
    ['PASSWORD_UPDATED', EmailOutboxJobType.PASSWORD_UPDATED, renderPasswordUpdatedEmail({ firstName: 'A' })],
    ['ACCOUNT_SUSPENDED', EmailOutboxJobType.ACCOUNT_SUSPENDED, renderAccountSuspendedEmail({ firstName: 'A', organisationName: 'Org' })],
    ['NOTIFICATION (email-change notice)', EmailOutboxJobType.NOTIFICATION, renderEmailChangeNoticeEmail({ firstName: 'A', stage: 'requested' })],
    ['NOTIFICATION (bulk email)', EmailOutboxJobType.NOTIFICATION, { subject: 's', html: '<p>Please bring your token for the cloakroom.</p>', text: 'tokens=3' }],
  ])('%s: an ordinary notice is not flagged (its body is kept)', (_label, jobType, rendered) => {
    expect(emailBodyCarriesSecret({ jobType, renderedHtml: rendered.html, renderedText: rendered.text })).toBe(false);
  });
});
