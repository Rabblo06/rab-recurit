import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ButtonLink } from '@/components/ui/button';
const pages: Record<string, string> = {
  privacy: 'Privacy',
  cookies: 'Cookies',
  terms: 'Terms',
};
export function generateStaticParams() {
  return Object.keys(pages).map((legal) => ({ legal }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ legal: string }>;
}): Promise<Metadata> {
  const { legal } = await params;
  return {
    title: pages[legal] || 'Not found',
    robots: { index: false, follow: false },
    alternates: { canonical: `/${legal}` },
  };
}
export default async function LegalPage({
  params,
}: {
  params: Promise<{ legal: string }>;
}) {
  const { legal } = await params;
  if (!pages[legal]) notFound();
  return (
    <main id="main" className="inner-page">
      <section className="container legal-page">
        <p className="eyebrow">Website preview</p>
        <h1>{pages[legal]}</h1>
        <h2>Approved policy pending</h2>
        <p>
          This page is a development placeholder. The company’s approved{' '}
          {pages[legal].toLowerCase()} policy must be supplied before this
          website is publicly launched.
        </p>
        <p>
          This preview has no application form, analytics or advertising
          integration. Contact links open your telephone or email application.
        </p>
        <ButtonLink href="/contact">Contact Adolphus</ButtonLink>
      </section>
    </main>
  );
}
