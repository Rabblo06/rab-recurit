import { Hero } from '@/components/sections/hero';
import { SectorMarquee } from '@/components/sections/sector-marquee';
import { RecruitmentStack } from '@/components/sections/recruitment-stack';
import { RecruitmentFlow } from '@/components/sections/recruitment-flow';
import {
  Introduction,
  Process,
  ClientCandidateSplit,
  Sectors,
  Jobs,
  Trust,
  ContactCTA,
} from '@/components/sections/content';
import { site } from '@/lib/site';
export default function Home() {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'EmploymentAgency',
    name: site.name,
    url: site.url,
    telephone: '+442076252931',
    address: {
      '@type': 'PostalAddress',
      streetAddress: '2 Canfield Place',
      addressLocality: 'London',
      postalCode: 'NW6 3BT',
      addressCountry: 'GB',
    },
  };
  return (
    <main id="main">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(schema).replace(/</g, '\\u003c'),
        }}
      />
      <Hero />
      <SectorMarquee />
      <RecruitmentStack />
      <Introduction />
      <RecruitmentFlow />
      <Process />
      <ClientCandidateSplit />
      <Sectors />
      <Jobs />
      <Trust />
      <ContactCTA />
    </main>
  );
}
