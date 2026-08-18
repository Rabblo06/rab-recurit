import { Body, Button, Container, Head, Heading, Html, Preview, Text } from '@react-email/components';

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
    <Html>
      <Head />
      <Preview>Your {organisationName} account is ready — set your password to get started</Preview>
      <Body style={{ fontFamily: 'Inter, system-ui, sans-serif', background: '#F2F3F1' }}>
        <Container style={{ background: '#FFFFFF', padding: 32, borderRadius: 16 }}>
          <Heading style={{ fontSize: 24, fontWeight: 600 }}>Hello {firstName}</Heading>
          <Text style={{ color: '#111312' }}>
            Your account has been created for <strong>{organisationName}</strong> on rab.
          </Text>
          <Text style={{ color: '#6B7270' }}>
            For security, you&apos;ll need to set your own password before you can sign in.
          </Text>
          <Button
            href={setupUrl}
            style={{
              background: '#12735A',
              color: '#FFFFFF',
              padding: '12px 24px',
              borderRadius: 8,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Set your password
          </Button>
          <Text style={{ color: '#9AA09E', fontSize: 13, marginTop: 24 }}>
            This link expires in 48 hours and can only be used once. If you did not expect this
            account, please contact your administrator — do not share this link with anyone.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default AccountInviteEmail;
