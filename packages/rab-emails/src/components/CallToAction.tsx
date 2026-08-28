import { Button } from '@react-email/components';
import type { ReactNode } from 'react';

import { emailTheme } from './styles';

const callToActionStyle = {
  display: 'inline-block' as const,
  background: emailTheme.accent.default,
  color: emailTheme.font.colors.inverted,
  padding: '12px 24px',
  borderRadius: emailTheme.border.radius.sm,
  fontFamily: emailTheme.font.family,
  fontSize: emailTheme.font.size.md,
  fontWeight: emailTheme.font.weight.bold,
  textDecoration: 'none',
};

interface CallToActionProps {
  href: string;
  children: ReactNode;
}

export function CallToAction({ href, children }: CallToActionProps) {
  return (
    <Button href={href} style={callToActionStyle}>
      {children}
    </Button>
  );
}

export default CallToAction;
