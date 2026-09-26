'use client';
import { useState } from 'react';
import { Phone, Mail, ArrowUpRight } from 'lucide-react';
import { site } from '@/lib/site';
export function ContactOptions({
  initialInterest = 'employer',
}: {
  initialInterest?: 'employer' | 'candidate';
}) {
  const [interest, setInterest] = useState(initialInterest);
  return (
    <div className="contact-options">
      <fieldset>
        <legend>I’m looking to…</legend>
        <div className="interest-options">
          {[
            { value: 'employer', label: 'Find people' },
            { value: 'candidate', label: 'Find work' },
          ].map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name="interest"
                value={option.value}
                checked={interest === option.value}
                onChange={() =>
                  setInterest(
                    option.value === 'candidate' ? 'candidate' : 'employer',
                  )
                }
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="contact-choice" aria-live="polite">
        <p className="eyebrow">
          {interest === 'employer'
            ? 'Tell us about your team'
            : 'Tell us about your next step'}
        </p>
        <h2>
          {interest === 'employer'
            ? 'A conversation, not a form.'
            : 'Your next chapter starts here.'}
        </h2>
        <p>
          {interest === 'employer'
            ? 'Speak directly to our consultants about the people and skills your business needs.'
            : 'Call our consultants for current opportunities. For hospitality, catering and events, you can also email your CV.'}
        </p>
        <a className="button button-dark" href={site.phoneHref}>
          <Phone size={16} />
          {site.phone}
          <ArrowUpRight size={16} />
        </a>
        {interest === 'candidate' && (
          <a
            className="text-link candidate-email"
            href={`mailto:${site.candidateEmail}?subject=Hospitality%20recruitment%20enquiry`}
          >
            <Mail size={16} />
            {site.candidateEmail}
            <ArrowUpRight size={16} />
          </a>
        )}
      </div>
    </div>
  );
}
