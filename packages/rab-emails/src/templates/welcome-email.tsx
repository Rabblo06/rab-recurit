import { Body, Container, Head, Heading, Html, Preview, Text } from '@react-email/components';

/**
 * Placeholder proving the react-email toolchain works end to end. Real
 * templates (invite, offer, shift reminder, payroll approved, payslip
 * available) land alongside their modules starting M1.
 */
export interface WelcomeEmailProps {
  firstName: string;
  organisationName: string;
}

export function WelcomeEmail({ firstName, organisationName }: WelcomeEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Welcome to {organisationName}</Preview>
      <Body style={{ fontFamily: 'Inter, system-ui, sans-serif', background: '#F2F3F1' }}>
        <Container style={{ background: '#FFFFFF', padding: 32, borderRadius: 16 }}>
          <Heading style={{ fontSize: 24, fontWeight: 600 }}>Welcome, {firstName}</Heading>
          <Text style={{ color: '#6B7270' }}>
            You've been invited to join {organisationName} on rab. Set your password to get
            started.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default WelcomeEmail;
