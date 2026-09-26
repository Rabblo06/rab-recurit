'use client';
import { useState } from 'react';
import {
  Pause,
  Play,
  Hotel,
  Utensils,
  CalendarDays,
  BriefcaseBusiness,
  Monitor,
  GraduationCap,
} from 'lucide-react';
const sectors = [
  { name: 'Hospitality', icon: Hotel },
  { name: 'Catering & events', icon: Utensils },
  { name: 'Office support', icon: BriefcaseBusiness },
  { name: 'IT & media', icon: Monitor },
  { name: 'Education', icon: GraduationCap },
  { name: 'Specialist recruitment', icon: CalendarDays },
];
export function SectorMarquee() {
  const [paused, setPaused] = useState(false);
  return (
    <section className="sector-strip" aria-label="Our specialist sectors">
      <div className="container strip-top">
        <p className="eyebrow">
          Different industries. The same human approach.
        </p>
        <button
          className="marquee-control"
          onClick={() => setPaused(!paused)}
          aria-label={
            paused ? 'Play sector animation' : 'Pause sector animation'
          }
          aria-pressed={paused}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
      </div>
      <div className={`marquee ${paused ? 'is-paused' : ''}`}>
        <div className="marquee-track">
          {[0, 1].map((copy) => (
            <div className="marquee-group" key={copy} aria-hidden={copy === 1}>
              {sectors.map(({ name, icon: Icon }) => (
                <span key={name}>
                  <Icon size={24} strokeWidth={1.3} />
                  {name}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
