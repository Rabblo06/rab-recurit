import { useEffect, useState } from 'react';
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconX } from '@tabler/icons-react';
import type { ToastDetail, ToastVariant } from '../shared/lib/toast';

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

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host">
      {toasts.map((t) => {
        const Icon = ICONS[t.variant];
        return (
          <div key={t.id} role={t.variant === 'error' ? 'alert' : 'status'} className={`toast toast-${t.variant}`}>
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
          </div>
        );
      })}
    </div>
  );
}
