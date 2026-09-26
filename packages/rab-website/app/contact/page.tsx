import type { Metadata } from 'next';
import { ContactOptions } from '@/components/sections/contact-options';
import { site } from '@/lib/site';
export const metadata: Metadata = {
  title: 'Get in touch',
  description:
    'Speak with Adolphus Group in London about recruitment, staffing and your next career move.',
  alternates: { canonical: '/contact' },
};
export default async function ContactPage({
  searchParams,
}: {
  searchParams: Promise<{ interest?: string }>;
}) {
  const { interest } = await searchParams;
  return (
    <main id="main" className="inner-page">
      <section className="container contact-page">
        <div>
          <p className="eyebrow">Good things start with a conversation</p>
          <h1>
            Let’s find
            <br />
            <em>your next.</em>
          </h1>
          <p className="contact-lede">
            The right people. The right opportunity.
            <br />A consultant who takes the time to listen.
          </p>
          <address>{site.address}</address>
          <p className="muted">Please call ahead to arrange a visit.</p>
        </div>
        <ContactOptions
          initialInterest={interest === 'candidate' ? 'candidate' : 'employer'}
        />
      </section>
    </main>
  );
}
