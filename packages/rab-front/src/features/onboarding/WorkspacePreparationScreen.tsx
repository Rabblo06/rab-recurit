import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { api, broadcastLogout, withAuthLock } from '../../shared/api';
import { markUnauthenticated } from '../../shared/lib/auth-session';
import { useMyWorkspace } from '../../shared/hooks/useMyWorkspace';
import { useCurrentProfile } from '../../shared/hooks/useCurrentProfile';
import { s } from '../auth/authStyles';
import {
  isSelfServiceWorkspace,
  clearSelfServiceWorkspace,
  pendingManagerWelcomeFor,
  clearPendingManagerWelcome,
} from './onboardingMotion';
import OnboardingPulsingLogo from './OnboardingPulsingLogo';
import WelcomeOverlay from './WelcomeOverlay';

/** Owner requirement: the preparation presentation runs for at least 8s, even if READY is
 * already confirmed on mount. Presentation only — READY is still what gates the welcome. */
export const MIN_ANIMATION_MS = 8_000;
/** Checklist stage boundaries: item 2 becomes active at 2s, item 3 at 4s, "finishing" at 6s. */
export const STAGE_STARTS_MS = [2_000, 4_000, 6_000] as const;
/** Pause on the final (real) checkmark before the welcome takes over, when READY arrives late. */
export const READY_BEAT_MS = 600;

const STEPS = ['Setting up your workspace', 'Getting everything in place', 'Making it feel like home'] as const;
const EASE = [0.22, 1, 0.36, 1] as const;

type StepState = 'pending' | 'current' | 'complete';

/**
 * Reached only via explicit navigation right after `CreateProfileScreen` completes onboarding.
 * Polls the REAL `schemaStatus`; never fakes progress or success. The checklist is decorative
 * (no backend sub-stages exist): items 1–2 tick over on a fixed rhythm, but the LAST item's
 * checkmark appears only once the server genuinely reports READY. FAILED, SUPERSEDED and a
 * missing status never continue; the timer is never permission to bypass provisioning. A slow CREATING keeps this same
 * preparing view (polling every 2.5s) and goes straight to the welcome on READY — no separate "still preparing" page.
 */
export default function WorkspacePreparationScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const reduceMotion = Boolean(useReducedMotion());
  const { data: workspace, isLoading, refetch } = useMyWorkspace({ pollWhileCreating: true, pollIntervalMs: 2500 });
  const { data: profile } = useCurrentProfile();

  // Single-use flag retained for parity with its existing contract; no visible branching.
  useState(() => {
    isSelfServiceWorkspace();
    clearSelfServiceWorkspace();
    return null;
  });
  const [welcomeFor] = useState(() => pendingManagerWelcomeFor());

  const [stage, setStage] = useState(0);
  const [floorReached, setFloorReached] = useState(false);
  const [readyBeatDone, setReadyBeatDone] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  // Persisted across StrictMode's synthetic unmount/remount so re-arming the timers below resumes
  // the same clock instead of restarting it.
  const startedAtRef = useRef<number | null>(null);

  const status = workspace?.schemaStatus ?? null;
  const superseded = status === 'SUPERSEDED';
  const failed = status === 'FAILED';
  const ready = status === 'READY';
  const presentable = !isLoading && !!workspace && status !== null;
  const welcomeEligible = !!workspace && welcomeFor === workspace.id;
  const halted = superseded || failed;

  useEffect(() => {
    if (!presentable) return;
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const elapsed = Date.now() - startedAtRef.current;
    const ids = [
      ...STAGE_STARTS_MS.map((at, i) => setTimeout(() => setStage((cur) => Math.max(cur, i + 1)), Math.max(0, at - elapsed))),
      setTimeout(() => setFloorReached(true), Math.max(0, MIN_ANIMATION_MS - elapsed)),
    ];
    return () => ids.forEach(clearTimeout);
  }, [presentable]);

  const finalCheck = ready && stage >= STAGE_STARTS_MS.length;
  useEffect(() => {
    if (!finalCheck) return;
    const id = setTimeout(() => setReadyBeatDone(true), READY_BEAT_MS);
    return () => clearTimeout(id);
  }, [finalCheck]);

  // A completed onboarding with no pending welcome (refresh after the welcome began, or a later
  // visit to this URL) never replays anything — straight to the dashboard, still only on READY.
  useEffect(() => {
    if (ready && !welcomeEligible && !showWelcome) nav('/', { replace: true });
  }, [ready, welcomeEligible, showWelcome, nav]);

  useEffect(() => {
    if (ready && welcomeEligible && floorReached && readyBeatDone) setShowWelcome(true);
  }, [ready, welcomeEligible, floorReached, readyBeatDone]);

  // Consumed only after the overlay has committed to the screen, never before it begins.
  useEffect(() => {
    if (showWelcome) clearPendingManagerWelcome();
  }, [showWelcome]);

  async function checkAgain() {
    await refetch();
  }

  async function signOut() {
    try {
      await withAuthLock(() => api.post('/auth/logout'));
    } catch {
      // Best-effort: still clear the local session even if the revoke call fails.
    }
    clearPendingManagerWelcome();
    markUnauthenticated();
    broadcastLogout();
    qc.clear();
    nav('/login');
  }

  if (showWelcome) {
    return (
      <WelcomeOverlay
        role="manager"
        firstName={profile?.firstName}
        avatarKey={profile?.avatarKey}
        workspaceName={workspace?.name}
        onDone={() => nav('/', { replace: true })}
      />
    );
  }

  const finishing = stage >= STAGE_STARTS_MS.length && !ready;
  const stateLabel = superseded
    ? 'This invitation is no longer valid.'
    : failed
      ? 'We hit a snag preparing your workspace.'
      : ready && stage >= STAGE_STARTS_MS.length
          ? 'Your workspace is ready.'
          : 'Preparing your workspace.';

  function stepState(i: number): StepState {
    if (i < STEPS.length - 1) return stage > i ? 'complete' : stage === i ? 'current' : 'pending';
    if (finalCheck) return 'complete';
    return stage >= i ? 'current' : 'pending';
  }

  return (
    <div className="workspace-preparation"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary, #fffefb)',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      {/* Announces real state transitions only, never the decorative checklist ticks. */}
      <span
        role="status" aria-live="polite"
        style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
      >
        {stateLabel}
      </span>

      <motion.div className="preparation-content"
        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.45, ease: EASE }}
        style={{ position: 'relative', zIndex: 1, textAlign: 'center', maxWidth: 360, padding: '0 24px' }}
      >
        <OnboardingPulsingLogo active={!halted && !finalCheck} tone={halted ? 'failed' : 'default'} />

        {!isLoading && (!workspace || status === null) ? <>
          <h1 style={s.title}>Workspace status unavailable</h1>
          <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>We couldn’t confirm that your workspace is ready. Check again to continue safely.</p>
          <button style={s.submitBtn} onClick={checkAgain}>Check again</button>
          <button style={s.backBtn} onClick={signOut}>Sign out</button>
        </> : superseded ? (
          <>
            <p style={s.title}>This invitation is no longer valid</p>
            <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>
              Your invitation has been replaced by a new one. If this is unexpected, contact whoever invited you — otherwise, sign out.
            </p>
            <button style={s.backBtn} onClick={signOut}>Sign out</button>
          </>
        ) : failed ? (
          <>
            <p style={s.title}>We hit a snag preparing your workspace</p>
            <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>Your workspace could not be prepared. This has been reported — you can check again, or sign out and try again later.</p>
            <button style={s.submitBtn} onClick={checkAgain}>Check again</button>
            <button style={s.backBtn} onClick={signOut}>Sign out</button>
          </>
        ) : (
          <>
            <p style={s.title}>Preparing your workspace</p>
            <p className="preparation-description">
              {finishing && floorReached ? 'Almost there — just finishing up.' : 'A few finishing touches, then you’re in.'}
            </p>
            <ol className="preparation-steps" aria-hidden="true">
              {STEPS.map((label, i) => {
                const state = stepState(i);
                return (
                  <motion.li
                    key={label}
                    className={`preparation-step is-${state}`}
                    data-state={state}
                    initial={false}
                    animate={{
                      opacity: state === 'pending' ? (i - stage === 1 ? 0.45 : 0.2) : 1,
                      y: reduceMotion ? 0 : state === 'pending' ? 4 : 0,
                    }}
                    transition={{ duration: reduceMotion ? 0 : 0.5, ease: EASE }}
                  >
                    <span className="preparation-step-icon">
                      {state === 'complete' ? (
                        <motion.svg
                          key="check"
                          width="10" height="10" viewBox="0 0 12 12" fill="none"
                          initial={reduceMotion ? false : { scale: 0.4, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={{ duration: reduceMotion ? 0 : 0.35, ease: EASE }}
                        >
                          <motion.path
                            d="M2.5 6.2 5 8.6 9.6 3.6"
                            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                            initial={reduceMotion ? false : { pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: reduceMotion ? 0 : 0.4, ease: EASE, delay: reduceMotion ? 0 : 0.05 }}
                          />
                        </motion.svg>
                      ) : state === 'current' ? (
                        <span className="preparation-step-dot" />
                      ) : null}
                    </span>
                    {label}
                  </motion.li>
                );
              })}
            </ol>
          </>
        )}
      </motion.div>
    </div>
  );
}
