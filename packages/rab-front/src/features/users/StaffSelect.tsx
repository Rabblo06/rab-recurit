import { SearchField } from '../../shared/components/arc/search-field/search-field';
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { IconChevronDown, IconSearch } from '@tabler/icons-react';
import Popover from '../../shared/components/Popover';
import './staff-select.css';
type Option = { value: string; label: string; icon?: ReactNode };
export default function StaffSelect({ id, value, onChange, options, placeholder, label, compact = false, disabled = false, defaultOpen = false, searchable = true, emptyMessage = 'No matches found.' }: {
  id?: string; value: string; onChange: (value: string) => void; options: Option[]; placeholder: string; label: string; compact?: boolean; disabled?: boolean; defaultOpen?: boolean; searchable?: boolean; emptyMessage?: string;
}) {
  const listId = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const list = useCallback((node: HTMLDivElement | null) => { if (node && !searchable) node.focus(); }, [searchable]);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(() => Math.max(0, options.findIndex(option => option.value === value)));
  const filtered = options.filter(option => option.label.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = options.find(option => option.value === value);
  const choose = (option: Option) => { if (disabled) return; onChange(option.value); setOpen(false); anchor.current?.focus(); };
  const show = () => { setSearch(''); setActive(Math.max(0, options.findIndex(option => option.value === value))); setOpen(true); };
  return <>
    <button disabled={disabled} id={id} ref={anchor} type="button" className="staff-select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      onClick={() => open ? setOpen(false) : show()}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); } }}>
      <span className="staff-select-value">{selected?.icon}<span className={!value ? 'staff-select-placeholder' : undefined}>{selected?.label || placeholder}</span></span><IconChevronDown size={14} aria-hidden="true" />
    </button>
    <Popover open={open} onClose={() => setOpen(false)} onEscape={() => { setOpen(false); anchor.current?.focus(); return true; }} anchorRef={anchor} minWidth={compact ? 200 : 280} className={`staff-select-card${compact ? ' is-compact' : ''}`} role="presentation">
      {searchable && <div className="staff-select-search"><SearchField label={'Search ' + label.toLowerCase()} type="text" autoFocus placeholder="Search…" aria-label={'Search ' + label.toLowerCase()} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
          aria-activedescendant={filtered[active] ? listId + '-' + active : undefined}
          value={search} onChange={event => { setSearch(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const next = Math.max(0, Math.min(filtered.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
              setActive(next); document.getElementById(listId + '-' + next)?.scrollIntoView({ block: 'nearest' });
            }
            if (event.key === 'Enter') { event.preventDefault(); if (filtered[active]) choose(filtered[active]); }
            if (event.key === 'Tab') setOpen(false);
          }} />
      </div>}
      <div ref={list} tabIndex={searchable ? undefined : -1} aria-activedescendant={!searchable && filtered[active] ? listId + '-' + active : undefined}
        onKeyDown={event => {
          if (searchable) return;
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? filtered.length - 1 : Math.max(0, Math.min(filtered.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
            setActive(next); document.getElementById(listId + '-' + next)?.scrollIntoView({ block: 'nearest' });
          }
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (filtered[active]) choose(filtered[active]); }
          if (event.key === 'Tab') setOpen(false);
        }} role="listbox" id={listId} aria-label={label} className="staff-select-options">
        {filtered.map((option, index) => <button key={option.value} id={listId + '-' + index} type="button" disabled={disabled} role="option" tabIndex={-1} aria-selected={option.value === value}
          className={index === active ? 'is-active' : undefined} onMouseEnter={() => setActive(index)} onClick={() => choose(option)}>
          <span className="staff-select-value">{option.icon}<span>{option.label}</span></span>
        </button>)}
        {!filtered.length && <p className="staff-select-empty" role="status">{emptyMessage}</p>}
      </div>
    </Popover>
  </>;
}
