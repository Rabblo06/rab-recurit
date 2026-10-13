import type { Transition, Variants } from 'framer-motion';

/**
 * Shared Twenty-inspired motion primitives for the onboarding/activation flow — additive to
 * `authStyles.ts`'s existing `ease`/`fadeIn`/`stepVariants` (Login/ActivateAccount/SetPassword's
 * own step-swap transitions), not a replacement. Framer Motion already respects
 * `prefers-reduced-motion` automatically for its own `animate`/`transition` props when a
 * component also calls `useReducedMotion()` and branches on it — every component that uses these
 * variants does that explicitly rather than relying on CSS alone, since these are JS-driven
 * transform/opacity animations, not CSS transitions.
 */
export const fieldEase: Transition = { ease: 'easeOut', duration: 0.28 };

/** Wraps a group of fields/labels — each direct child using `staggerItem` enters with a short gap after the previous one. */
export const staggerContainer: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
};

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: fieldEase },
};

/** Reduced-motion counterpart — same initial/final values, no movement, near-instant. Used instead of `staggerItem`/`staggerContainer` when `useReducedMotion()` reports true, rather than relying on Framer Motion's own global reduction (which only suppresses `transform`, not the staggered delay itself — a reduced-motion user would still wait through the stagger with nothing visibly happening). */
export const staggerContainerReduced: Variants = {
  initial: {},
  animate: {},
};

export const staggerItemReduced: Variants = {
  initial: { opacity: 1, y: 0 },
  animate: { opacity: 1, y: 0, transition: { duration: 0 } },
};

/** Full-screen overlay (Welcome, Workspace Preparation) enter/exit. */
export const overlayFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.35, ease: 'easeOut' } },
  exit: { opacity: 0, transition: { duration: 0.3, ease: 'easeIn' } },
};

/**
 * Set by `ActivateAccount.tsx` the instant activation genuinely succeeds (never guessed, never
 * set speculatively) — the one signal `Layout.tsx` uses to show the CEO/Super-Admin
 * `WelcomeOverlay` exactly once, on the very next authenticated page load. An internal Manager's
 * own onboarding (`CreateProfileScreen.tsx`) clears this unconditionally before it ever reaches
 * `Layout`, since that role gets its welcome from `WorkspacePreparationScreen` instead — without
 * that, a Manager would see two welcome overlays back to back.
 *
 * Stores a timestamp, not a bare flag: if activation happens but the tab is abandoned before
 * ever logging in, and a DIFFERENT account later logs in on that same tab, a stale flag with no
 * expiry could show that unrelated account a welcome it never earned. `hasPendingWelcome()`
 * treats anything older than `PENDING_WELCOME_TTL_MS` as expired.
 */
export const PENDING_WELCOME_KEY = 'crewflow:pendingWelcome';
const PENDING_WELCOME_TTL_MS = 5 * 60 * 1000;

export function markPendingWelcome(): void {
  try { sessionStorage.setItem(PENDING_WELCOME_KEY, String(Date.now())); } catch { /* unavailable in this browser context — no welcome overlay, not a functional failure */ }
}

export function hasPendingWelcome(): boolean {
  try {
    const raw = sessionStorage.getItem(PENDING_WELCOME_KEY);
    if (!raw) return false;
    const setAt = Number(raw);
    return Number.isFinite(setAt) && Date.now() - setAt < PENDING_WELCOME_TTL_MS;
  } catch {
    return false;
  }
}

export function clearPendingWelcome(): void {
  try { sessionStorage.removeItem(PENDING_WELCOME_KEY); } catch { /* best-effort cleanup only */ }
}

/**
 * One-time Manager welcome trigger. Set by `CreateProfileScreen.tsx` only after
 * `complete-onboarding` genuinely succeeds, storing that workspace's id (never credentials or
 * identity data). `WorkspacePreparationScreen` shows the welcome only when the stored id matches
 * the server-confirmed READY workspace, and consumes it only once the overlay has actually
 * mounted — so a refresh mid-preparation still gets its welcome, while a refresh after the welcome
 * started (or a later visit to `/onboarding/preparing`) goes straight to the dashboard. Bound to the
 * workspace id rather than a TTL, so it can never fire for a different account's workspace.
 */
export const PENDING_MANAGER_WELCOME_KEY = 'crewflow:pendingManagerWelcome';

export function markPendingManagerWelcome(workspaceId: string): void {
  try { sessionStorage.setItem(PENDING_MANAGER_WELCOME_KEY, workspaceId); } catch { /* unavailable — no welcome, dashboard still reachable on READY */ }
}

export function pendingManagerWelcomeFor(): string | null {
  try { return sessionStorage.getItem(PENDING_MANAGER_WELCOME_KEY); } catch { return null; }
}

export function clearPendingManagerWelcome(): void {
  try { sessionStorage.removeItem(PENDING_MANAGER_WELCOME_KEY); } catch { /* best-effort cleanup only */ }
}

/**
 * Set by `CreateWorkspaceScreen.tsx` the instant its OWN self-service `POST /manager-workspaces`
 * succeeds — the one signal `WorkspacePreparationScreen.tsx` uses to tell a self-service/legacy
 * workspace apart from a P2.9C invite-time-provisioned one. There is no database column for this
 * (none was added — see CLAUDE.md's migration discipline); the self-service and invite-time
 * paths are instead distinguished by WHICH route created the workspace in THIS browser session.
 * An invite-time-provisioned workspace already exists before the Manager ever reaches onboarding
 * at all, so this flag is never set for that path, and `WorkspacePreparationScreen` requires
 * genuine `schemaStatus === 'READY'` before ever treating it as complete.
 */
export const SELF_SERVICE_WORKSPACE_KEY = 'crewflow:selfServiceWorkspace';

export function markSelfServiceWorkspace(): void {
  try { sessionStorage.setItem(SELF_SERVICE_WORKSPACE_KEY, '1'); } catch { /* best-effort only — see isSelfServiceWorkspace's own doc comment on the safe failure direction */ }
}

/**
 * Best-effort only: if unavailable, this reads as `false`, which routes through the STRICTER
 * (invite-time) branch in `WorkspacePreparationScreen` — never silently grants the self-service
 * bypass that was never earned. Consumed (read once, then cleared) by that screen, never left to
 * linger into a later, unrelated onboarding attempt in the same tab.
 */
export function isSelfServiceWorkspace(): boolean {
  try { return sessionStorage.getItem(SELF_SERVICE_WORKSPACE_KEY) === '1'; } catch { return false; }
}

export function clearSelfServiceWorkspace(): void {
  try { sessionStorage.removeItem(SELF_SERVICE_WORKSPACE_KEY); } catch { /* best-effort cleanup only */ }
}

/** A single rotating status caption (Workspace Preparation's "Creating your workspace…" list) — crossfades with a small upward drift, never more than one caption visible mid-transition. */
export const captionSwap: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } },
  exit: { opacity: 0, y: -10, transition: { duration: 0.25, ease: 'easeIn' } },
};

/**
 * Welcome overlay title, animated word-by-word (Twenty-inspired choreography, original
 * implementation): each `<motion.span>` word uses `titleWord` inside a `titleWordStagger`
 * container — staggered opacity + a small upward settle, no bounce.
 */
export const titleWordStagger: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.07, delayChildren: 0.15 } },
};

export const titleWord: Variants = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.45, ease: 'easeOut' } },
};

/**
 * Workspace Preparation's vertical message stack (Phase 3's choreography): the ACTIVE message
 * ("current") is fully visible at y=0; the one about to become active ("next") sits below at
 * reduced opacity; everything else ("hidden") is invisible, ready to slide up into "next" on the
 * following rotation. All three slots animate with the SAME transition so the whole stack reads
 * as one continuous upward scroll rather than three independently-timed fades.
 */
export const messageStackSlot: Variants = {
  current: { opacity: 1, y: 0, transition: { duration: 0.5, ease: 'easeOut' } },
  next: { opacity: 0.35, y: 22, transition: { duration: 0.5, ease: 'easeOut' } },
  hidden: { opacity: 0, y: 44, transition: { duration: 0.5, ease: 'easeOut' } },
};
