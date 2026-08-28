import { Text } from '@react-email/components';
import type { ReactNode } from 'react';

import { emailTheme } from './styles';

const mainTextStyle = {
  fontFamily: emailTheme.font.family,
  fontSize: emailTheme.font.size.md,
  fontWeight: emailTheme.font.weight.regular,
  color: emailTheme.font.colors.secondary,
  lineHeight: emailTheme.font.lineHeight,
};

export function MainText({ children }: { children: ReactNode }) {
  return <Text style={mainTextStyle}>{children}</Text>;
}

export default MainText;
