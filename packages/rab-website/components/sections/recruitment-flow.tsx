import {
  ClipboardList,
  Search,
  UserRoundCheck,
  ListChecks,
  Handshake,
  MessagesSquare,
} from 'lucide-react';
import { MotionReveal, SectionHeading } from '@/components/shared/motion';
const stages = [
  {
    title: 'Start with a conversation',
    label: 'Your brief',
    description:
      'Tell us about your business, your team and the person you need.',
    icon: ClipboardList,
    tags: ['The role', 'The culture', 'The timing'],
  },
  {
    title: 'Look beyond the obvious',
    label: 'Search & connect',
    description:
      'Our network, candidate database and targeted search bring the right people into focus.',
    icon: Search,
    tags: ['Our network', 'Candidate search', 'Advertising'],
  },
  {
    title: 'Make the right introduction',
    label: 'Screen & shortlist',
    description:
      'Skills, availability and fit. Thoughtful screening gives you a considered shortlist.',
    icon: UserRoundCheck,
    tags: ['Screening', 'Interviews', 'Shortlist'],
  },
  {
    title: 'A beginning, not a goodbye',
    label: 'Place & support',
    description:
      'From coordinating the placement to staying in touch, your consultant remains by your side.',
    icon: Handshake,
    tags: ['Placement', 'Communication', 'Ongoing support'],
  },
];
export function RecruitmentFlow() {
  return (
    <section className="flow-section dark-section" id="approach">
      <div className="container flow-layout">
        <div className="flow-intro">
          <SectionHeading eyebrow="The Adolphus approach">
            One partner.
            <br />
            <em>Every step.</em>
          </SectionHeading>
          <p>
            Recruitment is a journey.
            <br />
            Let’s make it a personal one.
          </p>
          <div className="flow-seal">
            <MessagesSquare size={17} />
            Your consultant. From first hello.
          </div>
        </div>
        <div className="flow-list">
          {stages.map((stage, index) => (
            <MotionReveal flow key={stage.title}>
              <article className="flow-step">
                <div className="flow-node">
                  <stage.icon size={21} strokeWidth={1.4} />
                </div>
                <div>
                  <p className="eyebrow">
                    0{index + 1} / {stage.label}
                  </p>
                  <h3>{stage.title}</h3>
                  <p>{stage.description}</p>
                  <div className="flow-tags">
                    {stage.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </div>
                <ListChecks
                  className="flow-watermark"
                  size={90}
                  strokeWidth={0.6}
                  aria-hidden="true"
                />
              </article>
            </MotionReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
