import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { LayoutGroup, motion } from 'framer-motion';
import { spring, usePrefersReducedMotion } from '../motion';

const Selection = createContext<{ register: (id: string, priority: number | null) => void; winner: string | null } | null>(null);

/** One shared-layout selection per sidebar, even when parent routes and shortcuts both match. */
export function NavigationIndicatorScope({ children }: { children: ReactNode }) {
  const parent = useContext(Selection);
  return parent ? <>{children}</> : <IndicatorScope>{children}</IndicatorScope>;
}
function IndicatorScope({ children }: { children: ReactNode }) {
  const scopeId = useId();
  const [candidates, setCandidates] = useState<Record<string, number>>({});
  const register = useCallback((id: string, priority: number | null) => setCandidates(previous => {
    if (priority === null && !(id in previous) || previous[id] === priority) return previous;
    const next = { ...previous };
    if (priority === null) delete next[id]; else next[id] = priority;
    return next;
  }), []);
  const winner = Object.keys(candidates).sort((a, b) => candidates[b]! - candidates[a]! || a.localeCompare(b))[0] ?? null;
  const value = useMemo(() => ({ register, winner }), [register, winner]);
  return <Selection.Provider value={value}><LayoutGroup id={scopeId}>{children}</LayoutGroup></Selection.Provider>;
}

/** Presentation only: callers keep their existing route/permission/click logic. */
export default function NavigationIndicator({ active, priority = 0, className = 'nav-active-pill' }: { active: boolean; priority?: number; className?: string }) {
  const selection = useContext(Selection);
  const id = useId();
  const register = selection?.register;
  const reduced = usePrefersReducedMotion();
  useLayoutEffect(() => {
    register?.(id, active ? priority : null);
    return () => register?.(id, null);
  }, [register, id, active, priority]);
  if (!active || (selection && selection.winner !== id)) return null;
  // A plain element avoids Framer's shared-layout movement under reduced motion.
  return reduced ? <span className={className} data-navigation-indicator aria-hidden="true" />
    : <motion.span className={className} data-navigation-indicator aria-hidden="true" layoutId="sidebar-active-pill" transition={spring} />;
}
