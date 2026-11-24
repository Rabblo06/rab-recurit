import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar } from './arc/calendar/calendar';
import './date-input.css';

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
  value, onChange, min, max, placeholder = 'DD/MM/YYYY', autoFormat = false, ariaLabel,
}: {
  /** ISO `YYYY-MM-DD`, or `''` for empty. */
  value: string;
  onChange: (next: string) => void;
  /** ISO `YYYY-MM-DD` bounds, inclusive. */
  min?: string;
  max?: string;
  placeholder?: string;
  autoFormat?: boolean;
  ariaLabel?: string;
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
  const focusCalendar = useRef(false);
  useEffect(() => {
    if (!open || !coords || !focusCalendar.current) return;
    const day = popoverRef.current?.querySelector<HTMLButtonElement>('[data-present] [data-date][tabindex="0"]');
    if (day) { focusCalendar.current = false; day.focus(); }
  }, [open, coords]);

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
    const estimatedHeight = popoverRef.current?.offsetHeight ?? 340;
    const estimatedWidth = popoverRef.current?.offsetWidth ?? 328;
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

  const localDate = (iso?: string) => iso ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) : undefined;
  const pick = (date: Date) => {
    const iso = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    setText(isoToDisplay(iso)); setError(''); onChange(iso);
    inputRef.current?.focus(); setOpen(false);
  };

  const firstYear = Math.min(viewYear, min ? Number(min.slice(0, 4)) : 1900);
  const lastYear = Math.max(viewYear, max ? Number(max.slice(0, 4)) : Number(today.slice(0, 4)) + 100);
  const years = Array.from({length: lastYear - firstYear + 1}, (_, i) => firstYear + i);
  return (
    <div className="date-input" ref={containerRef}>
      <input
        aria-label={ariaLabel}
        ref={inputRef}
        type="text"
        inputMode={autoFormat ? 'numeric' : undefined}
        value={text}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          const raw = e.target.value;
          if (!autoFormat) { setText(raw); setError(''); return; }
          const digits = raw.replace(/\D/g, '').slice(0, 8);
          // Insert separators only when there is a following digit, so Backspace stays predictable.
          const formatted = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/');
          const caret = e.target.selectionStart ?? raw.length;
          const before = raw.slice(0, caret).replace(/\D/g, '').length;
          const position = Math.min(formatted.length, before + (before > 2 ? 1 : 0) + (before > 4 ? 1 : 0));
          setText(formatted); setError('');
          requestAnimationFrame(() => { if (document.activeElement === inputRef.current) inputRef.current?.setSelectionRange(position, position); });
        }}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          // Only swallow Escape while our own popover is open (closing it
          // first) — otherwise let it bubble, so a caller that wraps this
          // in its own editable-row (Staff Detail) can use a second Escape
          // to cancel that row's edit mode without this component eating it.
          if (e.key === 'Escape') { if (open) { e.stopPropagation(); setOpen(false); } }
          if (e.key === 'ArrowDown') { e.preventDefault(); focusCalendar.current = true; setOpen(true); updatePosition(); }
          if (e.key === 'Enter') { commit(text); setOpen(false); }
        }}
      />
      {error && <span className="date-input-error">{error}</span>}
      {open && coords && createPortal(
        <div
          className="date-input-popover arc-date-popover"
          role="dialog" aria-label="Choose date"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); inputRef.current?.focus(); setOpen(false); } }}
          ref={popoverRef}
          data-rab-portal="true"
          style={{ position: 'fixed', top: coords.top, left: coords.left, width: 328, maxWidth: 'calc(100vw - 16px)' }}
        >
          <div className="date-input-popover-header">
            <select aria-label="Month" value={viewMonth} onChange={event => setViewMonth(Number(event.target.value))}>{Array.from({length: 12}, (_, i) => <option key={i} value={i + 1}>{new Date(2000, i, 1).toLocaleString('en-GB', {month: 'long'})}</option>)}</select>
            <select aria-label="Year" value={viewYear} onChange={event => setViewYear(Number(event.target.value))}>{years.map(year => <option key={year} value={year}>{year}</option>)}</select>
          </div>
          <Calendar value={localDate(value)} onChange={pick}
            month={new Date(viewYear, viewMonth - 1, 1)}
            onMonthChange={(date) => { setViewYear(date.getFullYear()); setViewMonth(date.getMonth() + 1); }}
            minDate={localDate(min)} maxDate={localDate(max)} locale="en-GB" showToday />
          <button type="button" className="date-picker-clear" onClick={() => { setText(''); setError(''); onChange(''); inputRef.current?.focus(); setOpen(false); }}>Clear</button>

        </div>,
        document.body,
      )}
    </div>
  );
}
