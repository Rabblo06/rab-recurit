'use client';
import Link from 'next/link';
import {
  BriefcaseBusiness,
  GraduationCap,
  Monitor,
  Sparkles,
  Utensils,
} from 'lucide-react';
import { useRecruitmentMotion } from '@/lib/use-recruitment-motion';
import {
  CandidateCard,
  EmployerCard,
  HospitalityCard,
  SectorSpotlight,
} from './recruitment-cards';
import styles from './recruitment-stack.module.css';

const sectors = [
  { label: 'IT & media', icon: Monitor },
  { label: 'Education', icon: GraduationCap },
  { label: 'Hospitality & events', icon: Utensils, featured: true },
  { label: 'Office support', icon: BriefcaseBusiness },
  { label: 'Specialist recruitment', icon: Sparkles },
];

export function RecruitmentStack() {
  const ref = useRecruitmentMotion();
  return (
    <section
      ref={ref}
      className={`${styles.section} container`}
      id="connections"
      aria-labelledby="connections-heading"
    >
      <h2 className="sr-only">The people behind great hospitality</h2>
      <div className={styles.editorial} data-story-entry>
        <p className="eyebrow">
          People power.
          <br />
          Great hospitality.
        </p>
        <p>
          Behind every role is a person.
          <br />
          Behind every business, a team.
        </p>
      </div>
      <div className={styles.stage} data-story-stage>
        <div className={styles.ambient} aria-hidden="true" />
        <svg
          className={styles.connections}
          viewBox="0 0 1100 560"
          fill="none"
          aria-hidden="true"
        >
          <path d="M50 345C180 80 840 62 1040 240" />
          <path d="M65 310C330 550 895 515 1040 180" />
          <path d="M190 455C415 120 720 40 960 370" />
        </svg>
        <div className={styles.assembly}>
          <div
            className={`${styles.entry} ${styles.imageEntry}`}
            data-story-entry
          >
            <div className={styles.depth}>
              <HospitalityCard />
            </div>
          </div>
          <div
            className={`${styles.entry} ${styles.employerEntry}`}
            data-story-entry
          >
            <div className={styles.depth}>
              <EmployerCard />
            </div>
          </div>
          <div
            className={`${styles.entry} ${styles.candidateEntry}`}
            data-story-entry
          >
            <div className={styles.depth}>
              <CandidateCard />
            </div>
          </div>
          <div
            className={`${styles.entry} ${styles.spotlightEntry}`}
            data-story-entry
          >
            <div className={styles.depth}>
              <SectorSpotlight />
            </div>
          </div>
        </div>
      </div>
      <div className={styles.statement} data-story-entry>
        <p className="eyebrow">
          Specialist recruitment for a brighter tomorrow
        </p>
        <h2 id="connections-heading">
          People make places.
          <br />
          <em>We bring them together.</em>
        </h2>
      </div>
      <nav
        className={styles.sectors}
        aria-label="Explore recruitment sectors"
        data-story-entry
      >
        {sectors.map(({ label, icon: Icon, featured }) => (
          <Link
            key={label}
            href={`/contact?sector=${encodeURIComponent(label)}`}
            className={featured ? styles.featured : undefined}
          >
            <Icon size={21} strokeWidth={1.35} aria-hidden="true" />
            <span>{label}</span>
            {featured && (
              <span className="sr-only"> — featured in this section</span>
            )}
          </Link>
        ))}
      </nav>
    </section>
  );
}
