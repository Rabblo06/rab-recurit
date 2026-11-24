import { useCallback, useEffect, useRef, useState } from 'react';
import { IconAlertCircle, IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconX } from '@tabler/icons-react';
import {
  defaultToastDuration,
  TOAST_DISMISS_EVENT,
  TOAST_EVENT,
  TOAST_MAX_VISIBLE,
  type ToastAction,
  type ToastDetail,
  type ToastVariant,
} from '../shared/lib/toast';
import { Toaster, sileo } from 'sileo';
import './toast.css';
import { motion } from 'framer-motion';
import { duration, ease, usePrefersReducedMotion } from '../shared/motion';

const ICONS = { success: IconCircleCheck, error: IconAlertTriangle, warning: IconAlertCircle, info: IconInfoCircle };
const LABELS: Record<ToastVariant, string> = { success: 'Success', error: 'Error', warning: 'Warning', info: 'Information' };

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
  /** No countdown: stays until the ✕ or the action is used. */
  persistent: boolean;
  action?: ToastAction;
  /** Bumped when an identical toast arrives: restarts the countdown (and the drain) instead of stacking a copy. */
  generation: number;
}

/**
 * Renders `shared/lib/toast` events. Sileo surface, variant icon, ✕, and a slim countdown line over the
 * toast's display time. The timer lives here (JS), so dismissal never depends on a CSS event that reduced motion or a
 * disabled animation would suppress; the drain is only its picture and pauses with it.
 *
 * - Max `TOAST_MAX_VISIBLE` visible; the rest queue (their timers start only once shown).
 * - Duplicate (same variant + message, visible or queued) → refreshes that toast.
 * - Hover, keyboard focus inside the card, or a hidden tab pauses the countdown. A `persistent` toast has none.
 * - Error/warning display time grows with the text length (`defaultToastDuration`) so long messages can be read.
 * - An optional action button ("Try again", "Sign in again") runs its callback and dismisses the toast.
 * - Errors are `role="alert"` (assertive); success/warning/info are `role="status"` (polite). Nothing takes focus.
 * - Stacks above drawers, modals and popovers (`.toast-host` z-index) without blocking clicks around the cards.
 */
export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [interacting, setInteracting] = useState(false);
  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((t) => t.id !== id)), []);

  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      if (!detail?.message) return;
      setItems((prev) => {
        const same = prev.find((t) => t.variant === detail.variant && t.message === detail.message);
        if (same)
          return prev.map((t) =>
            t === same
              ? { ...t, generation: t.generation + 1, persistent: t.persistent || !!detail.persistent, action: detail.action ?? t.action }
              : t,
          );
        return [
          ...prev,
          {
            id: detail.id,
            message: detail.message,
            variant: detail.variant,
            duration: detail.duration ?? defaultToastDuration(detail.variant, detail.message),
            persistent: !!detail.persistent,
            action: detail.action,
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
      sileo.clear();
    };
  }, []);

  const visible = items.slice(0, TOAST_MAX_VISIBLE);
  const queued = items.length - visible.length;

  return (
    <div className="toast-host" data-queued={queued || undefined}
      onMouseEnter={() => setInteracting(true)} onMouseLeave={() => setInteracting(false)}
      onFocusCapture={() => setInteracting(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInteracting(false); }}>
      <Toaster position="top-right" offset={{ top: 'max(16px, env(safe-area-inset-top))', right: 16 }} />
      {visible.map((item) => <ToastCard key={item.id} item={item} onDismiss={dismiss} interacting={interacting} />)}
    </div>
  );
}

function ToastCard({ item, onDismiss, interacting }: { item: ToastItem; onDismiss: (id: number) => void; interacting: boolean }) {
  const reduced = usePrefersReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const paused = interacting || hovered || focused || hidden;
  const remaining = useRef(item.duration);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.classList.toggle('is-paused', paused);
  }, [paused]);

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
    if (paused || item.persistent) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => onDismiss(item.id), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
  }, [paused, item.persistent, item.generation, item.id, onDismiss]);

  const Icon = ICONS[item.variant];
  const isError = item.variant === 'error';
  const content = (
    <motion.div
      ref={contentRef}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`toast toast-${item.variant}${paused ? ' is-paused' : ''}${item.persistent ? ' is-persistent' : ''}`}
      data-variant={item.variant}
      data-persistent={item.persistent || undefined}
      layout="position"
      initial={false}
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
        className={`toast-progress${reduced || item.persistent ? ' toast-progress-static' : ''}`}
        aria-hidden="true"
        style={{ animationDuration: `${item.duration}ms` }}
      />
      <Icon className="toast-icon" size={18} aria-hidden="true" />
      <span className="toast-message">
        <span className="toast-sr-label">{LABELS[item.variant]}: </span>
        <span className="toast-text">{item.message}</span>
      </span>
      {item.action && (
        <button
          type="button"
          className="toast-action"
          data-sileo-button
          onClick={() => {
            onDismiss(item.id);
            item.action?.onClick();
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" data-sileo-button className="toast-close" aria-label="Dismiss notification" onClick={() => onDismiss(item.id)}>
        <IconX size={15} aria-hidden="true" />
      </button>
    </motion.div>
  );

  // Sileo is the only visual host; the existing event bus, queue and display-time
  // controller stay authoritative. Null disables Sileo's independent countdown.
  useEffect(() => {
    sileo[item.variant]({
      onDismiss: () => onDismiss(item.id),
      id: String(item.id), title: LABELS[item.variant], description: content,
      duration: null, roundness: 20, fill: 'var(--bg-primary)',
      icon: <Icon size={17} aria-hidden="true" />,
      autopilot: { expand: 0, collapse: 2147483647 },
    });
  }, [item, reduced]);
  useEffect(() => () => sileo.dismiss(String(item.id)), [item.id]);
  return null;
}
