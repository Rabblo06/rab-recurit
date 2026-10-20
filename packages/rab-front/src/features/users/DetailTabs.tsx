import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { dropdown, spring } from '../../shared/motion';
import type { KeyboardEvent, ReactNode } from 'react';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import './detail-tabs.css';

export interface DetailTabDef<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
}

/**
 * Compact detail-panel tab strip: a few primary tabs plus an overflow menu ("+2 More"). An overflow tab that is selected
 * is shown in the strip as the active tab (its own underline) and the trigger shrinks to a chevron, so the strip never
 * clips at narrow drawer widths. The menu closes on outside click, Escape (focus returns to the trigger), Tab or a
 * choice; Arrow keys / Home / End move between items.
 */
export default function DetailTabs<T extends string>({
  primary,
  overflow,
  value,
  onChange,
}: {
  primary: DetailTabDef<T>[];
  overflow: DetailTabDef<T>[];
  value: T;
  onChange: (tab: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const groupId = useId(); // one underline per tab strip (two panels never share a layoutId)
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  // Which item to focus once the menu has actually rendered (set when opening, consumed by the effect below).
  const pendingFocus = useRef<number | null>(null);
  const activeOverflow = overflow.find((t) => t.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    if (pendingFocus.current != null) {
      items.current[pendingFocus.current]?.focus();
      pendingFocus.current = null;
    }
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const focusItem = (i: number) => items.current[(i + overflow.length) % overflow.length]?.focus();
  const openMenu = (focus: 'first' | 'last' | 'current') => {
    setOpen(true);
    const current = Math.max(0, overflow.findIndex((t) => t.id === value));
    pendingFocus.current = focus === 'first' ? 0 : focus === 'last' ? overflow.length - 1 : current;
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const choose = (tab: T) => {
    onChange(tab);
    close(true);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu(e.key === 'ArrowDown' ? 'first' : 'current');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu('last');
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      close(true);
    }
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = items.current.findIndex((el) => el === document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
    else if (e.key === 'End') { e.preventDefault(); focusItem(overflow.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') close(false);
  };

  const tab = (t: DetailTabDef<T>) => (
    <button
      key={t.id}
      type="button"
      role="tab"
      aria-selected={value === t.id}
      className={`detail-tab${value === t.id ? ' active' : ''}`}
      onClick={() => onChange(t.id)}
    >
      {/* The active underline slides from tab to tab (also onto an overflow tab shown in the strip). */}
      {value === t.id && <motion.span layoutId="detail-tab-underline" className="tab-underline" transition={spring} aria-hidden="true" />}
      {t.icon} {t.label}
    </button>
  );

  return (
    <div className="detail-tabs detail-tabs-compact">
      <LayoutGroup id={groupId}>
      <div className="detail-tabs-list" role="tablist" aria-label="Details">
        {primary.map(tab)}
        {activeOverflow && tab(activeOverflow)}
      </div>
      </LayoutGroup>
      {overflow.length > 0 && (
        <div className="detail-tab-more" ref={wrap}>
          <button
            ref={trigger}
            type="button"
            className="detail-tab detail-tab-more-trigger"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={activeOverflow ? 'More tabs' : undefined}
            onClick={() => (open ? close(false) : openMenu('current'))}
            onKeyDown={onTriggerKey}
          >
            {!activeOverflow && <span>+{overflow.length} More</span>}
            <IconChevronDown size={13} />
          </button>
          <AnimatePresence>
          {open && (
            <motion.div
              className="detail-tab-more-menu"
              role="menu"
              aria-label="More tabs"
              onKeyDown={onMenuKey}
              variants={dropdown}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              {overflow.map((t, i) => (
                <button
                  key={t.id}
                  ref={(el) => { items.current[i] = el; }}
                  type="button"
                  role="menuitem"
                  aria-current={value === t.id ? 'page' : undefined}
                  tabIndex={-1}
                  onClick={() => choose(t.id)}
                >
                  {t.icon} <span>{t.label}</span>
                  {value === t.id && <IconCheck size={13} className="detail-tab-more-check" />}
                </button>
              ))}
            </motion.div>
          )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
