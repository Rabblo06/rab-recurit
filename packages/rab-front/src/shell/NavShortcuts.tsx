import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  IconBolt, IconBox, IconBuildingStore, IconCalendarEvent, IconChevronLeft, IconChevronRight, IconDots, IconExternalLink,
  IconFilter, IconFolder, IconLink, IconMail, IconPlus, IconSearch, IconStar, IconUser, IconX,
} from '@tabler/icons-react';
import { api } from '../shared/api';
import Popover from '../shared/components/Popover';
import { getUserId, subscribeToSession } from '../shared/lib/auth-session';
import { step as stepVariants, usePrefersReducedMotion } from '../shared/motion';
import {
  MAX_SHORTCUTS, OBJECTS, PICKABLE_ICONS, VIEWS, isDuplicate, parseShortcuts, storageKey, validateLink,
  type Shortcut, type ShortcutIcon, type ShortcutKind,
} from './nav-shortcuts';

const ICON: Record<ShortcutIcon, typeof IconBox> = {
  object: IconBox, view: IconFilter, person: IconUser, venue: IconBuildingStore, shift: IconCalendarEvent, offer: IconMail,
  folder: IconFolder, link: IconLink, star: IconStar, bolt: IconBolt,
};
const CATEGORIES: Array<{ kind: ShortcutKind; label: string; hint: string; icon: ShortcutIcon }> = [
  { kind: 'object', label: 'Object', hint: 'A Crewflow page', icon: 'object' },
  { kind: 'view', label: 'View', hint: 'A filtered list', icon: 'view' },
  { kind: 'record', label: 'Record', hint: 'A person, venue, shift or offer', icon: 'person' },
  { kind: 'folder', label: 'Folder', hint: 'Group your shortcuts', icon: 'folder' },
  { kind: 'link', label: 'Link', hint: 'A Crewflow path or https:// site', icon: 'link' },
];
const RECORD_ICON: Record<string, ShortcutIcon> = { Staff: 'person', Manager: 'person', Venue: 'venue', Shift: 'shift', Offer: 'offer' };

/** Device-local shortcuts for the signed-in user + workspace (see nav-shortcuts.ts). Re-reads on every identity change. */
export function useNavShortcuts(fallbackUserId: string | null, workspaceId: string | null | undefined) {
  const [sessionUser, setSessionUser] = useState(getUserId());
  useEffect(() => subscribeToSession(() => setSessionUser(getUserId())), []);
  const key = storageKey(sessionUser ?? fallbackUserId, workspaceId);
  const read = (k: string | null) => { if (!k) return []; try { return parseShortcuts(localStorage.getItem(k)); } catch { return []; } };
  const [items, setItems] = useState<Shortcut[]>(() => read(key));
  useEffect(() => setItems(read(key)), [key]);
  const save = (next: Shortcut[]) => {
    setItems(next);
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage unavailable: kept for this page only */ }
  };
  return {
    items,
    ready: !!key,
    add: (s: Omit<Shortcut, 'id'>) => save([...items, { ...s, id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}` }]),
    rename: (id: string, label: string) => save(items.map((s) => (s.id === id ? { ...s, label: label.slice(0, 60) } : s))),
    // Removing a folder removes the shortcuts inside it too — shortcuts only; no record, route or page is touched.
    remove: (id: string) => save(items.filter((s) => s.id !== id && s.parentId !== id)),
  };
}

type Draft = { kind: ShortcutKind; target?: string; label: string; icon: ShortcutIcon; external?: boolean };

/** The Operations "+" control and its "Add menu item" flow: category → choose/search → confirm name, icon, folder. */
export function AddMenuItem({ shortcuts, canSeeAudit, onAdd }: {
  shortcuts: Shortcut[];
  canSeeAudit: boolean;
  onAdd: (s: Omit<Shortcut, 'id'>) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const reduce = usePrefersReducedMotion();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'pick' | ShortcutKind | 'confirm'>('pick');
  const [dir, setDir] = useState(1);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [linkValue, setLinkValue] = useState('');
  const [error, setError] = useState('');
  const [parentId, setParentId] = useState<string>('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(query.trim()), 250); return () => clearTimeout(t); }, [query]);
  useEffect(() => { if (open) requestAnimationFrame(() => searchRef.current?.focus()); }, [open, step]);
  const go = (next: typeof step, d = 1) => { setDir(d); setStep(next); setQuery(''); setError(''); };
  const reset = () => { setOpen(false); setStep('pick'); setDraft(null); setQuery(''); setLinkValue(''); setError(''); setParentId(''); };

  // Record search is server-scoped (the same authorised /search the global search uses) — never a full download.
  const records = useQuery({
    queryKey: ['nav-shortcut-search', debounced],
    enabled: open && step === 'record' && debounced.length > 1,
    queryFn: async () => (await api.get<Array<{ id: string; name: string; type: string; group: string }>>('/search', { params: { q: debounced } })).data,
  });

  const folders = shortcuts.filter((s) => s.kind === 'folder');
  const full = shortcuts.length >= MAX_SHORTCUTS;
  const matches = (label: string) => label.toLowerCase().includes(query.trim().toLowerCase());
  const objects = Object.entries(OBJECTS).filter(([, o]) => (o.requires !== 'audit' || canSeeAudit) && matches(o.label));
  const views = Object.entries(VIEWS).filter(([, v]) => matches(v.label));
  const categories = CATEGORIES.filter((c) => matches(c.label));

  const choose = (d: Draft) => {
    if (d.kind !== 'folder' && isDuplicate(shortcuts, { kind: d.kind, target: d.target, label: d.label })) { setError('That is already in your sidebar.'); return; }
    setDraft(d); go('confirm');
  };
  const confirm = () => {
    if (!draft) return;
    const label = draft.label.trim();
    if (!label) { setError('Give it a name.'); return; }
    if (draft.kind === 'folder' && isDuplicate(shortcuts, { kind: 'folder', label })) { setError('You already have a folder with that name.'); return; }
    onAdd({ kind: draft.kind, target: draft.target, label, icon: draft.icon, parentId: draft.kind === 'folder' ? null : parentId || null });
    reset();
  };

  const row = (key: string, icon: ShortcutIcon, label: string, onClick: () => void, extra?: ReactNode) => {
    const I = ICON[icon];
    return (
      <button key={key} type="button" className="add-menu-row" onClick={onClick}>
        <I size={16} stroke={1.6} aria-hidden="true" /><span>{label}</span>{extra}
      </button>
    );
  };

  const body = () => {
    if (step === 'pick') {
      return categories.map((c) => row(c.kind, c.icon, c.label, () => {
        if (c.kind === 'folder') { setDraft({ kind: 'folder', label: '', icon: 'folder' }); go('confirm'); }
        else go(c.kind);
      }, c.kind === 'folder' ? <span className="add-menu-hint">{c.hint}</span> : <IconChevronRight size={14} className="add-menu-chevron" aria-hidden="true" />));
    }
    if (step === 'object') return objects.length ? objects.map(([key, o]) => row(key, o.icon, o.label, () => choose({ kind: 'object', target: key, label: o.label, icon: o.icon }))) : <p className="add-menu-empty">No matching pages.</p>;
    if (step === 'view') return views.length ? views.map(([key, v]) => row(key, 'view', v.label, () => choose({ kind: 'view', target: key, label: v.label, icon: 'view' }))) : <p className="add-menu-empty">No matching views.</p>;
    if (step === 'record') {
      if (debounced.length < 2) return <p className="add-menu-empty">Type at least two letters to search people, venues, shifts and offers you can access.</p>;
      if (records.isLoading) return <p className="add-menu-empty" role="status">Searching…</p>;
      if (records.isError) return <p className="add-menu-empty feedback-error" role="alert">Search failed. <button type="button" className="add-menu-retry" onClick={() => void records.refetch()}>Retry</button></p>;
      const list = (records.data ?? []).filter((r) => RECORD_ICON[r.type]);
      return list.length ? list.map((r) => row(`${r.type}:${r.id}`, RECORD_ICON[r.type]!, r.name, () => choose({ kind: 'record', target: `${r.type}:${r.id}`, label: r.name, icon: RECORD_ICON[r.type]! }), <span className="add-menu-hint">{r.type}</span>)) : <p className="add-menu-empty">No records match.</p>;
    }
    if (step === 'link') {
      return (
        <form className="add-menu-form" onSubmit={(e) => {
          e.preventDefault();
          const check = validateLink(linkValue);
          if (!check.ok) { setError(check.error); return; }
          const target = check.kind === 'internal' ? check.to : check.href;
          const label = check.kind === 'internal' ? check.to : new URL(check.href).hostname;
          choose({ kind: 'link', target, label, icon: 'link', external: check.kind === 'external' });
        }}>
          <label htmlFor="add-menu-link">Address</label>
          <input id="add-menu-link" ref={searchRef} value={linkValue} onChange={(e) => { setLinkValue(e.target.value); setError(''); }} placeholder="/shifts or https://…" autoComplete="off" spellCheck={false} />
          <button type="submit" className="btn btn-outline">Continue</button>
        </form>
      );
    }
    // confirm
    if (!draft) return null;
    const I = ICON[draft.icon];
    return (
      <form className="add-menu-form" onSubmit={(e) => { e.preventDefault(); confirm(); }}>
        <label htmlFor="add-menu-name">Name</label>
        <input id="add-menu-name" ref={searchRef} value={draft.label} maxLength={60} onChange={(e) => { setDraft({ ...draft, label: e.target.value }); setError(''); }} placeholder={draft.kind === 'folder' ? 'Folder name' : 'Shortcut name'} />
        {draft.kind !== 'folder' && (
          <>
            <span className="add-menu-label" id="add-menu-icon-label">Icon</span>
            <div className="add-menu-icons" role="radiogroup" aria-labelledby="add-menu-icon-label">
              {PICKABLE_ICONS.map((icon) => {
                const P = ICON[icon];
                return <button key={icon} type="button" role="radio" aria-checked={draft.icon === icon} aria-label={icon} className={draft.icon === icon ? 'selected' : ''} onClick={() => setDraft({ ...draft, icon })}><P size={15} stroke={1.6} /></button>;
              })}
            </div>
            <p className="add-menu-destination"><I size={14} stroke={1.6} aria-hidden="true" />{destinationLabel(draft)}</p>
            {folders.length > 0 && (
              <>
                <label htmlFor="add-menu-folder">Add to</label>
                <select id="add-menu-folder" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">Operations</option>
                  {folders.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </>
            )}
          </>
        )}
        <div className="add-menu-actions">
          <button type="button" className="btn btn-outline" onClick={reset}>Cancel</button>
          <button type="submit" className="btn btn-dark">Add</button>
        </div>
        <p className="add-menu-note">Saved on this device for your account and workspace.</p>
      </form>
    );
  };

  const title = step === 'pick' ? 'Add menu item' : step === 'confirm' ? (draft?.kind === 'folder' ? 'New folder' : 'Confirm shortcut') : CATEGORIES.find((c) => c.kind === step)?.label ?? '';
  const searchable = step === 'pick' || step === 'object' || step === 'view' || step === 'record';

  return (
    <>
      <button ref={anchor} type="button" className="sidebar-group-add" aria-label="Add menu item" title="Add menu item" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? reset() : setOpen(true))}>
        <IconPlus size={14} stroke={1.8} />
      </button>
      <Popover open={open} onClose={reset} anchorRef={anchor} align="start" minWidth={300} role="dialog" className="add-menu-popover">
        <div className="add-menu" aria-label="Add menu item">
          <div className="add-menu-head">
            {step !== 'pick' && <button type="button" className="btn-icon" aria-label="Back" onClick={() => go('pick', -1)}><IconChevronLeft size={15} /></button>}
            <h3>{title}</h3>
            <button type="button" className="btn-icon" aria-label="Close" onClick={reset}><IconX size={15} /></button>
          </div>
          {full ? <p className="add-menu-empty">You have {MAX_SHORTCUTS} shortcuts — remove one to add another.</p> : (
            <>
              {searchable && (
                <div className="add-menu-search">
                  <IconSearch size={14} aria-hidden="true" />
                  <input ref={searchRef} value={query} onChange={(e) => { setQuery(e.target.value); setError(''); }} placeholder="Search…" aria-label={`Search ${title}`} />
                </div>
              )}
              <AnimatePresence mode="wait" initial={false} custom={dir}>
                <motion.div key={step} className="add-menu-body" custom={dir} variants={reduce ? undefined : stepVariants} initial="enter" animate="center" exit="exit">
                  {body()}
                </motion.div>
              </AnimatePresence>
              {error && <p className="add-menu-error feedback-error" role="alert">{error}</p>}
            </>
          )}
        </div>
      </Popover>
    </>
  );
}

function destinationLabel(d: Draft): string {
  if (d.kind === 'object') return `Opens ${OBJECTS[d.target ?? '']?.to ?? ''}`;
  if (d.kind === 'view') return `Opens ${VIEWS[d.target ?? '']?.label ?? ''}`;
  if (d.kind === 'record') return `Opens this ${(d.target ?? '').split(':')[0]?.toLowerCase()}`;
  if (d.kind === 'link') return d.external ? `Opens ${d.target} in a new tab` : `Opens ${d.target}`;
  return '';
}

/** The user's shortcuts under Operations (folders expand/collapse). Opening one always goes through the normal route. */
export function ShortcutList({ items, canSeeAudit, isOrgAdmin, onRename, onRemove }: {
  items: Shortcut[];
  canSeeAudit: boolean;
  isOrgAdmin: boolean;
  onRename: (id: string, label: string) => void;
  onRemove: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const visible = useMemo(() => items.filter((s) => !(s.kind === 'object' && OBJECTS[s.target ?? '']?.requires === 'audit' && !canSeeAudit)), [items, canSeeAudit]);
  if (!visible.length) return null;

  const openRecord = (target: string, label: string) => {
    const [type, id] = target.split(':');
    if (type === 'Staff' || type === 'Manager') {
      navigate('/users');
      // The detail panel loads the record itself and shows "not found" if it is no longer accessible.
      setTimeout(() => document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id, type: type === 'Staff' ? 'staff' : isOrgAdmin ? 'manager' : 'venueManager' } })), 0);
      return;
    }
    const page = type === 'Venue' ? '/venues' : type === 'Shift' ? '/shifts' : '/offers';
    navigate(`${page}?q=${encodeURIComponent(label)}`);
  };

  const item = (s: Shortcut): ReactNode => {
    const I = ICON[s.icon];
    const content = <><I size={16} stroke={1.6} aria-hidden="true" /><span>{s.label}</span></>;
    let link: ReactNode;
    if (s.kind === 'object') link = <NavLink to={OBJECTS[s.target!]!.to} className={({ isActive }) => `nav-item shortcut-item${isActive ? ' shortcut-current' : ''}`} title={s.label}>{content}</NavLink>;
    else if (s.kind === 'link' && s.target!.startsWith('https://')) link = <a href={s.target} target="_blank" rel="noopener noreferrer" className="nav-item shortcut-item" title={`${s.label} (opens in a new tab)`}>{content}<IconExternalLink size={12} className="shortcut-ext" aria-hidden="true" /></a>;
    else link = (
      <button type="button" className="nav-item shortcut-item" title={s.label} onClick={() => {
        if (s.kind === 'view') navigate(VIEWS[s.target!]!.to());
        else if (s.kind === 'link') navigate(s.target!);
        else if (s.kind === 'record') openRecord(s.target!, s.label);
      }}>{content}</button>
    );
    return (
      <div key={s.id} className="shortcut-row">
        {link}
        <ShortcutMenu shortcut={s} onRename={onRename} onRemove={onRemove} />
      </div>
    );
  };

  const top = visible.filter((s) => !s.parentId);
  return (
    <div className="shortcut-list" aria-label="Your shortcuts">
      {top.map((s) => {
        if (s.kind !== 'folder') return item(s);
        const open = openFolders[s.id] ?? true;
        const children = visible.filter((c) => c.parentId === s.id);
        return (
          <div key={s.id} className="shortcut-folder">
            <div className="shortcut-row">
              <button type="button" className="nav-item shortcut-item" aria-expanded={open} onClick={() => setOpenFolders((f) => ({ ...f, [s.id]: !open }))}>
                <IconFolder size={16} stroke={1.6} aria-hidden="true" /><span>{s.label}</span>
                <IconChevronRight size={12} className={`shortcut-caret${open ? ' open' : ''}`} aria-hidden="true" />
              </button>
              <ShortcutMenu shortcut={s} onRename={onRename} onRemove={onRemove} />
            </div>
            {open && <div className="shortcut-children">{children.length ? children.map(item) : <p className="shortcut-empty">Empty folder</p>}</div>}
          </div>
        );
      })}
    </div>
  );
}

function ShortcutMenu({ shortcut, onRename, onRemove }: { shortcut: Shortcut; onRename: (id: string, label: string) => void; onRemove: (id: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(shortcut.label);
  return (
    <>
      <button ref={ref} type="button" className="shortcut-more" aria-label={`Options for ${shortcut.label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen((v) => !v); setRenaming(false); setValue(shortcut.label); }}>
        <IconDots size={14} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} align="start" minWidth={200} role="presentation">
        {renaming ? (
          <form className="add-menu-form" onSubmit={(e) => { e.preventDefault(); if (value.trim()) { onRename(shortcut.id, value.trim()); setOpen(false); } }}>
            <label htmlFor={`rename-${shortcut.id}`}>Name</label>
            <input id={`rename-${shortcut.id}`} value={value} maxLength={60} autoFocus onChange={(e) => setValue(e.target.value)} />
            <div className="add-menu-actions"><button type="button" className="btn btn-outline" onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="btn btn-dark">Save</button></div>
          </form>
        ) : (
          <div role="menu" aria-label={`Options for ${shortcut.label}`}>
            <button role="menuitem" type="button" className="dropdown-item" autoFocus onClick={() => setRenaming(true)}>Rename</button>
            <button role="menuitem" type="button" className="dropdown-item danger" onClick={() => { setOpen(false); onRemove(shortcut.id); }}>
              {shortcut.kind === 'folder' ? 'Remove folder and its shortcuts' : 'Remove from sidebar'}
            </button>
          </div>
        )}
      </Popover>
    </>
  );
}
