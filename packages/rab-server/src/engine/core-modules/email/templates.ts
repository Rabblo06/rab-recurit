import {
  AccountActivationEmail,
  AccountInviteEmail,
  AccountSuspendedEmail,
  PasswordResetEmail,
  PasswordUpdatedEmail,
  WelcomeEmail,
} from '@rab/emails';
import { toPlainText } from '@react-email/render';
import { renderToStaticMarkup } from 'react-dom/server';

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Renders via `react-dom/server`'s `renderToStaticMarkup` directly rather
 * than `@react-email/render`'s `render()` — that helper does
 * `await import('react-dom/server')` internally, which Jest's CJS test
 * runner can't execute without `--experimental-vm-modules` (a Node VM
 * sandbox limitation, not an ESM/CJS authoring choice we control). Static
 * import sidesteps it entirely; the DOCTYPE prefix below matches what
 * `render()` prepends, since our templates have no async/Suspense content.
 */
function toEmailHtml(node: React.ReactElement): string {
  const markup = renderToStaticMarkup(node);
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">${markup.replace(/<!DOCTYPE.*?>/, '')}`;
}

export function renderAccountInviteEmail(params: { firstName: string; organisationName: string; setupUrl: string }): RenderedEmail {
  const html = toEmailHtml(AccountInviteEmail(params));
  return { subject: 'Your account has been created', html, text: toPlainText(html) };
}

export function renderAccountActivationEmail(params: { recipientEmail: string; activationUrl: string }): RenderedEmail {
  const html = toEmailHtml(AccountActivationEmail(params));
  return { subject: 'Welcome to RAB', html, text: toPlainText(html) };
}

/**
 * P2.9 — the Super Admin/CEO/Initial Manager activation emails deliberately reuse
 * `AccountActivationEmail`'s own body (the underlying action — "set a password to activate this
 * account" — is identical for every role); only the subject line is purpose-specific, so a
 * Super Admin's inbox doesn't read "Welcome to RAB" for what is actually a platform-bootstrap
 * credential. See `AccountLifecycleService.sendAccountInvite`'s `templateRenderer` override.
 */
export function renderSuperAdminActivationEmail(params: { recipientEmail: string; activationUrl: string }): RenderedEmail {
  const html = toEmailHtml(AccountActivationEmail(params));
  return { subject: 'Activate your Crewflow Super Admin account', html, text: toPlainText(html) };
}

export function renderCeoInvitationEmail(params: { recipientEmail: string; activationUrl: string }): RenderedEmail {
  const html = toEmailHtml(AccountActivationEmail(params));
  return { subject: "You've been invited to lead your organisation on Crewflow", html, text: toPlainText(html) };
}

export function renderInitialManagerInvitationEmail(params: { recipientEmail: string; activationUrl: string }): RenderedEmail {
  const html = toEmailHtml(AccountActivationEmail(params));
  return { subject: "You've been invited to manage your organisation on Crewflow", html, text: toPlainText(html) };
}

/**
 * Email-first member invitation (Settings → Members → Invite). Same body as every other activation email —
 * the recipient follows the link and sets up their own account — and, like them, contains no personal data
 * beyond the recipient's own address: no inviter name, no workspace name, no role.
 */
export function renderMemberInvitationEmail(params: { recipientEmail: string; activationUrl: string }): RenderedEmail {
  const html = toEmailHtml(AccountActivationEmail(params));
  return { subject: "You've been invited to join your team on Crewflow", html, text: toPlainText(html) };
}

export function renderPasswordResetEmail(params: {
  firstName: string;
  resetUrl: string;
  selfRequested: boolean;
}): RenderedEmail {
  const html = toEmailHtml(PasswordResetEmail(params));
  return { subject: 'Reset your rab password', html, text: toPlainText(html) };
}

export function renderWelcomeEmail(params: { firstName: string; organisationName: string }): RenderedEmail {
  const html = toEmailHtml(WelcomeEmail(params));
  return { subject: `Welcome to ${params.organisationName}`, html, text: toPlainText(html) };
}

export function renderPasswordUpdatedEmail(params: { firstName: string }): RenderedEmail {
  const html = toEmailHtml(PasswordUpdatedEmail(params));
  return { subject: 'Your rab password was changed', html, text: toPlainText(html) };
}

export function renderAccountSuspendedEmail(params: { firstName: string; organisationName: string }): RenderedEmail {
  const html = toEmailHtml(AccountSuspendedEmail(params));
  return { subject: 'Your account access has been suspended', html, text: toPlainText(html) };
}
