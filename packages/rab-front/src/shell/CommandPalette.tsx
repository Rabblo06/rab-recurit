import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IconSearch, IconChartPie, IconUsers, IconBuildingSkyscraper, IconChecklist,
  IconCalendarMonth, IconCash, IconMapPin, IconHistory, IconSettings,
  IconUserPlus, IconUserStar, IconPlus, IconTimelineEvent,
  IconFileImport, IconFileExport, IconTrash, IconUser, IconShieldLock, IconX,
} from '@tabler/icons-react';
import RightSidePanel from '../shared/components/RightSidePanel';

type Command = {
  id: string;
  label: string;
  section: string;
  Icon: any;
  hint?: string;
  run: () => void;
};

export default function CommandPalette({ open, onClose, onOpenSearch, onOpenTimeline }: {
  open: boolean;
  onClose: () => void;
  onOpenSearch: (query?: string) => void;
  onOpenTimeline: () => void;
}) {
  const nav = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) { setQuery(''); setActive(0); }
  }, [open]);

  const go = (to: string) => { onClose(); nav(to); };
  // Navigate to the page, then open its create modal once the route has rendered.
  const create = (to: string, event: string, detail?: any) => {
    onClose();
    nav(to);
    setTimeout(() => document.dispatchEvent(new CustomEvent(event, { detail })), 350);
  };

  const commands = useMemo<Command[]>(() => [
    // Navigation
    { id: 'nav-dashboard',  label: 'Go to Dashboard',  section: 'Navigation', Icon: IconChartPie,            run: () => go('/') },
    { id: 'nav-users',      label: 'Go to Users',       section: 'Navigation', Icon: IconUsers,               run: () => go('/users') },
    { id: 'nav-shifts',     label: 'Go to Shifts',      section: 'Navigation', Icon: IconBuildingSkyscraper,  run: () => go('/shifts') },
    { id: 'nav-offers',     label: 'Go to Offers',      section: 'Navigation', Icon: IconChecklist,           run: () => go('/offers') },
    { id: 'nav-calendar',   label: 'Go to Calendar',    section: 'Navigation', Icon: IconCalendarMonth,       run: () => go('/calendar') },
    { id: 'nav-payroll',    label: 'Go to Payroll',     section: 'Navigation', Icon: IconCash,                run: () => go('/payroll') },
    { id: 'nav-venues',     label: 'Go to Venues',      section: 'Navigation', Icon: IconMapPin,              run: () => go('/venues') },
    { id: 'nav-audit',      label: 'Go to Audit Log',   section: 'Navigation', Icon: IconHistory,             run: () => go('/audit') },
    { id: 'nav-settings',   label: 'Go to Settings',    section: 'Navigation', Icon: IconSettings,            run: () => go('/settings') },
    // Create
    { id: 'new-manager',       label: 'New Manager',        section: 'Create', Icon: IconUserStar,
      run: () => { onClose(); document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role: 'manager', title: 'Create manager' } })); } },
    { id: 'new-hotel-manager', label: 'New Hotel Manager',  section: 'Create', Icon: IconBuildingSkyscraper,
      run: () => { onClose(); document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role: 'manager', title: 'Create hotel manager' } })); } },
    { id: 'new-user',          label: 'New User',           section: 'Create', Icon: IconUserPlus,
      run: () => { onClose(); document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role: 'staff', title: 'Create user' } })); } },
    { id: 'new-shift',         label: 'New Shift',          section: 'Create', Icon: IconPlus,
      run: () => create('/shifts', 'open-create-placement') },
    { id: 'new-venue',         label: 'New Venue',          section: 'Create', Icon: IconMapPin,
      run: () => create('/venues', 'open-create-venue') },
    // Payroll records are computed from completed shifts; calendar events come from shifts.
    { id: 'new-payroll',       label: 'New Payroll Record', section: 'Create', Icon: IconCash,
      run: () => go('/payroll') },
    { id: 'new-calendar',      label: 'New Calendar Event', section: 'Create', Icon: IconCalendarMonth,
      run: () => create('/shifts', 'open-create-placement') },
    // Search
    { id: 'search-users',      label: 'Search Users',      section: 'Search', Icon: IconSearch, hint: '/', run: () => { onClose(); onOpenSearch(); } },
    { id: 'search-shifts',     label: 'Search Shifts',     section: 'Search', Icon: IconSearch, hint: '/', run: () => { onClose(); onOpenSearch(); } },
    { id: 'search-offers',     label: 'Search Offers',     section: 'Search', Icon: IconSearch, hint: '/', run: () => { onClose(); onOpenSearch(); } },
    { id: 'search-venues',     label: 'Search Venues',     section: 'Search', Icon: IconSearch, hint: '/', run: () => { onClose(); onOpenSearch(); } },
    // Admin / system
    { id: 'view-timeline', label: 'View Timeline Activities', section: 'Admin', Icon: IconTimelineEvent, run: () => { onClose(); onOpenTimeline(); } },
    { id: 'view-audit',    label: 'View Audit Log',           section: 'Admin', Icon: IconHistory,        run: () => go('/audit') },
    // TODO: implement real import/export and a deleted-records view when backend support lands.
    { id: 'import',        label: 'Import Data',              section: 'Admin', Icon: IconFileImport,     run: () => go('/settings') },
    { id: 'export',        label: 'Export View',              section: 'Admin', Icon: IconFileExport,     run: () => go('/settings') },
    { id: 'deleted',       label: 'See Deleted Records',      section: 'Admin', Icon: IconTrash,          run: () => go('/users') },
    { id: 'set-account',   label: 'Go to Account Settings',   section: 'Admin', Icon: IconUser,           run: () => go('/settings#account') },
    { id: 'set-general',   label: 'Go to General Settings',   section: 'Admin', Icon: IconSettings,       run: () => go('/settings#general') },
    { id: 'set-roles',     label: 'Go to Role/Permission Settings', section: 'Admin', Icon: IconShieldLock, run: () => go('/settings#roles') },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [onClose, onOpenSearch, onOpenTimeline]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return q ? commands.filter(c => c.label.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  // Group preserving order
  const sections = useMemo(() => {
    const out: { name: string; items: { cmd: Command; index: number }[] }[] = [];
    filtered.forEach((cmd, index) => {
      let s = out.find(x => x.name === cmd.section);
      if (!s) { s = { name: cmd.section, items: [] }; out.push(s); }
      s.items.push({ cmd, index });
    });
    return out;
  }, [filtered]);

  useEffect(() => {
    const el = listRef.current?.querySelector('.command-item.active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <RightSidePanel open={open} onClose={onClose}>
      <div
        style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, filtered.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          if (e.key === 'Enter' && filtered[active]) filtered[active].run();
        }}
      >
        <div className="side-panel-input">
          <button className="btn-icon" onClick={onClose} title="Close"><IconX size={15}/></button>
          <input
            placeholder="Type anything…"
            value={query}
            onChange={e => { setQuery(e.target.value); setActive(0); }}
            autoFocus
          />
          <span className="command-hint">esc</span>
        </div>
        <div className="side-panel-body" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="search-empty">No results found</div>
          ) : (
            sections.map(s => (
              <div key={s.name}>
                <div className="command-section">{s.name}</div>
                {s.items.map(({ cmd, index }) => (
                  <button
                    key={cmd.id}
                    className={`command-item${index === active ? ' active' : ''}`}
                    onClick={cmd.run}
                    onMouseEnter={() => setActive(index)}
                  >
                    <cmd.Icon size={15} stroke={1.8}/>
                    {cmd.label}
                    {cmd.hint
                      ? <span className="command-hint">{cmd.hint}</span>
                      : index === active && <span className="command-hint">↵</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </RightSidePanel>
  );
}
