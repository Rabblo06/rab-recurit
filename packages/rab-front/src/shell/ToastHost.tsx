import { useEffect, useState } from 'react';
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconX } from '@tabler/icons-react';
import type { ToastDetail, ToastVariant } from '../shared/lib/toast';
import { AnimatePresence, motion } from 'framer-motion';
import { duration, ease } from '../shared/motion';

/** Errors stay a little longer so they can be read; hovering pauses the countdown. */
const DISPLAY_MS: Record<ToastVariant, number> = { success: 4000, info: 4000, error: 6000 };
const ICONS = { success: IconCircleCheck, error: IconAlertTriangle, info: IconInfoCircle };

/**
 * Toasts are white cards whose tinted background drains left-to-right as the countdown. The countdown IS the CSS
 * animation on `.toast-progress`: the toast is removed on its `animationend`, so pausing the animation on hover (or
 * keyboard focus) also pauses the dismissal. Under reduced motion the bar is held still for the same duration.
 */
export default function ToastHost() {
  const [toasts, setToasts] = useState<ToastDetail[]>([]);
  const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      setToasts((prev) => [...prev, detail]);
    };
    document.addEventListener('toast', handler);
    return () => document.removeEventListener('toast', handler);
  }, []);

  // Always mounted (an empty fixed host has no size) so the last toast can play its exit.
  return (
    <div className="toast-host">
      <AnimatePresence initial={false}>
      {toasts.map((t) => {
        const Icon = ICONS[t.variant];
        return (
          <motion.div
            key={t.id}
            role={t.variant === 'error' ? 'alert' : 'status'}
            className={`toast toast-${t.variant}`}
            layout="position"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: duration.toastIn, ease: ease.out } }}
            exit={{ opacity: 0, y: 4, transition: { duration: 0.16, ease: ease.in } }}
          >
            <span
              className="toast-progress"
              aria-hidden="true"
              style={{ animationDuration: `${DISPLAY_MS[t.variant]}ms` }}
              onAnimationEnd={() => dismiss(t.id)}
            />
            <Icon className="toast-icon" size={18} aria-hidden="true" />
            <span className="toast-message">{t.message}</span>
            <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              <IconX size={15} />
            </button>
          </motion.div>
        );
      })}
      </AnimatePresence>
    </div>
  );
}
