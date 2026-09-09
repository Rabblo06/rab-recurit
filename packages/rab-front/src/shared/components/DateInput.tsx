import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';

const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Every date here is handled as a plain {year, month, day} triple, formatted
 * by string concatenation — never via `Date#toISOString()`, which can shift
 * a day under a non-UTC local clock. `Date` objects are only ever used for
 * pure calendar math (which weekday a date falls on, how many days a month
 * has) via their *local* getters — never serialized, so there's no
 * timezone-conversion path for a day-shift bug to live in.
 */
export function isoToDisplay(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '';
  return `${d}/${m}/${y}`;
}

function daysInMonth(year: number, month: number): number {
  // Local-time month rollover — pure day-count math, nothing stored/compared.
  return new Date(year, month, 0).getDate();
}

function parseDisplay(text: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const day = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const year = parseInt(match[3]!, 10);
  if (month < 1 || month > 12) return null;
  if (year < 1000 || year > 9999) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Monday-first weekday index (0=Mon .. 6=Sun) for the 1st of the given month. */
function firstWeekdayOfMonth(year: number, month: number): number {
  const jsDay = new Date(year, month - 1, 1).getDay(); // 0=Sun..6=Sat
  return (jsDay + 6) % 7;
}

/**
 * Shared date input for both the Create Staff wizard and the Staff Detail
 * panel's inline date fields (Date of birth, Start date, Expiry date) — a
 * plain text input (never `type="date"`, so no permanent native calendar
 * icon) with a lightweight custom popover calendar. Click/focus opens the
 * calendar; typing `DD/MM/YYYY` directly is always allowed and commits once
 * it parses to a real date.
 *
 * The popover renders through a `document.body` portal, positioned from the
 * input's own `getBoundingClientRect()` (`position: fixed`, recomputed on
 * scroll/resize) rather than as an in-flow absolutely-positioned child —
 * the Detail panel's scroll container (`.drawer-body { overflow-y: auto }`)
 * would otherwise clip the calendar for any date field low in the panel.
 * Flips above the input when there isn't room below.
 */
export default function DateInput({
  value, onChange, min, max, placeholder = 'DD/MM/YYYY',
}: {
  /** ISO `YYYY-MM-DD`, or `''` for empty. */
  value: string;
  onChange: (next: string) => void;
  /** ISO `YYYY-MM-DD` bounds, inclusive. */
  min?: string;
  max?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value ? isoToDisplay(value) : '');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const today = todayIso();
  const initial = value || (max && max < today ? max : today);
  const [viewYear, setViewYear] = useState(() => parseInt(initial.slice(0, 4), 10));
  const [viewMonth, setViewMonth] = useState(() => parseInt(initial.slice(5, 7), 10));
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(value ? isoToDisplay(value) : '');
    setError('');
  }, [value]);

  // Viewport-relative (`position: fixed`) coordinates computed from the real
  // input, not the DOM position of the popover itself — that's what lets the
  // portal escape the Detail panel's `overflow-y: auto` scroll container
  // instead of being clipped by it. ~320px is a safe estimate of the
  // calendar's own height for the flip-above decision (measured after mount
  // for the actual value once available, re-measuring on open).
  const updatePosition = () => {
    const input = inputRef.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
    const estimatedHeight = popoverRef.current?.offsetHeight ?? 300;
    const estimatedWidth = popoverRef.current?.offsetWidth ?? 240;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < estimatedHeight + 8 && rect.top > estimatedHeight + 8;
    // Clamp horizontally too — the Detail panel sits flush against the right
    // edge of the viewport, so a field near its right side would otherwise
    // position the calendar starting at the input's left edge and run the
    // fixed 240px-wide popover straight past the browser's own edge.
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - estimatedWidth - 8);
    setCoords({
      top: flipUp ? rect.top - estimatedHeight - 4 : rect.bottom + 4,
      left,
      width: rect.width,
    });
  };

  useEffect(() => {
    if (!open) { setCoords(null); return; }
    updatePosition();
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-measure once the real popover has rendered and we know its real
  // height, in case the ~300px estimate above put it on the wrong side.
  useEffect(() => { if (open) updatePosition(); }, [open, viewMonth, viewYear]);

  const commit = (typed: string) => {
    if (!typed.trim()) {
      setError('');
      onChange('');
      return;
    }
    const iso = parseDisplay(typed);
    if (!iso) {
      setError('Enter a valid date as DD/MM/YYYY.');
      return;
    }
    if (min && iso < min) { setError('Date is too early.'); return; }
    if (max && iso > max) { setError('Date cannot be in the future.'); return; }
    setError('');
    onChange(iso);
  };

  const pick = (day: number) => {
    const iso = `${viewYear}-${pad2(viewMonth)}-${pad2(day)}`;
    setText(isoToDisplay(iso));
    setError('');
    onChange(iso);
    setOpen(false);
  };

  const changeMonth = (delta: number) => {
    let m = viewMonth + delta;
    let y = viewYear;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setViewMonth(m);
    setViewYear(y);
  };

  const leading = firstWeekdayOfMonth(viewYear, viewMonth);
  const totalDays = daysInMonth(viewYear, viewMonth);
  const cells: Array<number | null> = [...Array(leading).fill(null), ...Array.from({ length: totalDays }, (_, i) => i + 1)];

  return (
    <div className="date-input" ref={containerRef}>
      <input
        ref={inputRef}
        type="text"
        value={text}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => { setText(e.target.value); setError(''); }}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          // Only swallow Escape while our own popover is open (closing it
          // first) — otherwise let it bubble, so a caller that wraps this
          // in its own editable-row (Staff Detail) can use a second Escape
          // to cancel that row's edit mode without this component eating it.
          if (e.key === 'Escape') { if (open) { e.stopPropagation(); setOpen(false); } }
          if (e.key === 'Enter') { commit(text); setOpen(false); }
        }}
      />
      {error && <span className="date-input-error">{error}</span>}
      {open && coords && createPortal(
        <div
          className="date-input-popover"
          ref={popoverRef}
          style={{ position: 'fixed', top: coords.top, left: coords.left, minWidth: coords.width }}
        >
          <div className="date-input-popover-header">
            <button type="button" className="btn-icon" onClick={() => changeMonth(-1)} aria-label="Previous month">
              <IconChevronLeft size={14} />
            </button>
            <span>{MONTH_NAMES[viewMonth - 1]} {viewYear}</span>
            <button type="button" className="btn-icon" onClick={() => changeMonth(1)} aria-label="Next month">
              <IconChevronRight size={14} />
            </button>
          </div>
          <div className="date-input-weekdays">
            {WEEKDAY_HEADERS.map((w) => <span key={w}>{w}</span>)}
          </div>
          <div className="date-input-grid">
            {cells.map((day, i) => {
              if (day === null) return <span key={`b${i}`} />;
              const iso = `${viewYear}-${pad2(viewMonth)}-${pad2(day)}`;
              const disabled = (!!min && iso < min) || (!!max && iso > max);
              const isSelected = iso === value;
              const isToday = iso === today;
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={disabled}
                  className={`date-input-day${isSelected ? ' selected' : ''}${isToday && !isSelected ? ' today' : ''}`}
                  onClick={() => pick(day)}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
