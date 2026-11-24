import { SearchField } from '../shared/components/arc/search-field/search-field';
import { OPERATIONAL_OBJECTS } from './operational-objects';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  IconSearch, IconClock, IconChartPie, IconUsers, IconBuildingSkyscraper, IconChecklist,
  IconCalendarMonth, IconCash, IconMapPin, IconHistory, IconSettings,
  IconUserPlus, IconUserStar, IconPlus, IconTimelineEvent,
  IconFileImport, IconFileExport, IconTrash, IconUser, IconShieldLock, IconX, IconSparkles,
} from '@tabler/icons-react';
import { askAiShortcutLabel } from '../features/ai/aiShortcut';
import RightSidePanel from '../shared/components/RightSidePanel';
import { EmptyState } from '../shared/components/LoadingState';

type Command = {
  id: string;
  label: string;
  section: string;
  Icon: any;
  hint?: string;
  run: () => void;
};

export default function CommandPalette({ open, onClose, onOpenSearch, onOpenTimeline, onAskAi }: {
  open: boolean;
  onClose: () => void;
  onOpenSearch: (query?: string) => void;
  onOpenTimeline: () => void;
  /** U2: present only for a user the server confirms as AI-eligible (no Ask AI command otherwise). */
  onAskAi?: () => void;
}) {
  const nav = useNavigate();
  const { pathname } = useLocation();
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
    // Ask AI (U2): only when the server confirmed AI eligibility (the shell passes onAskAi then).
    ...(onAskAi ? [{ id: 'ask-ai', label: 'Ask AI', section: 'Navigation', Icon: IconSparkles, hint: askAiShortcutLabel(), run: () => { onClose(); onAskAi(); } }] : []),
    // Navigation
    { id: 'nav-up-next', label: 'Go to Up next', section: 'Navigation', Icon: IconClock, run: () => go('/up-next') },
    ...Object.entries(OPERATIONAL_OBJECTS).map(([id, object]) => ({ id: 'nav-' + id, label: 'Go to ' + object.label, section: 'Operational views', Icon: IconChecklist, run: () => go(object.to) })),
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
  ], [onClose, onOpenSearch, onOpenTimeline, onAskAi]);

  const contextualCommands = useMemo<Command[]>(() => {
    const contexts: Record<string, { label: string; ids: string[] }> = {
      '/': { label: 'Dashboard', ids: ['nav-up-next', 'nav-calendar', 'nav-offers', 'nav-payroll'] },
      '/up-next': { label: 'Up next', ids: ['nav-open-shifts', 'nav-awaiting-confirmation', 'nav-calendar'] },
      '/users': { label: 'Users', ids: ['new-user', 'search-users'] },
      '/shifts': { label: 'Shifts', ids: ['new-shift', 'search-shifts', 'nav-calendar'] },
      '/venues': { label: 'Venues', ids: ['new-venue', 'search-venues'] },
      '/offers': { label: 'Offers', ids: ['search-offers', 'nav-shifts'] },
      '/calendar': { label: 'Calendar', ids: ['new-calendar', 'nav-shifts'] },
      '/payroll': { label: 'Payroll', ids: ['nav-shifts', 'view-timeline'] },
    };
    const objectView = Object.values(OPERATIONAL_OBJECTS).some(object => object.to === pathname);
    const context = contexts[pathname] ?? (objectView ? contexts['/' + pathname.split('/')[1]] : undefined);
    if (!context) return commands;
    const selected = context.ids.flatMap(id => {
      const command = commands.find(item => item.id === id);
      return command ? [{ ...command, section: 'Current page · ' + context.label }] : [];
    });
    return [...selected, ...commands.filter(command => !context.ids.includes(command.id))];
  }, [commands, pathname]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return q ? contextualCommands.filter(c => c.label.toLowerCase().includes(q)) : contextualCommands;
  }, [contextualCommands, query]);

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
        <div className="side-panel-input command-search-input">
          <button className="btn-icon" onClick={onClose} title="Close"><IconX size={15}/></button>
          <SearchField label="Search commands" type="text"
            aria-label="Search commands" placeholder="Type anything…"
            value={query}
            onChange={e => { setQuery(e.target.value); setActive(0); }}
            autoFocus
          />
          <span className="command-hint">esc</span>
        </div>
        <div className="side-panel-body contextual-command-body" ref={listRef}>
          {filtered.length === 0 ? (
            <EmptyState compact variant="matches" title="No commands found" description="Try another search term." />
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
