import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { dropdown } from '../motion';

/**
 * Generic anchored popover — the same portal/fixed-position architecture
 * `DateInput.tsx` already uses for its calendar, extracted here so every
 * toolbar control (Filter/Sort/Options, and any future one) gets identical,
 * already-proven positioning instead of each reinventing it: renders
 * through a `document.body` portal (escapes any ancestor's `overflow:hidden`
 * / `overflow-y:auto`, e.g. a table's scroll container or a Drawer), computed
 * from the anchor's own `getBoundingClientRect()` as `position: fixed`,
 * flips above when there isn't room below, clamps horizontally to the
 * viewport, and recomputes on scroll/resize while open.
 */
export default function Popover({
  open,
  onClose,
  anchorRef,
  children,
  align = 'start',
  minWidth = 260,
  className = '',
  role = 'dialog',
  animated = true,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  /** 'start' aligns the popover's left edge with the anchor's left edge; 'end' aligns right edges. */
  align?: 'start' | 'end';
  minWidth?: number;
  className?: string;
  role?: 'dialog' | 'presentation';
  /**
   * Menu motion (default on, `shared/motion.ts` `dropdown`: 180ms fade + 6px from the trigger, 130ms exit; it rises
   * upward when the popover flips above). Transform/opacity only, so it never resizes the popover — the reposition
   * guard below still converges. Pass `false` for an instant popover.
   */
  animated?: boolean;
}) {
  const [coords, setCoords] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const popoverElRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const reducedMotion = useReducedMotion();

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const estimatedHeight = popoverElRef.current?.offsetHeight ?? 280;
    const estimatedWidth = popoverElRef.current?.offsetWidth ?? minWidth;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < estimatedHeight + 8 && rect.top > estimatedHeight + 8;
    const rawLeft = align === 'end' ? rect.right - estimatedWidth : rect.left;
    const left = Math.round(Math.max(8, Math.min(rawLeft, window.innerWidth - estimatedWidth - 8)));
    const rawTop = flipUp ? rect.top - estimatedHeight - 4 : rect.bottom + 4;
    const top = Math.round(animated ? Math.max(8, Math.min(rawTop, window.innerHeight - estimatedHeight - 8)) : rawTop);
    // Skip the state update entirely when nothing actually moved —
    // `setCoords({...})` always allocates a new object, which React treats
    // as a genuine change regardless of value equality. Without this guard,
    // any resize of this popover's content (e.g. selecting a filter value,
    // which legitimately changes its rendered height) re-triggers the
    // ResizeObserver callback below, which re-renders, which fires the
    // observer again — a loop that never converges and fails Playwright's
    // element-stability check (confirmed live: "element is not stable" /
    // "detached from the DOM, retrying", worst on the largest popover
    // content, Audit Log's 58-option Action select, where sub-pixel reflow
        // made the two computed positions never quite bitwise-equal).
    setCoords((prev) => (prev && prev.top === top && prev.left === left && prev.up === flipUp ? prev : { top, left, up: flipUp }));
  }, [anchorRef, align, minWidth, animated]);

  // Ties the ResizeObserver to the exact DOM node's mount/unmount, not to
  // "did any ancestor re-render" — a plain `useRef` + an `[open]`-keyed
  // effect would try to `.observe()` before the portaled node exists yet
  // (`coords` is still null on the render that opens the popover), silently
  // observing nothing.
  const setPopoverRef = useCallback((node: HTMLDivElement | null) => {
    popoverElRef.current = node;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (node) {
      resizeObserverRef.current = new ResizeObserver(updatePosition);
      resizeObserverRef.current.observe(node);
    }
  }, [updatePosition]);

  useEffect(() => {
    if (!open) {
      if (popoverElRef.current) popoverElRef.current.inert = true;
      if (!animated) setCoords(null);
      return;
    }
    if (popoverElRef.current) popoverElRef.current.inert = false;
    updatePosition();
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (popoverElRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if ((!open && !animated) || !coords) return null;

  const panelProps = {
    ref: setPopoverRef,
    className: `rab-popover ${className}`,
    'data-rab-portal': 'true',
    style: { position: 'fixed' as const, top: coords.top, left: coords.left, minWidth },
    role,
  };

  if (animated) return createPortal(
    <AnimatePresence onExitComplete={() => { if (!open) setCoords(null); }}>
      {open && <motion.div {...panelProps}
        variants={dropdown} custom={coords.up ? 1 : 0}
        initial={reducedMotion ? false : 'hidden'} animate="visible" exit="exit">
        {children}
      </motion.div>}
    </AnimatePresence>, document.body,
  );

  return createPortal(
    <div {...panelProps}>
      {children}
    </div>,
    document.body,
  );
}
