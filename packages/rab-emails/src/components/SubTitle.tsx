import { Heading } from '@react-email/components';
import type { ReactNode } from 'react';

import { emailTheme } from './styles';

const subTitleStyle = {
  fontFamily: emailTheme.font.family,
  fontSize: emailTheme.font.size.lg,
  fontWeight: emailTheme.font.weight.bold,
  color: emailTheme.font.colors.primary,
  margin: '0 0 8px 0',
};

export function SubTitle({ children }: { children: ReactNode }) {
  return (
    <Heading as="h3" style={subTitleStyle}>
      {children}
    </Heading>
  );
}

export default SubTitle;
