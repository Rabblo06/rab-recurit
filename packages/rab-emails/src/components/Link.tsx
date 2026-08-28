import { Link as EmailLink } from '@react-email/components';
import type { ReactNode } from 'react';

import { emailTheme } from './styles';

interface LinkProps {
  href: string;
  color?: string;
  children: ReactNode;
}

export function Link({ href, color, children }: LinkProps) {
  return (
    <EmailLink href={href} style={{ textDecoration: 'underline', color: color ?? emailTheme.accent.default }}>
      {children}
    </EmailLink>
  );
}

export default Link;
