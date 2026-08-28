import { Text } from '@react-email/components';

import { emailTheme } from './styles';

const footerStyle = {
  fontFamily: emailTheme.font.family,
  fontSize: emailTheme.font.size.sm,
  color: emailTheme.font.colors.tertiary,
  marginTop: '32px',
};

export function Footer() {
  return <Text style={footerStyle}>This is an automated message — please don&apos;t reply to this email.</Text>;
}

export default Footer;
