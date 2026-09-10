import { useCallback, useEffect, useState } from 'react';
import type { ColumnConfig } from './types';

/**
 * Presentation-only preference (which columns are visible) — deliberately
 * `localStorage`, not a backend `UserPreference` row: no existing
 * per-user-preference API/table exists in this repo to extend (checked:
 * grep for `UserPreference`/`preferences` found none), and inventing one
 * purely for "is the Phone column hidden" would be real backend complexity
 * for a value that is never security-relevant (hiding a column changes
 * nothing about what data the query returns — see ColumnVisibilityMenu's
 * own doc comment). Per-browser, not per-account, is an acceptable
 * trade-off for this.
 */
export function useColumnVisibility(storageKey: string, columns: ColumnConfig[]) {
  const fullKey = `rab.columns.${storageKey}`;
  const defaults = (): Record<string, boolean> =>
    Object.fromEntries(columns.map((c) => [c.key, true]));

  const [visibility, setVisibility] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(fullKey);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      // Merge over defaults so a column added after a user's last visit
      // starts visible, rather than silently missing from a stale blob.
      return { ...defaults(), ...parsed };
    } catch {
      return defaults();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(fullKey, JSON.stringify(visibility));
    } catch {
      // Best-effort — a private window or full storage just means the
      // preference doesn't persist across reloads, never a functional break.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibility]);

  const toggle = useCallback((key: string) => {
    setVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const reset = useCallback(() => setVisibility(defaults()), [columns]);

  const isVisible = useCallback((key: string) => visibility[key] !== false, [visibility]);

  return { isVisible, toggle, reset };
}
