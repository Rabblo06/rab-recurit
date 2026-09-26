import type { Metadata } from 'next';
import { FloatingNav } from '@/components/shared/floating-nav';
import { Footer } from '@/components/sections/footer';
import { site } from '@/lib/site';
import '@/styles/globals.css';
export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: 'Adolphus Group | London Recruitment, Personally',
    template: '%s | Adolphus Group',
  },
  description:
    'Personal recruitment for people and businesses. Adolphus Group connects London employers and candidates across hospitality and specialist sectors.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    locale: 'en_GB',
    siteName: site.name,
    title: 'Great people. New possibilities.',
    description: 'London recruitment, with a personal touch.',
    images: [{ url: '/og-image.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Adolphus Group',
    description: 'London recruitment, with a personal touch.',
    images: ['/og-image.png'],
  },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <FloatingNav />
        {children}
        <Footer />
      </body>
    </html>
  );
}
