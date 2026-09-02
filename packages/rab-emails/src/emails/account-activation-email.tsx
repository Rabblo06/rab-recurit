import { BaseEmail } from '../components/BaseEmail';
import { CallToAction } from '../components/CallToAction';
import { MainText } from '../components/MainText';
import { ShadowText } from '../components/ShadowText';
import { Title } from '../components/Title';

export interface AccountActivationEmailProps {
  recipientEmail: string;
  activationUrl: string;
}

/**
 * Sent when an admin/manager creates a Staff/Manager account under the
 * invitation-based activation flow — distinct from `AccountInviteEmail`
 * (that one is the older admin-sets-a-temporary-password flow, kept
 * working, unused by this path). Deliberately carries no first/last name, no
 * organisation name, no password, no organisation/workspace/database id —
 * only the normalized recipient email (so the reader can confirm the link is
 * meant for them) and the one-time activation link, per the "never leak
 * internal metadata to an unauthenticated inbox" requirement this template
 * was built under.
 */
export function AccountActivationEmail({ recipientEmail, activationUrl }: AccountActivationEmailProps) {
  return (
    <BaseEmail previewText="Activate your rab account to get started">
      <Title>Welcome to RAB</Title>
      <MainText>
        An account has been created for <strong>{recipientEmail}</strong>. Activate it to set your own password and
        get started.
      </MainText>
      <CallToAction href={activationUrl}>Activate account</CallToAction>
      <ShadowText>
        This link expires in 24 hours and can only be used once. If you weren&apos;t expecting this, you can safely
        ignore this email.
      </ShadowText>
    </BaseEmail>
  );
}

export default AccountActivationEmail;
