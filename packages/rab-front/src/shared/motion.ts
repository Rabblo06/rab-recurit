import { useReducedMotion } from 'framer-motion';
import type { Transition, Variants } from 'framer-motion';

/**
 * Crewflow motion tokens — the ONE source of timing/easing for Framer Motion code. CSS mirrors these as custom
 * properties in `shared/motion.css` (`--motion-*`, `--ease-*`) so CSS transitions and JS animations agree.
 *
 * Principles (`.claude/skills/animate`): exits are faster than entrances; only transform/opacity move; springs where
 * the user can interrupt (indicators, layout); 150–300ms for UI chrome; nothing decorative or looping.
 * Reduced motion: the app root wraps everything in `<MotionConfig reducedMotion="user">` (transforms dropped), and
 * components that would otherwise still wait through delays/staggers check `useReducedMotion()` themselves.
 */
export const ease = {
  /** Entrances and most UI: fast start, gentle settle. */
  out: [0.22, 1, 0.36, 1] as [number, number, number, number],
  /** Elements moving on screen / symmetrical transitions. */
  inOut: [0.65, 0, 0.35, 1] as [number, number, number, number],
  /** Exits: accelerate away. */
  in: [0.4, 0, 1, 1] as [number, number, number, number],
};

/** Seconds (Framer Motion units). */
export const duration = {
  hover: 0.15,
  press: 0.1,
  tooltip: 0.15,
  dropdownIn: 0.18,
  dropdownOut: 0.13,
  tab: 0.25,
  indicator: 0.25,
  toastIn: 0.24,
  listItem: 0.25,
  page: 0.28,
  modalIn: 0.26,
  modalOut: 0.18,
  drawerIn: 0.3,
  drawerOut: 0.22,
  drawerContent: 0.2,
  kpi: 0.45,
  chart: 0.5,
  progress: 0.5,
  step: 0.25,
};

/** Interruptible spring for moving indicators (sidebar pill, tab underline, card reflow). */
export const spring: Transition = { type: 'spring', stiffness: 320, damping: 30, mass: 0.9 };
/** Slightly firmer spring for small layout shifts (cards reflowing in a list). */
export const layoutSpring: Transition = { type: 'spring', stiffness: 420, damping: 38 };

/** Gap between staggered siblings (KPI cards, small lists). Kept short: only the first few items are staggered. */
export const STAGGER = 0.05;
/** Never stagger more than this many items; later items appear with the last delay (no long cascades). */
export const MAX_STAGGERED = 8;
export const staggerDelay = (index: number) => Math.min(index, MAX_STAGGERED) * STAGGER;

/** Page content entrance: fade + 10px rise. */
export const pageEnter: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: duration.page, ease: ease.out } },
};

/** Dropdown / popover from its trigger: fade + 6px. `custom` = 1 when the menu opens upwards (flipped). */
export const dropdown: Variants = {
  hidden: (up = 0) => ({ opacity: 0, y: up ? 6 : -6 }),
  visible: { opacity: 1, y: 0, transition: { duration: duration.dropdownIn, ease: ease.out } },
  exit: (up = 0) => ({ opacity: 0, y: up ? 4 : -4, transition: { duration: duration.dropdownOut, ease: ease.in } }),
};

/** Tooltip near the pointer: fade + 4px. */
export const tooltip: Variants = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: duration.tooltip, ease: ease.out } },
  exit: { opacity: 0, y: 2, transition: { duration: 0.1, ease: ease.in } },
};

/** Modal dialog: fade + scale 0.97 + 8px rise; backdrop handled separately. */
export const modal: Variants = {
  hidden: { opacity: 0, scale: 0.97, y: 8 },
  visible: { opacity: 1, scale: 1, y: 0, transition: { duration: duration.modalIn, ease: ease.out } },
  exit: { opacity: 0, scale: 0.98, y: 4, transition: { duration: duration.modalOut, ease: ease.in } },
};
export const backdrop: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: duration.modalIn, ease: ease.out } },
  // Non-interactive while leaving: a confirm button can never be pressed again mid-exit.
  exit: { opacity: 0, pointerEvents: 'none', transition: { duration: duration.modalOut, ease: ease.in } },
};

/** Drawer body content swap (another record opened in the same drawer, or a tab change): short fade + 4px. */
export const contentSwap: Variants = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: duration.drawerContent, ease: ease.out } },
  exit: { opacity: 0, transition: { duration: 0.1, ease: ease.in } },
};

/** List row entering / leaving (review history, pipeline cards). */
export const listItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: (i = 0) => ({ opacity: 1, y: 0, transition: { duration: duration.listItem, ease: ease.out, delay: staggerDelay(i) } }),
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.15, ease: ease.in } },
};

/** Multi-step form: `custom` = +1 forward / -1 back. */
export const step: Variants = {
  enter: (dir = 1) => ({ opacity: 0, x: dir > 0 ? 12 : -12 }),
  center: { opacity: 1, x: 0, transition: { duration: duration.step, ease: ease.out } },
  exit: (dir = 1) => ({ opacity: 0, x: dir > 0 ? -12 : 12, transition: { duration: 0.18, ease: ease.in } }),
};

/** Calendar period change: content slides in the direction of navigation. `custom` = +1 next / -1 previous. */
export const period: Variants = {
  enter: (dir = 1) => ({ opacity: 0, x: dir > 0 ? 16 : -16 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.26, ease: ease.out } },
  exit: (dir = 1) => ({ opacity: 0, x: dir > 0 ? -16 : 16, transition: { duration: 0.16, ease: ease.in } }),
};

/** Inline validation / status message appearing under a field. */
export const message: Variants = {
  hidden: { opacity: 0, y: -4 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.18, ease: ease.out } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: ease.in } },
};

/**
 * Reduced-motion preference, read live. Framer's `useReducedMotion` snapshots the preference into state, which went
 * stale (a reduced-motion user still saw the drawer slide — measured in motion-system.spec.ts); OR-ing in a live
 * `matchMedia` read on every render fixes that without giving up Framer's listener.
 */
export function usePrefersReducedMotion(): boolean {
  const framer = useReducedMotion();
  const live = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  return !!framer || live;
}
