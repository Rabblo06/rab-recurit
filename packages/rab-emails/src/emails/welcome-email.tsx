import { BaseEmail } from '../components/BaseEmail';
import { MainText } from '../components/MainText';
import { Title } from '../components/Title';

export interface WelcomeEmailProps {
  firstName: string;
  organisationName: string;
}

/**
 * Sent once the initial-setup link is completed (`AuthService.resetPassword`
 * with `PasswordResetTokenPurpose.INITIAL_SETUP`) — the account genuinely
 * has no prior password to have "changed", so this is a welcome moment, not
 * a security notice (see `PasswordUpdatedEmail` for that).
 */
export function WelcomeEmail({ firstName, organisationName }: WelcomeEmailProps) {
  return (
    <BaseEmail previewText={`Welcome to ${organisationName}`}>
      <Title>Welcome, {firstName}</Title>
      <MainText>
        Your password is set and your account for <strong>{organisationName}</strong> is ready to go — you can sign in
        now.
      </MainText>
    </BaseEmail>
  );
}

export default WelcomeEmail;
