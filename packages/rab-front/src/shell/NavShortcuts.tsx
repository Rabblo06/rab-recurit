import { motionTokens } from '../shared/components/arc/motion-tokens';
import { SearchField } from '../shared/components/arc/search-field/search-field';
import SidebarMenuMotion from './SidebarMenuMotion';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  IconBolt, IconBox, IconBuildingStore, IconCalendarEvent, IconChevronLeft, IconChevronRight, IconDots, IconExternalLink,
  IconChevronUp, IconChevronDown, IconFolderPlus, IconRowInsertTop, IconRowInsertBottom, IconPencil, IconTrash, IconFilter, IconFolder, IconLink, IconMail, IconPlus, IconSearch, IconStar, IconUser, IconX,
} from '@tabler/icons-react';
import { api } from '../shared/api';
import SidebarIconPicker, { SIDEBAR_ICONS } from './SidebarIconPicker';
import Popover from '../shared/components/Popover';
import NavigationIndicator from '../shared/components/NavigationIndicator';
import { getUserId, subscribeToSession } from '../shared/lib/auth-session';
import { spring, usePrefersReducedMotion } from '../shared/motion';
import {
  MAX_SHORTCUTS, OBJECTS, PICKABLE_ICONS, VIEWS, isDuplicate, parseShortcuts, storageKey, validateLink,
  type Shortcut, type ShortcutIcon, type ShortcutKind,
} from './nav-shortcuts';

const ICON = SIDEBAR_ICONS;
const CATEGORIES: Array<{ kind: ShortcutKind; label: string; hint: string; icon: ShortcutIcon }> = [
  { kind: 'object', label: 'Object', hint: 'A Crewflow page', icon: 'object' },
  { kind: 'view', label: 'View', hint: 'A filtered list', icon: 'view' },
  { kind: 'record', label: 'Record', hint: 'A person, venue, shift or offer', icon: 'person' },
  { kind: 'folder', label: 'Folder', hint: 'Group your shortcuts', icon: 'folder' },
  { kind: 'link', label: 'Link', hint: 'A Crewflow path or https:// site', icon: 'link' },
];
const RECORD_ICON: Record<string, ShortcutIcon> = { Staff: 'person', Manager: 'person', Venue: 'venue', Shift: 'shift', Offer: 'offer' };

/** Device-local shortcuts for the signed-in user + workspace (see nav-shortcuts.ts). Re-reads on every identity change. */
export function useNavShortcuts(fallbackUserId: string | null, workspaceId: string | null | undefined, section?: string) {
  const [sessionUser, setSessionUser] = useState(getUserId());
  useEffect(() => subscribeToSession(() => setSessionUser(getUserId())), []);
  const baseKey = storageKey(sessionUser ?? fallbackUserId, workspaceId);
  const key = baseKey && section ? `${baseKey}:${section}` : baseKey;
  const read = (k: string | null) => { if (!k) return []; try { return parseShortcuts(localStorage.getItem(k)); } catch { return []; } };
  const [items, setItems] = useState<Shortcut[]>(() => read(key));
  useEffect(() => setItems(read(key)), [key]);
  const save = (next: Shortcut[]) => {
    setItems(next);
    if (!key) return false;
    try { localStorage.setItem(key, JSON.stringify(next)); return true; } catch { return false; /* kept for this page only */ }
  };
  return {
    items,
    replace: save,
    ready: !!key,
    add: (s: Omit<Shortcut, 'id'>) => save([...items, { ...s, id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}` }]),
    rename: (id: string, label: string) => save(items.map((s) => (s.id === id ? { ...s, label: label.slice(0, 60) } : s))),
    // Removing a folder removes the shortcuts inside it too — shortcuts only; no record, route or page is touched.
    remove: (id: string) => save(items.filter((s) => s.id !== id && s.parentId !== id)),
  };
}

type Draft = { kind: ShortcutKind; target?: string; label: string; icon: ShortcutIcon; external?: boolean };

/** The Operations "+" control and its "Add menu item" flow: category → choose/search → confirm name, icon, folder. */
export function AddMenuItem({ existingObjectTargets = [], shortcuts, canSeeAudit, onAdd, sectionLabel = "Operations", inline = false, onOpenChange, folderId, initiallyOpen = false, anchorRef }: {
  anchorRef?: React.RefObject<HTMLButtonElement>;
  existingObjectTargets?: string[];
  initiallyOpen?: boolean;
  folderId?: string;
  onOpenChange?: (open: boolean) => void;
  sectionLabel?: string;
  inline?: boolean;
  shortcuts: Shortcut[];
  canSeeAudit: boolean;
  onAdd: (s: Omit<Shortcut, 'id'>) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const reduce = usePrefersReducedMotion();
  const [open, setOpen] = useState(initiallyOpen);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  const [step, setStep] = useState<'pick' | ShortcutKind | 'confirm'>('pick');
  const [dir, setDir] = useState(1);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [linkValue, setLinkValue] = useState('');
  const [error, setError] = useState('');
  const [parentId, setParentId] = useState<string>(folderId ?? '');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(query.trim()), 250); return () => clearTimeout(t); }, [query]);
  useEffect(() => { if (open) requestAnimationFrame(() => searchRef.current?.focus()); }, [open, step]);
  const go = (next: typeof step, d = 1) => { setDir(d); setStep(next); setQuery(''); setError(''); };
  const reset = () => { setOpen(false); setStep('pick'); setDraft(null); setQuery(''); setLinkValue(''); setError(''); setParentId(folderId ?? ''); };

  // Record search is server-scoped (the same authorised /search the global search uses) — never a full download.
  const records = useQuery({
    queryKey: ['nav-shortcut-search', debounced],
    enabled: open && step === 'record' && debounced.length > 1,
    queryFn: async () => (await api.get<Array<{ id: string; name: string; type: string; group: string }>>('/search', { params: { q: debounced } })).data,
  });

  const folders = shortcuts.filter((s) => s.kind === 'folder');
  const full = shortcuts.length >= MAX_SHORTCUTS;
  const matches = (label: string) => label.toLowerCase().includes(query.trim().toLowerCase());
  const objectOrder = ['up-next', 'dashboard', 'users', 'shifts', 'payroll', 'offers', 'calendar', 'venues', 'venue-offers', 'audit', 'help', 'support'];
  const objects = Object.entries(OBJECTS).sort(([a], [b]) => (objectOrder.includes(a) ? objectOrder.indexOf(a) : 99) - (objectOrder.includes(b) ? objectOrder.indexOf(b) : 99)).filter(([, o]) => (o.requires !== 'audit' || canSeeAudit) && matches(o.label));
  const views = Object.entries(VIEWS).filter(([, v]) => matches(v.label));
  const categories = CATEGORIES.filter((c) => (!folderId || c.kind !== 'folder') && matches(c.label));

  const choose = (d: Draft) => {
    if (d.kind !== 'folder' && isDuplicate(shortcuts, { kind: d.kind, target: d.target, label: d.label })) { setError('That is already in your sidebar.'); return; }
    if (d.kind === 'object' || d.kind === 'view' || d.kind === 'record') {
      onAdd({ kind: d.kind, target: d.target, label: d.label, icon: d.icon, parentId: folderId ?? null });
      reset(); return;
    }
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

  const row = (key: string, icon: ShortcutIcon, label: string, onClick: () => void, extra?: ReactNode, disabled = false) => {
    const I = ICON[icon];
    return (
      <button key={key} type="button" className="add-menu-row" disabled={disabled} onClick={onClick}>
        <I size={16} stroke={1.6} aria-hidden="true" /><span>{label}</span>{extra}
      </button>
    );
  };

  const body = () => {
    if (step === 'pick') {
      return categories.map((c) => row(c.kind, c.icon, c.label, () => {
        if (c.kind === 'folder') { let label='New folder'; let number=2; while(shortcuts.some(item=>item.kind==='folder'&&item.label===label)) label='New folder '+number++; onAdd({kind:'folder',label,icon:'folder',parentId:null}); reset(); }
        else go(c.kind);
      }, c.kind === 'folder' ? null : <IconChevronRight size={14} className="add-menu-chevron" aria-hidden="true" />));
    }
    if (step === 'object') return objects.length ? objects.map(([key, o]) => {
      const added = existingObjectTargets.includes(key) || isDuplicate(shortcuts, { kind: 'object', target: key, label: o.label });
      return row(key, o.icon, o.label, () => choose({ kind: 'object', target: key, label: o.label, icon: o.icon }), added ? <span className="add-menu-existing">· Already in sidebar</span> : undefined, added);
    }) : <p className="add-menu-empty">No matching pages.</p>;
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
          <button type="submit" className="btn btn-outline flow-button flow-button-light">Continue</button>
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
            {folders.length > 0 && !folderId && (
              <>
                <label htmlFor="add-menu-folder">Add to</label>
                <select id="add-menu-folder" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">{sectionLabel}</option>
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
      {!anchorRef && <button ref={anchor} type="button" className={inline ? "sidebar-add-inline" : "sidebar-group-add"} aria-label={`Add menu item to ${sectionLabel}`} title="Add menu item" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? reset() : setOpen(true))}>
        <IconPlus size={14} stroke={1.8} />{inline && <span>{open ? "Select a menu item" : "Add menu item"}</span>}
      </button>}
      <Popover open={open} onClose={reset} anchorRef={anchorRef ?? anchor} align="start" placement="right" minWidth={step === 'object' ? 320 : 235} role="dialog" className={`add-menu-popover${step === 'object' ? ' object-menu-popover' : ''}`}>
        <div className="add-menu" data-step={step} aria-label="Add menu item">
          <div className="add-menu-head">
            {step !== 'pick' && <button type="button" className="btn-icon" aria-label="Back" onClick={() => go('pick', -1)}><IconChevronLeft size={15} /></button>}
            <h3>{title}</h3>
            <button type="button" className="btn-icon" aria-label="Close" onClick={reset}><IconX size={15} /></button>
          </div>
          {full ? <p className="add-menu-empty">You have {MAX_SHORTCUTS} shortcuts — remove one to add another.</p> : (
            <>
              {searchable && (
                <div className="add-menu-search">
                  <SearchField label={`Search ${title}`} type="text" ref={searchRef} value={query} onChange={(e) => { setQuery(e.target.value); setError(''); }} placeholder="Search…" aria-label={`Search ${title}`} />
                </div>
              )}
              <AnimatePresence mode="wait" initial={false} custom={dir}>
                <motion.div key={step} className="add-menu-body" custom={dir} variants={reduce ? undefined : { enter: { opacity: 0, y: -3 }, center: { opacity: 1, y: 0, transition: { duration: .14 } }, exit: { opacity: 0, transition: { duration: .06 } } }} initial="enter" animate="center" exit="exit">
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
export function ShortcutList({ existingObjectTargets, items, canSeeAudit, isOrgAdmin, onRename, onRemove, editable = true, onMove, onAdd, onAppearance, onMoveToFolder, onInsert }: {
  onMoveToFolder?: (id: string, parentId: string | null) => void;
  onInsert?: (id: string, direction: number, item: Omit<Shortcut, "id">) => void;
  existingObjectTargets?: string[];
  onAppearance?: (id: string, icon: ShortcutIcon, color?: string) => void;
  onAdd?: (item: Omit<Shortcut, 'id'>) => void;
  editable?: boolean;
  onMove?: (id: string, direction: number) => void;
  items: Shortcut[];
  canSeeAudit: boolean;
  isOrgAdmin: boolean;
  onRename: (id: string, label: string) => void;
  onRemove: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const location = useLocation();
  const reduceMotion = usePrefersReducedMotion();
  useEffect(() => setSelectedFolder(null), [location.pathname, location.search]);
  useEffect(() => {
    const clearSelection = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.nav-item') && target.closest('[data-folder-id]')?.getAttribute('data-folder-id') !== selectedFolder) setSelectedFolder(null);
    };
    document.addEventListener('click', clearSelection);
    return () => document.removeEventListener('click', clearSelection);
  }, [selectedFolder]);
  const knownFolders=useRef(new Set(items.filter(item=>item.kind==='folder').map(item=>item.id)));
  const [renamingFolder,setRenamingFolder]=useState<string|null>(null);
  const [folderName,setFolderName]=useState('');
  const renameDone=useRef(false);
  useEffect(()=>{const added=items.find(item=>item.kind==='folder'&&!knownFolders.current.has(item.id)); knownFolders.current=new Set(items.filter(item=>item.kind==='folder').map(item=>item.id)); if(added&&editable){setRenamingFolder(added.id);setFolderName(added.label);renameDone.current=false;}},[items,editable]);
  const startFolderRename = (folder: Shortcut) => { setRenamingFolder(folder.id); setFolderName(folder.label); renameDone.current = false; };
  const finishFolder=(id:string,cancel=false)=>{if(renameDone.current)return;renameDone.current=true;if(!cancel&&folderName.trim())onRename(id,folderName.trim());setRenamingFolder(null);};
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
    const target = s.kind === 'view' ? VIEWS[s.target!]?.to() : s.kind === 'link' && s.target?.startsWith('/') ? s.target : undefined;
    const url = target ? new URL(target, window.location.origin) : null;
    const current = !!url && url.pathname === location.pathname && [...url.searchParams].every(([key, value]) => new URLSearchParams(location.search).get(key) === value);
    const content = <><I size={16} stroke={1.6} style={{color:s.color}} aria-hidden="true" /><span>{s.label}</span></>;
    let link: ReactNode;
    if (s.kind === 'object') link = <NavLink to={OBJECTS[s.target!]!.to} end={OBJECTS[s.target!]!.to === '/'} className={({ isActive }) => `nav-item shortcut-item${isActive ? ' shortcut-current' : ''}`} title={s.label}>{({ isActive }) => <><NavigationIndicator active={isActive} priority={OBJECTS[s.target!]!.to.length + 1} />{content}</>}</NavLink>;
    else if (s.kind === 'link' && s.target!.startsWith('https://')) link = <a href={s.target} target="_blank" rel="noopener noreferrer" className="nav-item shortcut-item" title={`${s.label} (opens in a new tab)`}>{content}<IconExternalLink size={12} className="shortcut-ext" aria-hidden="true" /></a>;
    else link = (
      <button type="button" className={`nav-item shortcut-item${current ? ' shortcut-current' : ''}`} title={s.label} aria-current={current ? 'page' : undefined} onClick={() => {
        if (s.kind === 'view') navigate(VIEWS[s.target!]!.to());
        else if (s.kind === 'link') navigate(s.target!);
        else if (s.kind === 'record') openRecord(s.target!, s.label);
      }}><NavigationIndicator active={current} priority={(target?.length ?? 0) + 1} />{content}</button>
    );
    return (
      <div key={s.id} className={`shortcut-row${editable && onAppearance ? ' has-icon-picker' : ''}`}>
        {editable && onAppearance && <SidebarIconPicker label={s.label} icon={s.icon} color={s.color} onChange={(icon,color)=>onAppearance(s.id,icon ?? s.icon,color)}/>}
        {link}
        {editable && <ShortcutMenu shortcut={s} shortcuts={items} existingObjectTargets={existingObjectTargets} canSeeAudit={canSeeAudit} onRename={onRename} onRemove={onRemove} onMove={onMove} onMoveToFolder={onMoveToFolder} onInsert={onInsert} />}
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
        const active = selectedFolder === s.id || (!selectedFolder && children.some(child => child.kind === 'object' && matchPath({ path: OBJECTS[child.target!]?.to ?? '', end: OBJECTS[child.target!]?.to === '/' }, location.pathname)));
        return (
          <div key={s.id} data-folder-id={s.id} className={`shortcut-folder${selectedFolder === s.id ? ' folder-selected' : ''}`}>
            <NavigationIndicator active={active} className="folder-active-pill" priority={selectedFolder === s.id ? 10000 : Math.max(0, ...children.map(child => child.kind === 'object' ? (OBJECTS[child.target!]?.to.length ?? 0) : 0)) + 2} />
            <div className={`shortcut-row shortcut-folder-row${editable && onAppearance ? ' has-icon-picker' : ''}`}>
              {editable && onAppearance && <SidebarIconPicker label={s.label} icon={s.icon} color={s.color} onChange={(icon,color)=>onAppearance(s.id,icon ?? s.icon,color)}/>}
              <>{renamingFolder===s.id ? <input className="sidebar-folder-name" autoFocus aria-label="Folder name" value={folderName} maxLength={60} onFocus={e=>e.currentTarget.select()} onChange={e=>setFolderName(e.target.value)} onBlur={()=>finishFolder(s.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();finishFolder(s.id,e.key==='Escape');}}}/> : <button type="button" className="nav-item shortcut-item" onDoubleClick={() => { if (editable) startFolderRename(s); }} onKeyDown={event => { if (editable && event.key === "F2") { event.preventDefault(); startFolderRename(s); } }} onClick={() => setSelectedFolder(s.id)}>
                <span className="folder-custom-icon" style={{color:s.color}}>{(() => {const FolderIcon=ICON[s.icon]; return <FolderIcon size={16} stroke={1.6} style={{ color: s.color }}/>;})()}</span><span>{s.label}</span>

              </button>}</>
              <button type="button" className={`folder-expand${editable ? ' with-menu' : ''}`} aria-label={`${open ? 'Collapse' : 'Expand'} ${s.label}`} aria-expanded={open} onClick={() => { setSelectedFolder(s.id); setOpenFolders(previous => ({ ...previous, [s.id]: !open })); }}><IconChevronRight size={13} className={`shortcut-caret${open ? ' open' : ''}`} aria-hidden="true" /></button>
              {editable && <ShortcutMenu onRequestRename={() => startFolderRename(s)} shortcut={s} shortcuts={items} existingObjectTargets={existingObjectTargets} canSeeAudit={canSeeAudit} onRename={onRename} onRemove={onRemove} onMove={onMove} onMoveToFolder={onMoveToFolder} onInsert={onInsert} />}
            </div>
            <AnimatePresence initial={false}>{open && <motion.div key="folder-contents" className="folder-contents-motion" initial={reduceMotion ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduceMotion ? { duration: 0 } : motionTokens.spring.smooth}><div className="shortcut-children">{children.map(item)}{editable && onAdd ? <AddMenuItem existingObjectTargets={existingObjectTargets} inline folderId={s.id} sectionLabel={s.label} shortcuts={items} canSeeAudit={canSeeAudit} onAdd={onAdd} /> : !children.length && <p className="shortcut-empty">Empty folder</p>}</div></motion.div>}</AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

export function ShortcutMenu({ shortcut, onRequestRename, onRename, onRemove, onMove, shortcuts = [], existingObjectTargets, canSeeAudit = false, onMoveToFolder, onInsert }: { onRequestRename?: () => void; shortcuts?: Shortcut[]; existingObjectTargets?: string[]; canSeeAudit?: boolean; onMoveToFolder?: (id: string, parentId: string | null) => void; onInsert?: (id: string, direction: number, item: Omit<Shortcut, 'id'>) => void; onMove?: (id: string, direction: number) => void; shortcut: Shortcut; onRename: (id: string, label: string) => void; onRemove: (id: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(shortcut.label);
  const [folderMenu, setFolderMenu] = useState(false);
  const [inserting, setInserting] = useState<number | null>(null);
  const folders = shortcuts.filter(item => item.kind === "folder" && item.id !== shortcut.id);
  return (
    <>
      <button ref={ref} type="button" className="shortcut-more" aria-label={`Options for ${shortcut.label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen((v) => !v); setRenaming(false); setFolderMenu(false); setValue(shortcut.label); }}>
        <IconDots size={14} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} align="start" placement="right" minWidth={240} className="sidebar-action-popover" role="presentation">
        <SidebarMenuMotion>{folderMenu ? <div className="sidebar-action-menu" role="menu" aria-label="Move to folder">
          <button type="button" role="menuitem" className="dropdown-item" onClick={() => setFolderMenu(false)}><IconChevronLeft size={16}/>Move to folder</button>
          {shortcut.parentId && <button type="button" role="menuitem" className="dropdown-item" onClick={() => { onMoveToFolder?.(shortcut.id, null); setOpen(false); }}><IconFolder size={16}/>Section root</button>}
          {folders.map(folder => <button key={folder.id} type="button" role="menuitem" className="dropdown-item" disabled={folder.id === shortcut.parentId} onClick={() => { onMoveToFolder?.(shortcut.id, folder.id); setOpen(false); }}><IconFolder size={16}/>{folder.label}</button>)}
          {!folders.length && <p className="add-menu-empty">Add a folder to this section first.</p>}
        </div> : renaming ? (
          <form className="add-menu-form" onSubmit={(e) => { e.preventDefault(); if (value.trim()) { onRename(shortcut.id, value.trim()); setOpen(false); } }}>
            <label htmlFor={`rename-${shortcut.id}`}>Name</label>
            <input id={`rename-${shortcut.id}`} value={value} maxLength={60} autoFocus onChange={(e) => setValue(e.target.value)} />
            <div className="add-menu-actions"><button type="button" className="btn btn-outline" onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="btn btn-dark">Save</button></div>
          </form>
        ) : (
          <div className="sidebar-action-menu" role="menu" aria-label={`Options for ${shortcut.label}`}>
            <button role="menuitem" type="button" className="dropdown-item" autoFocus onClick={() => { if (onRequestRename) { setOpen(false); onRequestRename(); } else setRenaming(true); }}><IconPencil size={16}/>Rename</button>
            {onMove && <><button role="menuitem" type="button" className="dropdown-item" onClick={() => { onMove(shortcut.id, -1); setOpen(false); }}><IconChevronUp size={16}/>Move up</button><button role="menuitem" type="button" className="dropdown-item" onClick={() => { onMove(shortcut.id, 1); setOpen(false); }}><IconChevronDown size={16}/>Move down</button></>}
            {onMoveToFolder && shortcut.kind !== 'folder' && <button type="button" role="menuitem" className="dropdown-item" aria-haspopup="menu" onClick={() => setFolderMenu(true)}><IconFolderPlus size={16}/><span>Move to folder</span><IconChevronRight size={14} className="sidebar-action-chevron"/></button>}
            {onInsert && [-1, 1].map(direction => <button key={direction} type="button" role="menuitem" className="dropdown-item" aria-haspopup="dialog" onClick={() => { setOpen(false); setInserting(direction); }}>{direction < 0 ? <IconRowInsertTop size={16}/> : <IconRowInsertBottom size={16}/>}<span>Add menu item {direction < 0 ? 'before' : 'after'}</span><IconChevronRight size={14} className="sidebar-action-chevron"/></button>)}
            <button role="menuitem" type="button" className="dropdown-item danger" onClick={() => { setOpen(false); onRemove(shortcut.id); }}>
              <IconTrash size={16}/>Remove from sidebar
            </button>
          </div>
        )}</SidebarMenuMotion>
      </Popover>
      {inserting !== null && <AddMenuItem anchorRef={ref} initiallyOpen shortcuts={shortcuts} existingObjectTargets={existingObjectTargets} canSeeAudit={canSeeAudit} folderId={shortcut.parentId ?? undefined} onOpenChange={open => { if (!open) setInserting(null); }} onAdd={item => { onInsert?.(shortcut.id, inserting, item); setInserting(null); }}/>}
    </>
  );
}
