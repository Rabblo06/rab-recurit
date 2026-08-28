import { BaseEmail } from '../components/BaseEmail';
import { MainText } from '../components/MainText';
import { ShadowText } from '../components/ShadowText';
import { Title } from '../components/Title';

export interface AccountSuspendedEmailProps {
  firstName: string;
  organisationName: string;
}

/** Sent when a manager deactivates a Staff account — a direct access-affecting action the account owner should always be told about, not discover by a failed login. */
export function AccountSuspendedEmail({ firstName, organisationName }: AccountSuspendedEmailProps) {
  return (
    <BaseEmail previewText={`Your ${organisationName} account access has been suspended`}>
      <Title>Hello {firstName}</Title>
      <MainText>
        Your access to <strong>{organisationName}</strong> on rab has been suspended by a manager or administrator. You
        will not be able to sign in until it is restored.
      </MainText>
      <ShadowText>If you believe this is a mistake, contact your manager or administrator.</ShadowText>
    </BaseEmail>
  );
}

export default AccountSuspendedEmail;
