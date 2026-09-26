import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight, Check, MapPin, Users, Utensils } from 'lucide-react';
import hospitalityImage from '@/image/hero.jpg';
import styles from './recruitment-stack.module.css';

export function EmployerCard() {
  return (
    <article className={`${styles.card} ${styles.employerCard}`}>
      <p className={styles.kicker}>
        <Users size={16} strokeWidth={1.4} aria-hidden="true" />
        Your next great team
      </p>
      <h3>
        Good people.
        <br />
        The right fit.
      </h3>
      <dl className={styles.details}>
        <div>
          <dt>What you need</dt>
          <dd>A team that understands you</dd>
        </div>
        <div>
          <dt>How we help</dt>
          <dd>One dedicated consultant</dd>
        </div>
      </dl>
      <ul className={styles.pills} aria-label="Recruitment options">
        <li>Temporary</li>
        <li>Interim</li>
        <li>Permanent</li>
      </ul>
    </article>
  );
}
export function HospitalityCard() {
  return (
    <figure className={`${styles.card} ${styles.hospitalityCard}`}>
      <Image
        src={hospitalityImage}
        alt="Guests dining in an elegant restaurant beneath crystal chandeliers"
        fill
        sizes="(max-width: 767px) calc(100vw - 64px), (max-width: 1023px) 250px, (max-width: 1279px) 280px, 320px"
        className={styles.photo}
      />
      <figcaption>
        <span className={styles.photoEyebrow}>The art of hospitality</span>
        <p>
          Exceptional
          <br />
          people create
          <br />
          memorable
          <br />
          <em>experiences.</em>
        </p>
        <span className={styles.photoRule} aria-hidden="true" />
      </figcaption>
    </figure>
  );
}
export function CandidateCard() {
  return (
    <article className={`${styles.card} ${styles.candidateCard}`}>
      <p className={styles.kicker}>
        <span className="status-dot" />
        The human connection
      </p>
      <div className={styles.monogram} aria-hidden="true">
        ag
        <span>
          <Check size={15} />
        </span>
      </div>
      <h3>More than a CV.</h3>
      <p className={styles.candidateCopy}>
        Skills, ambition and personality.
        <br />
        We see the person behind the profile.
      </p>
      <div className={styles.cardFooter}>
        <span>
          <MapPin size={13} aria-hidden="true" />
          London
        </span>
        <span>
          People first.
          <Users size={13} aria-hidden="true" />
        </span>
      </div>
    </article>
  );
}
export function SectorSpotlight() {
  return (
    <Link
      href="/contact?sector=Hospitality%20%26%20events"
      className={`${styles.card} ${styles.spotlightCard}`}
    >
      <span className={styles.spotlightIcon}>
        <Utensils size={24} strokeWidth={1.25} aria-hidden="true" />
      </span>
      <span className={styles.spotlightCopy}>
        <span className={styles.kicker}>Sector spotlight</span>
        <strong>Hospitality &amp; events</strong>
        <span>Bring your next chapter to the table.</span>
      </span>
      <ArrowUpRight size={20} aria-hidden="true" />
    </Link>
  );
}
