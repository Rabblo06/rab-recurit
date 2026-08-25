import { useEffect, useState } from 'react';
import { IconCheck, IconX, IconInfoCircle } from '@tabler/icons-react';
import type { ToastDetail } from '../shared/lib/toast';

const DISPLAY_MS = 4000;
const ICONS = { success: IconCheck, error: IconX, info: IconInfoCircle };

export default function ToastHost() {
  const [toasts, setToasts] = useState<ToastDetail[]>([]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      setToasts((prev) => [...prev, detail]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== detail.id));
      }, DISPLAY_MS);
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
          <div key={t.id} className={`toast${t.variant !== 'info' ? ` toast-${t.variant}` : ''}`}>
            <Icon size={15} />
            {t.message}
          </div>
        );
      })}
    </div>
  );
}
