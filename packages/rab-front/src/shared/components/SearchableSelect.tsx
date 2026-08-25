import { useEffect, useMemo, useRef, useState } from 'react';
import { IconCheck, IconChevronDown, IconSearch, IconX } from '@tabler/icons-react';

export interface SearchableOption {
  id: string;
  label: string;
  sublabel?: string;
}

const LINK_BTN_STYLE: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, font: 'inherit', fontSize: 12, fontWeight: 600,
  color: 'var(--color-blue)', cursor: 'pointer',
};

/**
 * The one searchable combobox in this app (nothing like it existed before —
 * confirmed no `role="combobox"`/`aria-expanded` anywhere in rab-front).
 * Reuses this app's own idioms rather than inventing new ones: `.dropdown-menu`/
 * `.dropdown-item` (AdminDropdown/NotificationBell's popover styling),
 * `.side-panel-input` (the search-box styling already used inside drawers),
 * and the ArrowDown/ArrowUp/Enter/Escape "active index" keyboard pattern
 * GlobalSearch/CommandPalette already use.
 *
 * `mode="single"` (Venue, Role): a closed trigger button that opens a
 * floating popover on click — positioned `fixed` off the trigger's own
 * bounding rect (not `absolute`) so it isn't clipped by the drawer body's
 * own scroll container.
 *
 * `mode="multi"` (Staff members): no trigger/popover — renders inline,
 * search box always visible above a scrollable checkbox list, plus a
 * selected-count header with Select All / Clear All.
 */
export function SearchableSelect({
  options,
  placeholder = 'Search…',
  emptyLabel = 'No results.',
  mode = 'single',
  value,
  onChange,
  values,
  onToggle,
  onSelectAll,
  onClearAll,
  disabled,
}: {
  options: SearchableOption[];
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
} & (
  | { mode?: 'single'; value: string; onChange: (id: string) => void; values?: never; onToggle?: never; onSelectAll?: never; onClearAll?: never }
  | { mode: 'multi'; values: Set<string>; onToggle: (id: string) => void; onSelectAll: () => void; onClearAll: () => void; value?: never; onChange?: never }
)) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.sublabel?.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => setActiveIndex(0), [query, open]);

  useEffect(() => {
    if (mode !== 'single' || !open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.max(rect.width, 260);
      // The drawer this almost always lives in is flush against the
      // viewport's right edge, so a right-column field's popover would
      // otherwise overflow off-screen — clamp so its right edge never
      // passes the viewport's right edge (minus a small margin), and its
      // left edge never goes negative either.
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      setPos({ top: rect.bottom + 4, left, width });
    }
    inputRef.current?.focus();
  }, [open, mode]);

  const selectedOption = mode === 'single' ? options.find((o) => o.id === value) : undefined;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[activeIndex];
      if (!opt) return;
      if (mode === 'single') { onChange!(opt.id); setOpen(false); setQuery(''); }
      else onToggle!(opt.id);
    } else if (e.key === 'Escape') {
      if (mode === 'single') { e.preventDefault(); setOpen(false); }
    }
  };

  const list = (
    <div style={{ maxHeight: 260, overflowY: 'auto', padding: mode === 'single' ? 4 : 0 }}>
      {filtered.length === 0 && <p className="muted" style={{ padding: 12, fontSize: 13 }}>{emptyLabel}</p>}
      {filtered.map((o, i) => {
        const isSelected = mode === 'single' ? o.id === value : values!.has(o.id);
        return (
          <button
            key={o.id}
            type="button"
            className={`dropdown-item${i === activeIndex ? ' active' : ''}`}
            style={mode === 'multi' ? { padding: '8px 12px', borderBottom: '1px solid var(--border-light)', borderRadius: 0, width: '100%' } : undefined}
            onMouseEnter={() => setActiveIndex(i)}
            onClick={() => (mode === 'single' ? (onChange!(o.id), setOpen(false), setQuery('')) : onToggle!(o.id))}
          >
            {mode === 'multi' && (
              <span
                style={{
                  width: 16, height: 16, borderRadius: 4, border: `1px solid ${isSelected ? 'var(--color-blue)' : 'var(--border-medium)'}`,
                  background: isSelected ? 'var(--color-blue)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}
              >
                {isSelected && <IconCheck size={11} color="#fff" />}
              </span>
            )}
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
              {o.sublabel && <span style={{ fontSize: 11, color: 'var(--font-tertiary)' }}>{o.sublabel}</span>}
            </span>
            {mode === 'single' && isSelected && <IconCheck size={14} style={{ marginLeft: 'auto' }} />}
          </button>
        );
      })}
    </div>
  );

  if (mode === 'multi') {
    return (
      <div>
        <div className="side-panel-input" style={{ border: '1px solid var(--border-medium)', borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0', borderBottom: 'none' }}>
          <IconSearch size={14} style={{ color: 'var(--font-tertiary)', flexShrink: 0 }} />
          <input
            placeholder={placeholder}
            value={query}
            disabled={disabled}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', fontSize: 12, borderLeft: '1px solid var(--border-medium)', borderRight: '1px solid var(--border-medium)', background: 'var(--bg-transparent-light)' }}>
          <span style={{ fontWeight: 600, color: 'var(--font-secondary)' }}>{values!.size} staff selected</span>
          <span>
            <button type="button" onClick={onSelectAll} style={LINK_BTN_STYLE}>Select all</button>
            <button type="button" onClick={onClearAll} style={{ ...LINK_BTN_STYLE, marginLeft: 10 }}>Clear all</button>
          </span>
        </div>
        <div style={{ border: '1px solid var(--border-medium)', borderRadius: '0 0 var(--radius-sm) var(--radius-sm)' }}>{list}</div>
      </div>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', height: 32, padding: '0 8px 0 10px', display: 'flex', alignItems: 'center', gap: 6,
          background: 'var(--bg-primary)', border: '1px solid var(--border-medium)', borderRadius: 'var(--radius-sm)',
          fontSize: 13, fontFamily: 'inherit', color: selectedOption ? 'var(--font-primary)' : 'var(--font-light)', cursor: disabled ? 'default' : 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        {selectedOption && !disabled && (
          <span
            role="button"
            aria-label="Clear"
            onClick={(e) => { e.stopPropagation(); onChange!(''); }}
            style={{ display: 'flex', color: 'var(--font-tertiary)' }}
          >
            <IconX size={13} />
          </span>
        )}
        <IconChevronDown size={13} style={{ color: 'var(--font-tertiary)', flexShrink: 0 }} />
      </button>

      {open && pos && (
        <>
          <div className="dropdown-overlay" onClick={() => setOpen(false)} />
          <div className="dropdown-menu" style={{ top: pos.top, left: pos.left, width: pos.width }}>
            <div className="side-panel-input" style={{ borderBottom: '1px solid var(--border-light)', padding: '6px 8px' }}>
              <IconSearch size={13} style={{ color: 'var(--font-tertiary)', flexShrink: 0 }} />
              <input ref={inputRef} placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={handleKeyDown} />
            </div>
            {list}
          </div>
        </>
      )}
    </>
  );
}
