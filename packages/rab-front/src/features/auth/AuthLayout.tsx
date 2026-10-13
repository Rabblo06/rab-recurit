import type { ReactNode } from 'react';
import { IconBuilding } from '@tabler/icons-react';

export function AuthMark() {
  return <div className="auth-mark" aria-label="Crewflow"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3L21 19.5H3L12 3Z" fill="currentColor" /></svg></div>;
}

/** Editorial preview only. It never reads or represents live workspace statistics. */
function WorkspacePreview() {
  return <aside className="auth-promo">
    <p className="auth-promo-kicker">LESS ADMIN. MORE MOMENTUM.</p>
    <h2>Good people.<br />Great workdays.</h2>
    <p className="auth-promo-description">Bring your team, shifts and venues together<br className="promo-break" /> in one beautifully organised workspace.</p>
    <div className="auth-preview" aria-label="Illustrative workspace preview, example data">
      <div className="auth-preview-heading"><h3>Your day, in sync</h3><span className="auth-preview-ready">● &nbsp; Team ready</span></div>
      <div className="auth-preview-stats"><div><strong>12</strong><span>Shifts today</span></div><div><strong>38</strong><span>Team members</span></div><div><strong>06</strong><span>Venues</span></div></div>
      <div className="auth-preview-venue"><IconBuilding size={18} /><div>The Grand Hall<span>09:00 – 17:00 · 8 team members</span></div><small>Confirmed</small></div>
      <div className="auth-preview-venue"><IconBuilding size={18} /><div>Riverside House<span>18:00 – 23:00 · 4 team members</span></div><small>Confirmed</small></div>
      <span className="auth-preview-example">Visual example</span>
    </div>
    <div className="auth-promo-footer"><p>Built around the way your team works.</p><span>Staff &nbsp;/&nbsp; Scheduling &nbsp;/&nbsp; Payroll</span></div>
  </aside>;
}

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <main className="auth-page"><WorkspacePreview /><section className="auth-form-side"><div className="auth-form-card"><AuthMark />{children}</div></section></main>;
}
