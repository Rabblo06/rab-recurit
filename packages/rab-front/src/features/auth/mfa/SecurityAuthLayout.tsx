import type { ReactNode } from 'react';

import { AcsIcon } from './ui/icons';
import './ui/account-security.css';

/**
 * The design's sign-in split (`signin()`: 42% story / 58% form), used ONLY while a sign-in waits for its second factor
 * (owner decision 2026-10-24). The welcome / email / password steps, the Google/Microsoft buttons and the login-handoff
 * landing keep the existing `AuthLayout`. The story panel is purely decorative (no live data); it is hidden ≤ 640px.
 * The design's "Privacy · Terms · Help centre" footer is left out: those pages don't exist before sign-in.
 */
export function SecurityStoryPanel() {
  return (
    <aside className="acs-auth-story" aria-hidden="true">
      <div className="acs-brand">
        <span className="acs-brand-mark">
          <AcsIcon name="check" />
        </span>
        Crewflow
      </div>
      <div className="acs-story-content">
        <div className="acs-illustration">
          <div className="acs-ill-card">
            <AcsIcon name="lock" />
            <div className="acs-ill-line" />
            <div className="acs-ill-line" />
          </div>
          <div className="acs-ill-shield">
            <AcsIcon name="shield" />
          </div>
          <div className="acs-ill-code">••••••</div>
        </div>
        <h2>
          Your team.
          <br />
          Your workspace.
          <br />
          Protected.
        </h2>
        <p>A little extra security for the people and work that matter.</p>
      </div>
      <p className="acs-story-foot">Crewflow · Workforce management</p>
    </aside>
  );
}

export default function SecurityAuthLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <main className="acs acs-auth">
      <SecurityStoryPanel />
      <section className="acs-auth-main">
        <div className="acs-auth-card">{children}</div>
      </section>
    </main>
  );
}
