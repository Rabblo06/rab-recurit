import { useCallback, useEffect, useRef, useState } from 'react';
import { IconAlertCircle, IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconX } from '@tabler/icons-react';
import {
  TOAST_DISMISS_EVENT,
  TOAST_DURATION_MS,
  TOAST_EVENT,
  TOAST_MAX_VISIBLE,
  type ToastDetail,
  type ToastVariant,
} from '../shared/lib/toast';
import { AnimatePresence, motion } from 'framer-motion';
import { duration, ease, usePrefersReducedMotion } from '../shared/motion';

const ICONS = { success: IconCircleCheck, error: IconAlertTriangle, warning: IconAlertCircle, info: IconInfoCircle };
const LABELS: Record<ToastVariant, string> = { success: 'Success', error: 'Error', warning: 'Warning', info: 'Information' };

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
  /** Bumped when an identical toast arrives: restarts the countdown (and the drain) instead of stacking a copy. */
  generation: number;
}

/**
 * Renders `shared/lib/toast` events. White card, variant icon, ✕, and a tinted fill that drains left→right over the
 * toast's display time. The timer lives here (JS), so dismissal never depends on a CSS event that reduced motion or a
 * disabled animation would suppress; the drain is only its picture and pauses with it.
 *
 * - Max `TOAST_MAX_VISIBLE` visible; the rest queue (their timers start only once shown).
 * - Duplicate (same variant + message, visible or queued) → refreshes that toast.
 * - Hover, keyboard focus inside the card, or a hidden tab pauses the countdown.
 * - Errors are `role="alert"` (assertive); success/warning/info are `role="status"` (polite). Nothing takes focus.
 * - Stacks above drawers, modals and popovers (`.toast-host` z-index) without blocking clicks around the cards.
 */
export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((t) => t.id !== id)), []);

  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      if (!detail?.message) return;
      setItems((prev) => {
        const same = prev.find((t) => t.variant === detail.variant && t.message === detail.message);
        if (same) return prev.map((t) => (t === same ? { ...t, generation: t.generation + 1 } : t));
        return [
          ...prev,
          {
            id: detail.id,
            message: detail.message,
            variant: detail.variant,
            duration: detail.duration ?? TOAST_DURATION_MS[detail.variant] ?? TOAST_DURATION_MS.info,
            generation: 0,
          },
        ];
      });
    };
    const onDismiss = (e: Event) => {
      const id = (e as CustomEvent<{ id?: number }>).detail?.id;
      setItems((prev) => (id === undefined ? [] : prev.filter((t) => t.id !== id)));
    };
    document.addEventListener(TOAST_EVENT, onToast);
    document.addEventListener(TOAST_DISMISS_EVENT, onDismiss);
    return () => {
      document.removeEventListener(TOAST_EVENT, onToast);
      document.removeEventListener(TOAST_DISMISS_EVENT, onDismiss);
    };
  }, []);

  const visible = items.slice(0, TOAST_MAX_VISIBLE);
  const queued = items.length - visible.length;

  // Always mounted (an empty fixed host has no size) so the last toast can play its exit.
  return (
    <div className="toast-host" data-queued={queued || undefined}>
      <AnimatePresence initial={false}>
        {visible.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const reduced = usePrefersReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const paused = hovered || focused || hidden;
  const remaining = useRef(item.duration);

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // A refresh (identical toast raised again) restarts the full countdown. Declared before the timer effect so it runs
  // first after the timer's cleanup has subtracted the elapsed time.
  useEffect(() => {
    remaining.current = item.duration;
  }, [item.generation, item.duration]);

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => onDismiss(item.id), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
  }, [paused, item.generation, item.id, onDismiss]);

  const Icon = ICONS[item.variant];
  const isError = item.variant === 'error';
  return (
    <motion.div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`toast toast-${item.variant}${paused ? ' is-paused' : ''}`}
      data-variant={item.variant}
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { duration: duration.toastIn, ease: ease.out } }}
      exit={{ opacity: 0, y: 4, transition: { duration: 0.16, ease: ease.in } }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <span
        key={item.generation}
        className={`toast-progress${reduced ? ' toast-progress-static' : ''}`}
        aria-hidden="true"
        style={{ animationDuration: `${item.duration}ms` }}
      />
      <Icon className="toast-icon" size={18} aria-hidden="true" />
      <span className="toast-message">
        <span className="toast-sr-label">{LABELS[item.variant]}: </span>
        <span className="toast-text">{item.message}</span>
      </span>
      <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={() => onDismiss(item.id)}>
        <IconX size={15} aria-hidden="true" />
      </button>
    </motion.div>
  );
}
