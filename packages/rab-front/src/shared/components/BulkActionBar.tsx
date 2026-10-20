import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { IconDots, IconX } from '@tabler/icons-react';
import AnimatedNumber from './AnimatedNumber';
import Popover from './Popover';
import { duration, ease, usePrefersReducedMotion } from '../motion';

export interface BulkAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Why it is disabled, or what it will do — shown as the button title. */
  title?: string;
  /** `danger` renders the contrasting light button (reference: Delete). */
  tone?: 'default' | 'danger';
}

/** Below this content width, everything after the first action moves into a "More" menu instead of squeezing labels. */
const COMPACT_WIDTH = 640;

/**
 * Floating bulk-action dock (Crewflow reference): a separate round "clear selection" button and a charcoal bar with
 * "Selected: N", thin dividers and the actions the page already offers. It never invents an action — every action keeps
 * its page's own permission and lifecycle checks. Centred over the main content area (so an open side panel or a
 * collapsed sidebar move it with the content), above the list footer. Stays mounted while the count changes (the
 * number tweens with tabular figures, no re-entrance); enters 10px up over ~220ms, leaves in ~150ms; reduced motion
 * shows/hides it without movement.
 */
export default function BulkActionBar({ count, onClear, actions = [], scopeNote }: {
  count: number;
  onClear: () => void;
  actions?: BulkAction[];
  /** e.g. "2 not on this page" — makes a selection that spans pages explicit. */
  scopeNote?: string;
}) {
  const reduce = usePrefersReducedMotion();
  const [geometry, setGeometry] = useState<{ center: number; width: number }>({ center: window.innerWidth / 2, width: window.innerWidth });
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (count === 0) return;
    const content = document.querySelector<HTMLElement>('.main-content');
    const measure = () => {
      const r = content?.getBoundingClientRect();
      setGeometry(r && r.width > 0 ? { center: r.left + r.width / 2, width: r.width } : { center: window.innerWidth / 2, width: window.innerWidth });
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' && content ? new ResizeObserver(measure) : null;
    if (content) ro?.observe(content);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [count > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (count === 0) setMoreOpen(false); }, [count]);

  const compact = geometry.width < COMPACT_WIDTH && actions.length > 1;
  const inline = compact ? actions.slice(0, 1) : actions;
  const overflow = compact ? actions.slice(1) : [];

  const button = (a: BulkAction) => (
    <button key={a.key} type="button" className={`bulk-action-btn${a.tone === 'danger' ? ' is-danger' : ''}`} onClick={a.onClick} disabled={a.disabled} title={a.title}>
      <span className="bulk-action-icon" aria-hidden="true">{a.icon}</span>{a.label}
    </button>
  );

  return createPortal(
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          className="bulk-action-dock"
          style={{ left: geometry.center }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, x: '-50%' }}
          animate={{ opacity: 1, y: 0, x: '-50%', transition: { duration: reduce ? 0 : 0.22, ease: ease.out } }}
          exit={{ opacity: 0, y: reduce ? 0 : 6, x: '-50%', transition: { duration: reduce ? 0 : 0.15, ease: ease.in } }}
        >
          <button type="button" className="bulk-action-clear" onClick={onClear} aria-label="Clear selection" title="Clear selection">
            <IconX size={16} stroke={1.8} />
          </button>
          <div className="bulk-action-bar" role="toolbar" aria-label="Bulk actions for selected records">
            <span className="bulk-action-count" role="status">
              Selected: <AnimatedNumber value={count} durationS={duration.hover} />
              {scopeNote && <span className="bulk-action-scope"> · {scopeNote}</span>}
            </span>
            {inline.map((a) => <span key={a.key} className="bulk-action-item"><span className="bulk-action-divider" aria-hidden="true" />{button(a)}</span>)}
            {overflow.length > 0 && (
              <span className="bulk-action-item">
                <span className="bulk-action-divider" aria-hidden="true" />
                <button ref={moreRef} type="button" className="bulk-action-btn" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
                  <span className="bulk-action-icon" aria-hidden="true"><IconDots size={16} /></span>More
                </button>
                <Popover open={moreOpen} onClose={() => setMoreOpen(false)} anchorRef={moreRef} align="end" minWidth={180} role="presentation">
                  <div role="menu" aria-label="More bulk actions" className="bulk-action-menu">
                    {overflow.map((a) => (
                      <button key={a.key} type="button" role="menuitem" className={`dropdown-item${a.tone === 'danger' ? ' danger' : ''}`} disabled={a.disabled} title={a.title}
                        onClick={() => { setMoreOpen(false); a.onClick(); }}>
                        {a.icon}{a.label}
                      </button>
                    ))}
                  </div>
                </Popover>
              </span>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
