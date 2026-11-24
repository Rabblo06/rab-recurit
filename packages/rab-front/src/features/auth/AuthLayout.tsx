import type { ReactNode } from 'react';
import { IconChevronLeft } from '@tabler/icons-react';
import AuthFloatingPaths from './AuthFloatingPaths';

/** One vector asset for authentication and onboarding; no raster screenshot background. */
export function AuthMark() {
  return <div className="auth-mark"><img src="/images/crewflow-mark.svg" width="48" height="48" alt="Crewflow" /></div>;
}

function Brand() {
  return <div className="auth-brand"><AuthMark /><div><strong>Crewflow</strong><small>by The Adolphus</small></div></div>;
}

function WorkspacePreview() {
  return <aside className="auth-promo">
    <div className="auth-paths-wrap"><AuthFloatingPaths position={1} /><AuthFloatingPaths position={-1} /></div>
    <Brand />
    <div className="auth-promo-copy"><h2>Good people. <em>Great workdays.</em></h2><p>Bring your team, shifts and venues together in one beautifully organised workspace.</p><p className="auth-promo-kicker">LESS ADMIN. MORE MOMENTUM.<span aria-hidden="true" />CREWFLOW</p></div>
  </aside>;
}

/** Composition only: callers continue to own their existing forms, mutations and navigation. */
export default function AuthLayout({ children, variant = 'signin', onBack }: { children: ReactNode; variant?: 'signin' | 'onboarding'; onBack?: () => void }) {
  const onboarding = variant === 'onboarding';
  return <main className={`auth-page${onboarding ? ' auth-page--onboarding' : ''}`}>
    {onboarding ? <div className="auth-onboarding-pattern" aria-hidden="true" /> : <WorkspacePreview />}
    <section className="auth-form-side"><div className="auth-form-card">
      {onboarding ? <header className="auth-onboarding-header">{onBack && <button type="button" className="auth-header-back" aria-label="Back to sign in" title="Back to sign in" onClick={onBack}><IconChevronLeft size={16} /></button>}<Brand /></header> : <AuthMark />}{children}
    </div></section>
  </main>;
}
