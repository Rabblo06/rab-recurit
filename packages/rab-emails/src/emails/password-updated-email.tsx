import { BaseEmail } from '../components/BaseEmail';
import { MainText } from '../components/MainText';
import { ShadowText } from '../components/ShadowText';
import { Title } from '../components/Title';

export interface PasswordUpdatedEmailProps {
  firstName: string;
}

/**
 * A security notice, not a call to action — sent right after a password
 * actually changes (self-service forgot-password completion, an
 * admin-triggered reset completion, or the mobile forced-reset flow), never
 * for the very first password an account ever gets (see `WelcomeEmail`).
 * Carries no link and nothing sensitive — just confirms the change happened
 * so an account owner notices immediately if it wasn't them.
 */
export function PasswordUpdatedEmail({ firstName }: PasswordUpdatedEmailProps) {
  return (
    <BaseEmail previewText="Your rab password was changed">
      <Title>Hello {firstName}</Title>
      <MainText>Your rab password was just changed.</MainText>
      <ShadowText>If this wasn&apos;t you, contact your administrator right away.</ShadowText>
    </BaseEmail>
  );
}

export default PasswordUpdatedEmail;
