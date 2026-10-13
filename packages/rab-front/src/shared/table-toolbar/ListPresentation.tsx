import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconTable } from '@tabler/icons-react';
import Popover from '../components/Popover';
import './list-view-select.css';

/** A compact view selector, using the same server-filter state as the full filter popover. */
export function ListViewSelect({ label, value, options, onChange }: {
  label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const typeahead = useRef({ text: '', at: 0 });
  const id = useId();
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const active = Math.min(activeIndex, options.length - 1);
  const reveal = (index = selectedIndex) => { setActiveIndex(index); setOpen(true); typeahead.current.text = ''; };
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const choose = (index: number) => {
    const option = options[index];
    if (option && option.value !== value) onChange(option.value);
    close();
  };
  useEffect(() => { if (open) optionRefs.current[active]?.scrollIntoView?.({ block: 'nearest' }); }, [open, active]);

  return <div className="list-view-selector">
    <button ref={trigger} type="button" className="list-view-trigger" role="combobox" aria-label={label}
      value={value} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined} disabled={!options.length}
      onClick={() => open ? close() : reveal()}
      onKeyDown={event => {
        if (event.key === 'Tab') { setOpen(false); return; }
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) reveal();
          else setActiveIndex((active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault(); reveal(event.key === 'Home' ? 0 : options.length - 1);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); if (open) choose(active); else reveal();
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          const now = Date.now();
          const text = (now - typeahead.current.at < 700 ? typeahead.current.text : '') + event.key.toLocaleLowerCase();
          typeahead.current = { text, at: now };
          const index = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(text));
          if (index >= 0) { setActiveIndex(index); setOpen(true); }
        }
      }}>
      <IconTable size={15} aria-hidden="true"/><span>{options[selectedIndex]?.label ?? label}</span><IconChevronDown size={12} aria-hidden="true"/>
    </button>
    <Popover open={open} onClose={close} anchorRef={trigger} minWidth={224} className="list-view-popover" role="presentation" animated>
      <div id={id} role="listbox" aria-label={label} className="list-view-options">
        {options.map((option, index) => <button key={option.value} ref={node => { optionRefs.current[index] = node; }}
          id={`${id}-${index}`} type="button" role="option" tabIndex={-1} aria-selected={value === option.value}
          className={`list-view-option${active === index ? ' is-active' : ''}`}
          onMouseEnter={() => setActiveIndex(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
          <IconTable size={15} aria-hidden="true"/><span>{option.label}</span>{value === option.value && <IconCheck size={13} aria-hidden="true"/>}
        </button>)}
      </div>
    </Popover>
  </div>;
}

/** Only counts returned by the API; the 500-row page size is the existing server default. */
export function RecordFooter({ total, page = 1, onPage, loaded, children }: {
  total: number; page?: number; onPage?: (page: number) => void; loaded?: number; children?: ReactNode;
}) {
  const [countVisible, setCountVisible] = useState(false);
  const pages = Math.max(1, Math.ceil(total / 500));
  return <div className="list-footer">
    <span>{total.toLocaleString()} record{total === 1 ? '' : 's'}</span>
    {onPage && pages > 1 && <div className="record-pagination">
      <button className="btn-icon" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}><IconChevronLeft size={14} /></button>
      <span>Page {page} of {pages}</span>
      <button className="btn-icon" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}><IconChevronRight size={14} /></button>
    </div>}
    <div className="record-calculation">{children}
      {countVisible && <span role="status">{loaded === undefined ? 'Count all' : 'Count on page'} <strong>{loaded ?? total}</strong></span>}
      <button onClick={() => setCountVisible(value => !value)} aria-expanded={countVisible}>Calculate <IconChevronDown size={12} /></button>
    </div>
  </div>;
}

export function ListError({ retry }: { retry: () => unknown }) {
  return <div className="list-error" role="alert"><p>We couldn’t load these records.</p><p>Your data has not been changed.</p><button className="btn btn-outline" onClick={() => retry()}>Retry</button></div>;
}
