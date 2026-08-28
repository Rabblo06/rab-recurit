import { Heading } from '@react-email/components';
import type { ReactNode } from 'react';

import { emailTheme } from './styles';

const titleStyle = {
  fontFamily: emailTheme.font.family,
  fontSize: emailTheme.font.size.xl,
  fontWeight: emailTheme.font.weight.bold,
  color: emailTheme.font.colors.primary,
  margin: '0 0 16px 0',
};

export function Title({ children }: { children: ReactNode }) {
  return (
    <Heading as="h1" style={titleStyle}>
      {children}
    </Heading>
  );
}

export default Title;
