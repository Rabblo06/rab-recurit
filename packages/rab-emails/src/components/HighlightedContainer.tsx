import { Container } from '@react-email/components';
import type { ReactNode } from 'react';

import { emailTheme } from './styles';

const highlightedContainerStyle = {
  background: emailTheme.background.highlight,
  border: `1px solid ${emailTheme.border.color}`,
  borderRadius: emailTheme.border.radius.sm,
  padding: '16px 24px',
  margin: '16px 0',
};

/** A callout box for a piece of content that needs to stand out from the surrounding paragraph text — e.g. a reason string, a token expiry note. */
export function HighlightedContainer({ children }: { children: ReactNode }) {
  return <Container style={highlightedContainerStyle}>{children}</Container>;
}

export default HighlightedContainer;
