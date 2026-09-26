import type { Metadata } from 'next';
import { Jobs } from '@/components/sections/content';
export const metadata: Metadata = {
  title: 'Find work',
  description:
    'Explore the roles Adolphus Group recruits for and speak with a consultant about current opportunities in London.',
  alternates: { canonical: '/jobs' },
};
export default function JobsPage() {
  return (
    <main id="main" className="inner-page">
      <Jobs full />
    </main>
  );
}
