import { BaseEmail } from '../components/BaseEmail';
import { CallToAction } from '../components/CallToAction';
import { MainText } from '../components/MainText';
import { ShadowText } from '../components/ShadowText';
import { Title } from '../components/Title';

export interface AccountInviteEmailProps {
  firstName: string;
  organisationName: string;
  setupUrl: string;
}

/**
 * Sent when an admin creates a Staff/Internal Manager/Venue Manager
 * account. Deliberately carries a one-time setup link, not the raw
 * temporary password — the password itself is shown to the creating admin
 * once, in-app, and never put in an email body (rab-workforce-architecture.md
 * §5.1 principle applied to email as a lower-trust channel than the app).
 */
export function AccountInviteEmail({ firstName, organisationName, setupUrl }: AccountInviteEmailProps) {
  return (
    <BaseEmail previewText={`Your ${organisationName} account is ready — set your password to get started`}>
      <Title>Hello {firstName}</Title>
      <MainText>
        Your account has been created for <strong>{organisationName}</strong> on rab.
      </MainText>
      <MainText>For security, you&apos;ll need to set your own password before you can sign in.</MainText>
      <CallToAction href={setupUrl}>Set your password</CallToAction>
      <ShadowText>
        This link expires in 48 hours and can only be used once. If you did not expect this account, please contact your
        administrator — do not share this link with anyone.
      </ShadowText>
    </BaseEmail>
  );
}

export default AccountInviteEmail;
