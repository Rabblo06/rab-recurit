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
import { SETUP_STAGES, setupStageStates, type SetupStageKey, type SetupStageState } from './setupStages';

/** Owner requirement: the preparation presentation runs for at least 8s, even if READY is
 * already confirmed on mount. Presentation only — READY is still what gates the welcome. */
export const MIN_ANIMATION_MS = 8_000;
/** Pause on the final (real) checkmark before the welcome takes over. */
export const READY_BEAT_MS = 600;

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Reached only via explicit navigation right after `CreateProfileScreen` completes onboarding.
 * Polls the REAL `schemaStatus`; never fakes progress or success. The checklist is SERVER-DERIVED (`setupStages.ts`):
 * no stage moves on a timer. The workspace is provisioned on the server path inside `POST /manager-workspaces`
 * (`core.provision_workspace`, when that migration is approved; otherwise by the Worker provisioner), so it is usually
 * READY before this screen mounts.
 *  - CREATING here means provisioning has not finished (connection lost, a restart, a lost response, or the Worker
 *    provisioner still working): the screen resumes it ONCE per mount by repeating the same idempotent create request
 *    (same name + subdomain). The server serialises it with any attempt still running; READY happens exactly once.
 *    A page refresh mid-setup does the same.
 *  - FAILED (rolled back, nothing partial): "Try again" repeats the same idempotent request. Never automatic.
 *  - A failed poll or resume shows an honest "connection lost" notice and keeps polling; it never shows progress.
 * FAILED, SUPERSEDED and a missing status never continue. The 8s floor is presentation only and never a bypass.
 */
export default function WorkspacePreparationScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const reduceMotion = Boolean(useReducedMotion());
  const { data: workspace, isLoading, isError, refetch } = useMyWorkspace({ pollWhileCreating: true, pollIntervalMs: 2500 });
  const { data: profile } = useCurrentProfile();

  // Single-use flag retained for parity with its existing contract; no visible branching.
  useState(() => {
    isSelfServiceWorkspace();
    clearSelfServiceWorkspace();
    return null;
  });
  const [welcomeFor] = useState(() => pendingManagerWelcomeFor());

  const [floorReached, setFloorReached] = useState(false);
  const [readyBeatDone, setReadyBeatDone] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);
  const resumeInFlight = useRef(false);
  // Persisted across StrictMode's synthetic unmount/remount: one automatic resume per workspace per mount.
  const autoResumedFor = useRef<string | null>(null);
  // Persisted across StrictMode's synthetic unmount/remount so re-arming the floor timer resumes
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
    const id = setTimeout(() => setFloorReached(true), Math.max(0, MIN_ANIMATION_MS - elapsed));
    return () => clearTimeout(id);
  }, [presentable]);

  /** Repeats the SAME create request (idempotent on the server) to resume or retry provisioning. */
  async function resumeProvisioning(target: { name: string; subdomain: string }) {
    if (resumeInFlight.current) return;
    resumeInFlight.current = true;
    setResuming(true);
    try {
      const { data } = await api.post('/manager-workspaces', { name: target.name, subdomain: target.subdomain });
      if (data) qc.setQueryData(['manager-workspace'], data);
      setResumeFailed(false);
    } catch (err: any) {
      const code = err?.response?.status;
      // No response or a server error: an infrastructure problem, reported honestly. A 4xx is a real answer: re-read.
      setResumeFailed(!code || code >= 500);
      await refetch();
    } finally {
      resumeInFlight.current = false;
      setResuming(false);
    }
  }

  useEffect(() => {
    if (!workspace || status !== 'CREATING' || autoResumedFor.current === workspace.id) return;
    autoResumedFor.current = workspace.id;
    void resumeProvisioning(workspace);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id, status]);

  useEffect(() => {
    if (!ready) return;
    const id = setTimeout(() => setReadyBeatDone(true), READY_BEAT_MS);
    return () => clearTimeout(id);
  }, [ready]);

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

  const [checkingAgain, setCheckingAgain] = useState(false);
  async function checkAgain() {
    if (checkingAgain) return;
    setCheckingAgain(true);
    try {
      await refetch();
    } finally {
      setCheckingAgain(false);
    }
  }

  async function tryAgain() {
    if (workspace) await resumeProvisioning(workspace);
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

  const connectionLost = isError || resumeFailed;
  const stages = setupStageStates(workspace ? status : undefined);
  const stateLabel = superseded
    ? 'This invitation is no longer valid.'
    : failed
      ? 'We hit a snag preparing your workspace.'
      : ready
        ? 'Your workspace is ready.'
        : connectionLost
          ? 'Connection lost. Still trying.'
          : 'Preparing your workspace.';

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
      {/* Announces real state transitions only. */}
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
        <OnboardingPulsingLogo active={!halted && !ready} tone={halted ? 'failed' : 'default'} />

        {!isLoading && (!workspace || status === null) ? <>
          <h1 style={s.title}>Workspace status unavailable</h1>
          <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>We couldn’t confirm that your workspace is ready. Check again to continue safely.</p>
          <button style={s.submitBtn} onClick={checkAgain} disabled={checkingAgain} aria-busy={checkingAgain || undefined}>{checkingAgain ? 'Checking…' : 'Check again'}</button>
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
            <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>Your workspace could not be prepared. Nothing was left half-built — you can try again, or sign out and try again later.</p>
            {resumeFailed && !resuming ? (
              <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>Trying again didn’t reach the server. Check your connection, then try again.</p>
            ) : null}
            <SetupStageList stages={stages} reduceMotion={reduceMotion} />
            <button style={s.submitBtn} onClick={tryAgain} disabled={resuming}>{resuming ? 'Trying again…' : 'Try again'}</button>
            <button style={s.backBtn} onClick={signOut}>Sign out</button>
          </>
        ) : (
          <>
            <p style={s.title}>Preparing your workspace</p>
            <p className="preparation-description">
              {ready ? 'All set.' : 'The database, FORCE RLS and verification steps run in one transaction, so they finish together.'}
            </p>
            {connectionLost && !ready ? (
              <p className="preparation-connection" style={{ ...s.subtitle, ...s.errorText }}>
                Connection lost — still trying. Your workspace keeps its real state.
              </p>
            ) : null}
            <SetupStageList stages={stages} reduceMotion={reduceMotion} />
          </>
        )}
      </motion.div>
    </div>
  );
}

/** The six server-derived setup stages (see setupStages.ts). Hidden from screen readers: the live region announces state. */
function SetupStageList({ stages, reduceMotion }: { stages: Record<SetupStageKey, SetupStageState>; reduceMotion: boolean }) {
  return (
    <ol className="preparation-steps" aria-hidden="true">
      {SETUP_STAGES.map(({ key, label }) => {
        const state = stages[key];
        return (
          <motion.li
            key={key}
            className={`preparation-step is-${state}`}
            data-state={state}
            data-stage={key}
            initial={false}
            animate={{ opacity: state === 'pending' ? 0.35 : 1, y: reduceMotion ? 0 : state === 'pending' ? 4 : 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.5, ease: EASE }}
          >
            <span className="preparation-step-icon" style={state === 'failed' ? { color: '#b4473b', background: '#f6e6e3' } : undefined}>
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
              ) : state === 'failed' ? (
                <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              ) : state === 'current' ? (
                <span className="preparation-step-dot" />
              ) : null}
            </span>
            {label}
          </motion.li>
        );
      })}
    </ol>
  );
}
