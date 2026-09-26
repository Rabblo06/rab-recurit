import { ArrowDown } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-content container">
        <p className="eyebrow hero-eyebrow">
          <span className="status-dot" />
          London recruitment, with a personal touch
        </p>
        <h1 id="hero-title">
          <span>Great people.</span>
          <em>New possibilities.</em>
        </h1>
        <p className="hero-copy">
          The right connection changes everything.
          <br className="desktop-break" /> We bring people and businesses
          together through
          <br className="desktop-break" /> temporary, interim and permanent
          recruitment.
        </p>
        <div className="hero-actions">
          <ButtonLink href="/contact?interest=employer">Find talent</ButtonLink>
          <ButtonLink href="/jobs" variant="outline">
            Find work
          </ButtonLink>
        </div>
        <div className="hero-footnote">
          <span>People first. Always.</span>
          <span className="footnote-line" />
          <span>Based in London. Built on relationships.</span>
        </div>
        <a
          className="scroll-cue"
          href="#connections"
          aria-label="Explore our approach"
        >
          <ArrowDown size={16} />
        </a>
      </div>
    </section>
  );
}
