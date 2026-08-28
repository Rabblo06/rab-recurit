import { Body, Container, Font, Head, Html, Preview } from '@react-email/components';
import type { ReactNode } from 'react';

import { Footer } from './Footer';
import { Logo } from './Logo';
import { emailTheme } from './styles';

interface BaseEmailProps {
  previewText: string;
  children: ReactNode;
}

/**
 * The one shared page shell every email in this package renders inside —
 * logo, card container, footer — so an individual template only ever
 * supplies its own body content, never re-declares the wrapper.
 */
export function BaseEmail({ previewText, children }: BaseEmailProps) {
  return (
    <Html>
      <Head>
        <Font fontFamily="Inter" fallbackFontFamily="sans-serif" fontStyle="normal" fontWeight={400} />
      </Head>
      <Preview>{previewText}</Preview>
      <Body style={{ fontFamily: emailTheme.font.family, background: emailTheme.background.page, padding: '32px 0' }}>
        <Container style={{ background: emailTheme.background.card, padding: 32, borderRadius: emailTheme.border.radius.md, maxWidth: 480 }}>
          <Logo />
          {children}
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}

export default BaseEmail;
