import { Text } from '@react-email/components';
import type { ReactNode } from 'react';

import { emailTheme } from './styles';

const shadowTextStyle = {
  fontFamily: emailTheme.font.family,
  fontSize: emailTheme.font.size.sm,
  fontWeight: emailTheme.font.weight.regular,
  color: emailTheme.font.colors.tertiary,
  margin: '16px 0 0 0',
  lineHeight: emailTheme.font.lineHeight,
};

/** De-emphasized fine print — expiry notices, "if you didn't request this" disclaimers. */
export function ShadowText({ children }: { children: ReactNode }) {
  return <Text style={shadowTextStyle}>{children}</Text>;
}

export default ShadowText;
