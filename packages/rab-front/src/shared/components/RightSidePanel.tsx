import { useEffect, useRef, type ReactNode } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';

/**
 * Shared right-side docked panel.
 *
 * Rendered as a flex child of `.app-layout`, so opening it animates its width
 * from 0 → panel width and the main content shrinks smoothly to make room
 * (push layout, not an overlay). The inner card is fixed-width and anchored to
 * the right edge of the dock, so it visually slides in from right to left.
 *
 * - 250ms ease-in-out open/close, width restored on close
 * - Escape key and clicking outside the panel close it
 * - On small screens (≤640px) the dock becomes a fixed overlay (90vw) instead
 *   of pushing content — see the .side-panel-dock media query
 */
export default function RightSidePanel({ open, onClose, children, width, requestClose, className = '', persistent = false, resizing = false }: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Desktop target width in px. Defaults to 408 (the Ctrl+K panel's width). Mobile always uses 90vw regardless. */
  width?: number;
  className?: string;
  /** A contextual dock stays open while its background page is used. Escape is local to it. */
  persistent?: boolean;
  resizing?: boolean;
  /**
   * Interception hook for Escape/outside-click: return `false` to swallow
   * the close (e.g. an unsaved-changes guard shows its own confirm instead)
   * or omit entirely to close unconditionally, same as before this prop
   * existed.
   */
  requestClose?: () => boolean;
}) {
  const dockRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (dockRef.current) dockRef.current.inert = !open;
    if (open) document.dispatchEvent(new CustomEvent('crewflow:panel-open', { detail: { persistent } }));
  }, [open, persistent]);

  const attemptClose = () => {
    if (requestClose && !requestClose()) return;
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (persistent && !dockRef.current?.contains(e.target as Node)) return;
      attemptClose();
    };
    const onClick = (e: MouseEvent) => {
      if (persistent) return;
      const target = e.target as Node;
      if (dockRef.current && dockRef.current.contains(target)) return;
      // `DateInput`'s calendar and the generic `Popover` both render through
      // a `document.body` portal (so they can escape the drawer's own
      // `overflow-y: auto` body), which means a click inside them lands
      // outside `dockRef` even though the calendar/popover is logically part
      // of this panel's content. Without this check, picking a date (or any
      // portaled popover option) inside a Drawer was read as an outside
      // click and triggered close — showing the unsaved-changes discard
      // prompt instead of just picking the date. Both portals carry this
      // marker for exactly this reason; see DateInput.tsx/Popover.tsx.
      if (target instanceof Element && target.closest('[data-rab-portal]')) return;
      attemptClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, requestClose, persistent]);

  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 640;
  const targetWidth = isMobile ? Math.round(window.innerWidth * 0.9) : (width ?? 408);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={dockRef}
          className={`side-panel-dock ${className}`}
          initial={reducedMotion ? false : { width: 0 }}
          animate={{ width: targetWidth }}
          exit={{ width: 0 }}
          transition={{ duration: reducedMotion || resizing ? 0 : persistent ? 0.2 : 0.25, ease: 'easeInOut' }}
        >
          {/* Inline width only applied on desktop — on mobile the .side-panel
              media-query rule (90vw) must win, and an inline style would
              otherwise always beat it regardless of viewport. */}
          <div className="side-panel" style={!isMobile && width ? { width } : undefined}>
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
