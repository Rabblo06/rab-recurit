import { useEffect, useState, type ReactNode } from 'react';
import { FormSkeleton, TableSkeleton } from './LoadingState';

/**
 * Suspense fallbacks for code-split routes (fast first navigation, 2026-11-11). They render INSIDE the app layout, so the
 * sidebar, header and nav highlight stay and update at once; only the content area waits.
 *
 * `delayMs`: nothing is shown for the first ~150 ms, so a page whose code is already preloaded (the usual case) never
 * flashes a skeleton; a slow first load shows the skeleton instead of an unchanged, "frozen" page.
 */
export function DelayedFallback({ children, delayMs = 150 }: { children: ReactNode; delayMs?: number }) {
  const [visible, setVisible] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return;
    const id = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs]);
  return visible ? <>{children}</> : null;
}

/** A console page: a title bar and a table-shaped body (most console pages are lists). */
export function PageSkeleton() {
  return (
    <div className="route-skeleton" role="status" aria-busy="true" aria-label="Loading page" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <span className="skeleton" style={{ width: 180, height: 20 }} />
      <TableSkeleton columns={5} rows={8} />
    </div>
  );
}

/** A settings page: a form-shaped body inside the settings layout. */
export function SettingsPageSkeleton() {
  return (
    <div className="route-skeleton" role="status" aria-busy="true" aria-label="Loading settings" style={{ padding: '8px 0' }}>
      <FormSkeleton sections={2} />
    </div>
  );
}
