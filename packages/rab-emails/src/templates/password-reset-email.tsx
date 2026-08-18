import { Body, Button, Container, Head, Heading, Html, Preview, Text } from '@react-email/components';

export interface PasswordResetEmailProps {
  firstName: string;
  resetUrl: string;
  /** true for a self-service "forgot password" request, false for an admin-triggered reset. */
  selfRequested: boolean;
}

export function PasswordResetEmail({ firstName, resetUrl, selfRequested }: PasswordResetEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Reset your rab password</Preview>
      <Body style={{ fontFamily: 'Inter, system-ui, sans-serif', background: '#F2F3F1' }}>
        <Container style={{ background: '#FFFFFF', padding: 32, borderRadius: 16 }}>
          <Heading style={{ fontSize: 24, fontWeight: 600 }}>Hello {firstName}</Heading>
          <Text style={{ color: '#111312' }}>
            {selfRequested
              ? 'We received a request to reset your rab password.'
              : 'An administrator has reset your rab password.'}
          </Text>
          <Text style={{ color: '#6B7270' }}>
            Click below to set a new password. You&apos;ll need to sign in with it afterward.
          </Text>
          <Button
            href={resetUrl}
            style={{
              background: '#12735A',
              color: '#FFFFFF',
              padding: '12px 24px',
              borderRadius: 8,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Reset your password
          </Button>
          <Text style={{ color: '#9AA09E', fontSize: 13, marginTop: 24 }}>
            This link expires soon and can only be used once.
            {selfRequested && ' If you did not request this, you can safely ignore this email — your password will not change.'}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default PasswordResetEmail;
