import { SearchField } from '../shared/components/arc/search-field/search-field';
import { useRef, useState, useMemo, useEffect, type KeyboardEvent } from 'react';
import { IconBox, IconCheck } from '@tabler/icons-react';
import Popover from '../shared/components/Popover';
import { SIDEBAR_ICONS, matchSidebarIcons, type SidebarIcon } from './sidebar-icons';
export { SIDEBAR_ICONS } from './sidebar-icons';

const COLORS = [['Red','#e5484d'],['Ruby','#e54666'],['Crimson','#e93d82'],['Tomato','#e54d2e'],['Orange','#f76b15'],['Amber','#d69e00'],['Yellow','#b89700'],['Lime','#6a9a18'],['Green','#30a46c'],['Jade','#29a383'],['Teal','#12a594'],['Cyan','#00a2c7'],['Blue','#3e63dd'],['Violet','#6e56cf'],['Purple','#8e4ec6'],['Pink','#d6409f'],['Bronze','#a18072'],['Gold','#978365'],['Brown','#ad7f58'],['Gray','#8d8d8d']];

type Props = {
  label: string;
  icon?: SidebarIcon;
  color?: string;
  displayIcon?: typeof IconBox;
  onChange: (icon: SidebarIcon | undefined, color?: string) => void;
};

export default function SidebarIconPicker({ label, icon, color, displayIcon, onChange }: Props) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [sentinel, setSentinel] = useState<HTMLSpanElement | null>(null);
  const colorAnchor = useRef<HTMLButtonElement>(null);
  const colorPanel = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(25);
  const grid = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [colors, setColors] = useState(false);
  const [query, setQuery] = useState('');
  const [colorQuery, setColorQuery] = useState('');
  const I = displayIcon && !icon ? displayIcon : SIDEBAR_ICONS[icon ?? 'object'];
  const matchingIcons = useMemo(() => matchSidebarIcons(query, icon), [query, icon]);
  useEffect(() => {
    if (!open || !sentinel || !grid.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisibleCount(Math.min(visibleCount + 25, matchingIcons.length));
    }, { root: grid.current, rootMargin: '10px', threshold: 1 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [open, sentinel, visibleCount, matchingIcons.length]);
  const matchingColors = COLORS.filter(([name]) => name.toLowerCase().includes(colorQuery.trim().toLowerCase()));
  const closeColors = () => { setColors(false); colorAnchor.current?.focus(); };
  const close = () => { setOpen(false); setColors(false); };
  // Arrow keys complement normal Tab navigation in the compact six-column grid/list.
  const moveFocus = (event: KeyboardEvent<HTMLElement>, columns: number) => {
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
    const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (delta ?? 0)));
    event.preventDefault(); buttons[next]?.focus();
  };
  return <>
    <button ref={anchor} type="button" className="sidebar-icon-trigger" aria-label={`Change icon for ${label}`} aria-expanded={open}
      onClick={() => { setOpen(!open); setColors(false); setVisibleCount(25); setQuery(''); setColorQuery(''); }} style={{ color }}>
      <I size={16} stroke={1.6} />
    </button>
    <Popover open={open} onClose={close} anchorRef={anchor} minWidth={220} className="sidebar-icon-popover"
      dismissExclusionRef={colorPanel} onEscape={() => {
        if (colors) { closeColors(); return true; }
        anchor.current?.focus(); return false;
      }}>
      <div className="sidebar-icon-search">
        <SearchField label="Search icons" type="text" autoFocus aria-label="Search icons" placeholder="Search icons…" value={query} onChange={e => { setQuery(e.target.value); setVisibleCount(25); if (grid.current) grid.current.scrollTop = 0; }} />
        <button ref={colorAnchor} type="button" aria-label="Choose icon color" aria-expanded={colors} onClick={() => { setColors(!colors); setColorQuery(''); }}>
          <span className="sidebar-color-swatch" style={{ color: color ?? '#8d8d8d' }} />
        </button>
      </div>
      <div ref={grid} onScroll={e => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 10) setVisibleCount(Math.min(visibleCount + 25, matchingIcons.length)); }} className="sidebar-icon-grid" role="group" aria-label="Icons" style={{ color }} onKeyDown={e => moveFocus(e, 6)}>
        {matchingIcons.slice(0, visibleCount).map(name => {
          const Icon = SIDEBAR_ICONS[name];
          return <button type="button" key={name} aria-label={name} title={name.replaceAll('-', ' ')} aria-pressed={icon === name}
            onClick={() => { onChange(name, color); close(); anchor.current?.focus(); }}><Icon size={18} stroke={1.6} /></button>;
        })}
        {visibleCount < matchingIcons.length && <span ref={setSentinel} className="sidebar-icon-more" aria-hidden="true">Scroll for more</span>}
      </div>
      {!matchingIcons.length && <p className="sidebar-picker-empty" role="status">No icons found</p>}
      <Popover open={open && colors} onClose={() => setColors(false)} anchorRef={colorAnchor} placement="right" minWidth={220} className="sidebar-color-popover"
        onEscape={() => { closeColors(); return true; }}>
        <div ref={colorPanel}>
          <div className="sidebar-icon-search">
            <SearchField label="Search colors" type="text" autoFocus aria-label="Search colors" placeholder="Search colors…" value={colorQuery} onChange={e => setColorQuery(e.target.value)} />
          </div>
          <div className="sidebar-color-list" role="listbox" aria-label="Icon color" onKeyDown={e => moveFocus(e, 1)}>
            {matchingColors.map(([name, value]) => <button type="button" role="option" aria-selected={color === value} key={name}
              onClick={() => { onChange(icon, value); closeColors(); }}>
              <span className="sidebar-color-swatch" style={{ color: value }} />{name}{color === value && <IconCheck size={14} />}
            </button>)}
          </div>
          {!matchingColors.length && <p className="sidebar-picker-empty" role="status">No colors found</p>}
        </div>
      </Popover>
    </Popover>
  </>;
}
