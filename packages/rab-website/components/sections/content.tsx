import Link from 'next/link';
import {
  ArrowUpRight,
  Hotel,
  Utensils,
  BriefcaseBusiness,
  Monitor,
  GraduationCap,
  HeartPulse,
  ArrowRight,
  Check,
} from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
import { MotionReveal, SectionHeading } from '@/components/shared/motion';
import { jobs } from '@/data/jobs';
import { site } from '@/lib/site';

export function Introduction() {
  return (
    <section className="intro container" id="about">
      <p className="eyebrow">Good recruitment starts with listening</p>
      <h2>
        Big on opportunity.
        <br />
        <span className="muted">Even bigger on people.</span>
      </h2>
      <div className="intro-bottom">
        <span className="intro-mark" aria-hidden="true">
          a.
        </span>
        <p>
          We’re Adolphus Group, a London recruitment agency with a simple
          belief: the best working relationships start with understanding. We
          connect businesses and candidates through a personal, specialist
          approach.
        </p>
        <Link className="text-link" href="/contact">
          Meet your next recruitment partner
          <ArrowUpRight size={18} />
        </Link>
      </div>
    </section>
  );
}
export function Process() {
  return (
    <section className="section container process">
      <SectionHeading eyebrow="How we work">
        Considered at every step.
        <br />
        <em>Simple from your side.</em>
      </SectionHeading>
      <div className="process-grid">
        {[
          ['Understand', 'We learn the role, the business and the team.'],
          [
            'Search',
            'We connect through our network and targeted recruitment.',
          ],
          ['Select', 'We consider skills, availability and the right fit.'],
          ['Place', 'We coordinate the next step and stay in touch.'],
        ].map(([title, description], index) => (
          <article key={title}>
            <span className="step-number">0{index + 1}</span>
            <h3>{title}</h3>
            <p>{description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
export function ClientCandidateSplit() {
  return (
    <section className="container split-section">
      <MotionReveal>
        <article id="employers" className="path-card employer-card">
          <p className="eyebrow">For employers</p>
          <h2>
            Your people.
            <br />
            <em>Our priority.</em>
          </h2>
          <p>
            A busy season. A growing team. A role that needs just the right
            person. Let’s find your fit.
          </p>
          <ul>
            {[
              'Temporary & interim staffing',
              'Permanent recruitment',
              'Hospitality & event teams',
            ].map((text) => (
              <li key={text}>
                <Check size={15} />
                {text}
              </li>
            ))}
          </ul>
          <ButtonLink href="/contact?interest=employer">
            Hire with Adolphus
          </ButtonLink>
          <span className="path-art" aria-hidden="true">
            ↗
          </span>
        </article>
      </MotionReveal>
      <MotionReveal>
        <article id="candidates" className="path-card candidate-card">
          <p className="eyebrow">For candidates</p>
          <h2>
            Your next chapter.
            <br />
            <em>Let’s find it.</em>
          </h2>
          <p>
            Something flexible or something for the long run. We take the time
            to understand what comes next for you.
          </p>
          <ul>
            {[
              'Temporary & permanent opportunities',
              'A range of specialist sectors',
              'A personal consultant relationship',
            ].map((text) => (
              <li key={text}>
                <Check size={15} />
                {text}
              </li>
            ))}
          </ul>
          <ButtonLink href="/jobs" variant="outline">
            Find opportunities
          </ButtonLink>
          <span className="path-art" aria-hidden="true">
            ✳
          </span>
        </article>
      </MotionReveal>
    </section>
  );
}
const sectors = [
  {
    title: 'Hospitality',
    description: 'The people behind a memorable welcome.',
    icon: Hotel,
  },
  {
    title: 'Catering & events',
    description: 'Great service, from kitchen to occasion.',
    icon: Utensils,
  },
  {
    title: 'Office & finance',
    description: 'People who keep business moving.',
    icon: BriefcaseBusiness,
  },
  {
    title: 'IT & media',
    description: 'Technical minds. Creative possibilities.',
    icon: Monitor,
  },
  {
    title: 'Healthcare',
    description: 'A people-first approach to caring roles.',
    icon: HeartPulse,
  },
  {
    title: 'Education',
    description: 'Connecting people who help others grow.',
    icon: GraduationCap,
  },
];
export function Sectors() {
  return (
    <section className="section container" id="sectors">
      <div className="section-top">
        <SectionHeading eyebrow="Our specialisms">
          Different worlds.
          <br />
          <em>One personal approach.</em>
        </SectionHeading>
        <p className="section-side-copy">
          Specialist understanding.
          <br />A shared commitment to finding
          <br />
          the right people.
        </p>
      </div>
      <div className="sector-grid">
        {sectors.map(({ title, description, icon: Icon }, index) => (
          <Link
            href={`/contact?sector=${encodeURIComponent(title)}`}
            className="sector-card"
            key={title}
          >
            <div className="sector-card-top">
              <Icon size={30} strokeWidth={1.2} />
              <span>0{index + 1}</span>
            </div>
            <h3>{title}</h3>
            <p>{description}</p>
            <ArrowUpRight className="sector-arrow" size={22} />
          </Link>
        ))}
      </div>
    </section>
  );
}
export function Jobs({ full = false }: { full?: boolean }) {
  const active = jobs.filter((job) => job.active);
  const displayed = active.length ? active : jobs;
  return (
    <section
      className={`section container jobs-section ${full ? 'jobs-full' : ''}`}
      id="jobs"
    >
      <div className="section-top">
        <SectionHeading eyebrow="For your next move">
          Find your kind
          <br />
          <em>of opportunity.</em>
        </SectionHeading>
        {!full && (
          <Link className="text-link" href="/jobs">
            Explore opportunities
            <ArrowUpRight size={18} />
          </Link>
        )}
      </div>
      <p className="jobs-note">
        {active.length
          ? 'Explore our confirmed current opportunities.'
          : 'Explore the kinds of roles we recruit for. Contact our consultants for current availability.'}
      </p>
      <div className="job-list">
        {displayed.map((job) => (
          <Link key={job.id} href={job.applyUrl} className="job-card">
            <div className="job-sector">
              <span className="status-dot" />
              {job.sector}
            </div>
            <div>
              <h3>{job.title}</h3>
              <p>{full ? job.summary : `${job.location} · ${job.type}`}</p>
            </div>
            <span className="job-status">
              {job.active ? 'View role' : 'Register interest'}
            </span>
            <ArrowUpRight size={22} />
          </Link>
        ))}
      </div>
      {full && (
        <div className="jobs-help">
          <p>
            Not sure where to start? Tell us what you enjoy and where you want
            to go.
          </p>
          <ButtonLink href="/contact?interest=candidate">
            Talk to a consultant
          </ButtonLink>
        </div>
      )}
    </section>
  );
}
export function Trust() {
  return (
    <section className="trust-section dark-section">
      <div className="container">
        <div className="section-top">
          <SectionHeading eyebrow="The difference is personal">
            Built around
            <br />
            <em>relationships.</em>
          </SectionHeading>
          <p className="section-side-copy">
            A real conversation.
            <br />A familiar voice.
            <br />
            Someone who understands.
          </p>
        </div>
        <div className="trust-grid">
          {[
            [
              '01',
              'People before profiles',
              'We listen to ambitions, not just qualifications.',
            ],
            [
              '02',
              'Your own consultant',
              'A personal point of contact who gets to know you.',
            ],
            [
              '03',
              'Here for the long term',
              'We value the relationship beyond the placement.',
            ],
          ].map(([number, title, text]) => (
            <MotionReveal key={number}>
              <article>
                <span className="eyebrow">{number} / Our principles</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            </MotionReveal>
          ))}
        </div>
        {process.env.NODE_ENV === 'development' && (
          <aside className="testimonial-placeholder">
            Approved testimonials can be added here
          </aside>
        )}
      </div>
    </section>
  );
}
export function ContactCTA() {
  return (
    <section className="contact-cta container">
      <div>
        <p className="eyebrow">The next great connection starts here</p>
        <h2>
          People make
          <br />
          <em>the difference.</em>
        </h2>
      </div>
      <div className="contact-cta-right">
        <p>
          Looking for the right person?
          <br />
          Looking for your next opportunity?
          <br />
          We’d love to hear from you.
        </p>
        <ButtonLink href="/contact">
          Let’s talk
          <ArrowRight className="sr-only" />
        </ButtonLink>
        <a className="contact-phone" href={site.phoneHref}>
          {site.phone}
        </a>
      </div>
    </section>
  );
}
