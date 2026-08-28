import { Text } from '@react-email/components';
import type { ReactNode } from 'react';

import { emailTheme } from './styles';

const highlightedTextStyle = {
  fontFamily: emailTheme.font.family,
  fontSize: emailTheme.font.size.md,
  fontWeight: emailTheme.font.weight.bold,
  color: emailTheme.font.colors.primary,
  margin: 0,
};

export function HighlightedText({ children }: { children: ReactNode }) {
  return <Text style={highlightedTextStyle}>{children}</Text>;
}

export default HighlightedText;
