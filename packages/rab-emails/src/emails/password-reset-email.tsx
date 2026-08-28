import { BaseEmail } from '../components/BaseEmail';
import { CallToAction } from '../components/CallToAction';
import { MainText } from '../components/MainText';
import { ShadowText } from '../components/ShadowText';
import { Title } from '../components/Title';

export interface PasswordResetEmailProps {
  firstName: string;
  resetUrl: string;
  /** true for a self-service "forgot password" request, false for an admin-triggered reset. */
  selfRequested: boolean;
}

export function PasswordResetEmail({ firstName, resetUrl, selfRequested }: PasswordResetEmailProps) {
  return (
    <BaseEmail previewText="Reset your rab password">
      <Title>Hello {firstName}</Title>
      <MainText>
        {selfRequested ? 'We received a request to reset your rab password.' : 'An administrator has reset your rab password.'}
      </MainText>
      <MainText>Click below to set a new password. You&apos;ll need to sign in with it afterward.</MainText>
      <CallToAction href={resetUrl}>Reset your password</CallToAction>
      <ShadowText>
        This link expires soon and can only be used once.
        {selfRequested && ' If you did not request this, you can safely ignore this email — your password will not change.'}
      </ShadowText>
    </BaseEmail>
  );
}

export default PasswordResetEmail;
