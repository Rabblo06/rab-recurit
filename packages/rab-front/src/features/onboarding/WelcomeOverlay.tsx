import { Fragment, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import Avatar from '../../shared/components/Avatar';
import { titleWordStagger, titleWord } from './onboardingMotion';
import WelcomeHalftoneCanvas from './WelcomeHalftoneCanvas';

export type WelcomeRole = 'platform_admin' | 'ceo' | 'manager';

interface WelcomeOverlayProps {
  role: WelcomeRole;
  firstName?: string | null;
  avatarKey?: string | null;
  organisationName?: string | null;
  workspaceName?: string | null;
  /** Called once the overlay has fully left the screen — the caller navigates/reveals the dashboard here, never before. */
  onDone: () => void;
  autoDismissMs?: number;
}

const COPY: Record<WelcomeRole, (ctx: { organisationName?: string | null; workspaceName?: string | null }) => string> = {
  platform_admin: () => 'Welcome to Crewflow',
  ceo: ({ organisationName }) => (organisationName ? `${organisationName} is ready` : 'Your organisation is ready'),
  manager: ({ workspaceName }) => (workspaceName ? `${workspaceName} is ready` : 'Your workspace is ready'),
};

/**
 * Original Crewflow equivalent of Twenty's WelcomeOverlay — a brief (~3-5s), personalised,
 * once-only full-screen transition shown after a genuine onboarding completion, never copied from
 * Twenty's AGPL source. The caller decides WHEN this mounts (a real completion signal — see
 * `WorkspacePreparationScreen` for the Manager case) and owns the "show once" gating; this
 * component only owns its own entrance/exit and calls `onDone` once it has fully left the screen,
 * so the caller never reveals the dashboard mid-transition.
 *
 * Exit timing is driven by `WelcomeHalftoneCanvas`'s own `onExitComplete` — the halftone's actual
 * dispersal finish — rather than a second, independently-guessed `setTimeout` duration that could
 * drift out of sync with what's visually still animating. The title/avatar fade on the same
 * `leaving` flag via a plain CSS-driven opacity transition (no `AnimatePresence`/exit-unmount
 * here), so there is exactly one place or clock deciding when this component is actually done:
 * the canvas's own finish signal.
 */
export default function WelcomeOverlay({ role, firstName, avatarKey, organisationName, workspaceName, onDone, autoDismissMs = 3200 }: WelcomeOverlayProps) {
  const reduceMotion = useReducedMotion();
  const [leaving, setLeaving] = useState(false);
  const heading = COPY[role]({ organisationName, workspaceName });
  const words = heading.split(' ');

  useEffect(() => {
    const ms = reduceMotion ? Math.min(autoDismissMs, 900) : autoDismissMs;
    const id = setTimeout(() => setLeaving(true), ms);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const textTransitionMs = reduceMotion ? 400 : 650;

  return (
    <div
      className="welcome-overlay"
      role="status"
      aria-live="polite"
      onClick={() => setLeaving(true)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary, #fffefb)',
        cursor: 'pointer',
        overflow: 'hidden',
      }}
    >
      <WelcomeHalftoneCanvas exiting={leaving} reduceMotion={Boolean(reduceMotion)} onExitComplete={onDone} />

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          opacity: leaving ? 0 : 1,
          transform: leaving ? 'translateY(-8px)' : 'translateY(0)',
          transition: `opacity ${textTransitionMs}ms ease, transform ${textTransitionMs}ms ease`,
        }}
      >
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, scale: 0.82 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.1, duration: 0.4, ease: 'easeOut' }}
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            background: 'var(--font-primary, #1a1815)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 24,
          }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path d="M12 3L21 19.5H3L12 3Z" fill="white" />
          </svg>
        </motion.div>

        <motion.h1
          variants={reduceMotion ? undefined : titleWordStagger}
          initial={reduceMotion ? false : 'initial'}
          animate={reduceMotion ? undefined : 'animate'}
          style={{ fontSize: 26, fontWeight: 600, color: 'var(--font-primary, #1a1815)', margin: '0 0 8px', textAlign: 'center' }}
        >
          {reduceMotion
            ? heading
            : words.map((word, i) => (
                <motion.span key={`${word}-${i}`} variants={titleWord} style={{ display: 'inline-block' }}>
                  {word}
                  {i < words.length - 1 ? ' ' : ''}
                </motion.span>
              ))}
        </motion.h1>

        {firstName && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : { delay: 0.1 + words.length * 0.07 + 0.25, duration: 0.4, ease: 'easeOut' }}
            style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}
          >
            <Avatar imageKey={avatarKey} label={firstName} alt={firstName} variant="panel" />
            <span style={{ fontSize: 14, color: 'var(--font-secondary, #78746c)' }}>Welcome, {firstName}</span>
          </motion.div>
        )}
      </div>
    </div>
  );
}
