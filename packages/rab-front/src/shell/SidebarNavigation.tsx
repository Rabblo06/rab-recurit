import { createPortal } from 'react-dom';
import { Children, cloneElement, Fragment, isValidElement, useEffect, useRef, useState, type ReactNode, type ReactElement } from 'react';
import { IconChevronDown, IconTool, IconCheck, IconPlus, IconPaint } from '@tabler/icons-react';
import { AddMenuItem, ShortcutList, ShortcutMenu, useNavShortcuts } from './NavShortcuts';
import SidebarIconPicker, { SIDEBAR_ICONS } from './SidebarIconPicker';
import { MAX_SHORTCUTS, OBJECTS, storageKey, type ShortcutIcon, type Shortcut } from './nav-shortcuts';
import { getUserId, subscribeToSession } from '../shared/lib/auth-session';
import './sidebar-layout-editor.css';

type BaseItem = { id: string; label: string; icon?: ShortcutIcon; color?: string };
type BaseLayout = Record<'workspace' | 'operations', BaseItem[]>;
type LinkElement = ReactElement<{ item: { to: string; label: string; Icon?: typeof IconTool; dot?: string } }>;
function links(node: ReactNode): LinkElement[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement(child)) return [];
    if (child.type === Fragment) return links(child.props.children);
    return child.props.item?.to !== undefined ? [child as LinkElement] : [];
  });
}
function readBaseLayout(key: string | null, defaults: BaseLayout): BaseLayout {
  try {
    const value = JSON.parse(key ? localStorage.getItem(key) ?? 'null' : 'null');
    if (!value || !Array.isArray(value.workspace) || !Array.isArray(value.operations)) return defaults;
    const clean = (section: 'workspace' | 'operations') => value[section].filter((item: BaseItem, i: number, all: BaseItem[]) => item && typeof item.id === 'string' && typeof item.label === 'string' && item.label.trim() && defaults[section].some(base => base.id === item.id) && all.findIndex(other => other?.id === item.id) === i).map((item: BaseItem) => ({ id: item.id, label: item.label.slice(0, 60), icon: item.icon && item.icon in SIDEBAR_ICONS ? item.icon : undefined, color: item.color && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : undefined }));
    const workspace = clean('workspace');
    // Up next is a new built-in destination; retain all saved layout choices.
    const upNext = defaults.workspace.find(item => item.id === '/up-next');
    if (value.upNextIntroduced !== true && upNext && !workspace.some((item: BaseItem) => item.id === '/up-next')) workspace.unshift(upNext);
    return { workspace, operations: clean('operations') };
  } catch { return defaults; }
}

type Section = 'workspace' | 'operations';
type Props = {
  userId: string | null;
  workspaceId?: string | null;
  canSeeAudit: boolean;
  isOrgAdmin: boolean;
  workspace: ReactNode;
  operations: ReactNode;
  guide: ReactNode;
  collapsed: string[];
  onToggle: (id: string) => void;
};

/** Presentation-only preferences. Existing routes, record search and permission checks are reused. */
export default function SidebarNavigation(props: Props) {
  const [identity, setIdentity] = useState(getUserId());
  useEffect(() => subscribeToSession(() => setIdentity(getUserId())), []);
  return <NavigationEditor key={`${identity ?? props.userId}:${props.workspaceId ?? 'none'}`} {...props} userId={identity ?? props.userId} />;
}

function NavigationEditor(props: Props) {
  // Keep the existing Operations key so previously saved shortcuts are preserved.
  const operations = useNavShortcuts(props.userId, props.workspaceId);
  const workspace = useNavShortcuts(props.userId, props.workspaceId, 'workspace');
  const originals = { workspace: links(props.workspace), operations: links(props.operations) };
  const defaults: BaseLayout = {
    workspace: originals.workspace.map(link => ({ id: link.props.item.to, label: link.props.item.label })),
    operations: originals.operations.map(link => ({ id: link.props.item.to, label: link.props.item.label })),
  };
  const identityKey = storageKey(props.userId, props.workspaceId);
  const layoutKey = identityKey ? identityKey + ':layout' : null;
  const [base, setBase] = useState(() => readBaseLayout(layoutKey, defaults));
  const [baseDraft, setBaseDraft] = useState<BaseLayout | null>(null);
  const [draft, setDraft] = useState<Record<Section, Shortcut[]> | null>(null);
  const [workspacePicker, setWorkspacePicker] = useState(false);
  const [operationsPicker, setOperationsPicker] = useState(false);
  const [persistent, setPersistent] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const ready = workspace.ready && operations.ready;
  const shownRoutes = [...(baseDraft ?? base).workspace, ...(baseDraft ?? base).operations].map(item => item.id).concat(links(props.guide).map(link => link.props.item.to));
  const existingObjectTargets = Object.entries(OBJECTS).filter(([, object]) => shownRoutes.includes(object.to)).map(([key]) => key).concat([...(draft?.workspace ?? workspace.items), ...(draft?.operations ?? operations.items)].filter(item => item.kind === 'object').map(item => item.target!));
  const dirty = !!draft && (JSON.stringify(draft.workspace) !== JSON.stringify(workspace.items) || JSON.stringify(draft.operations) !== JSON.stringify(operations.items) || JSON.stringify(baseDraft) !== JSON.stringify(base));
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 180);
    return () => window.clearTimeout(timer);
  }, [saved]);
  const edit = () => { setSaved(false); setBaseDraft(base); setDraft({ workspace: [...workspace.items], operations: [...operations.items] }); };
  const change = (section: Section, update: (items: Shortcut[]) => Shortcut[]) => setDraft(current => current ? { ...current, [section]: update(current[section]) } : current);
  const save = () => {
    if (!draft || !dirty) return;
    setSaving(true);
    // Keep persistence device-local, matching the existing shortcut preferences.
    const workspaceSaved = workspace.replace(draft.workspace);
    const operationsSaved = operations.replace(draft.operations);
    let layoutSaved = false;
    if (baseDraft) {
      setBase(baseDraft);
      try { if (layoutKey) { localStorage.setItem(layoutKey, JSON.stringify({ ...baseDraft, upNextIntroduced: true })); layoutSaved = true; } } catch { /* Keep the visual preference for this session. */ }
    }
    setPersistent(workspaceSaved && operationsSaved && layoutSaved);
    // Brief completion feedback gives the requested motion time to read; no network request is simulated.
    timer.current = setTimeout(() => {
      setSaving(false);
      setDraft(null);
      setBaseDraft(null);
      setSaved(true);
    }, 600);
  };
  const section = (id: Section, label: string, children: ReactNode) => {
    const items = draft?.[id] ?? (id === 'workspace' ? workspace.items : operations.items);
    // Use the same shortcut ordering when placing items around built-in destinations.
    const combined: Shortcut[] = (baseDraft ?? base)[id].map<Shortcut>(item => {
      const entry = Object.entries(OBJECTS).find(([, object]) => object.to === item.id);
      const original = originals[id].find(link => link.props.item.to === item.id)?.props.item;
      const originalIcon = Object.entries(SIDEBAR_ICONS).find(([, Icon]) => Icon === original?.Icon)?.[0];
      return { id: item.id, kind: entry ? 'object' as const : 'link' as const, target: entry?.[0] ?? item.id, label: item.label, icon: item.icon ?? originalIcon ?? entry?.[1].icon ?? 'object', color: item.color ?? original?.dot };
    }).concat(items);
    const rearrange = (update: (previous: Shortcut[]) => Shortcut[]) => {
      const next = update(combined);
      if (next.length > MAX_SHORTCUTS) return;
      setBaseDraft(current => current ? { ...current, [id]: [] } : current);
      change(id, () => next);
    };
    const moveToFolder = (key: string, parentId: string | null) => rearrange(previous => previous.map(item => item.id === key ? { ...item, parentId } : item));
    const insert = (key: string, direction: number, item: Omit<Shortcut, 'id'>) => rearrange(previous => {
      const index = previous.findIndex(current => current.id === key);
      const next = [...previous];
      next.splice(index + (direction > 0 ? 1 : 0), 0, { ...item, parentId: item.kind === 'folder' ? null : previous[index]?.parentId, id: 's' + crypto.randomUUID() });
      return next;
    });
    const closed = props.collapsed.includes(id === 'workspace' ? 'primary-workspace' : id);
    const pickerOpen = id === 'workspace' ? workspacePicker : operationsPicker;
    const setPicker = id === 'workspace' ? setWorkspacePicker : setOperationsPicker;
    const add = (inline = false, initiallyOpen = false) => <AddMenuItem existingObjectTargets={existingObjectTargets} initiallyOpen={initiallyOpen} inline={inline} onOpenChange={initiallyOpen ? setPicker : undefined} sectionLabel={label} shortcuts={items} canSeeAudit={props.canSeeAudit} onAdd={item => change(id, previous => [...previous, { ...item, id: `s${crypto.randomUUID()}` }])} />;
    return <div className={`sidebar-section sidebar-group sidebar-editable-section${closed ? ' is-collapsed' : ''}`}>
      <div className="sidebar-group-head">
        <button type="button" className="sidebar-group-label" aria-expanded={!closed} onClick={() => props.onToggle(id === 'workspace' ? 'primary-workspace' : id)}>{label}<IconChevronDown size={12} className="sidebar-group-caret" aria-hidden="true" /></button>
        {id === 'workspace' && !draft && ready && <button type="button" className="sidebar-layout-tool" aria-label="Edit workspace layout" title="Edit workspace layout" onClick={edit}><IconTool size={15} /></button>}
        {draft && !saving && <button type="button" className="sidebar-group-add" aria-label={`Add menu item to ${label}`} aria-expanded={pickerOpen} onClick={() => { if (closed) props.onToggle(id === 'workspace' ? 'primary-workspace' : id); setPicker(!pickerOpen); }}><IconPlus size={14} /></button>}
      </div>
      {!closed && <nav className="sidebar-nav" aria-label={label}>
        {draft && pickerOpen && add(true, true)}
        {originals[id].length ? (baseDraft ?? base)[id].map(item => {
          const original = originals[id].find(link => link.props.item.to === item.id);
          if (!original) return null;
          const update = (fn: (items: BaseItem[]) => BaseItem[]) => setBaseDraft(current => current ? { ...current, [id]: fn(current[id]) } : current);
          return <div className={`shortcut-row${draft && !saving ? ' has-icon-picker' : ''}`} key={item.id}>
            {draft && !saving && <SidebarIconPicker label={item.label} icon={item.icon} displayIcon={original.props.item.Icon} color={item.color ?? original.props.item.dot} onChange={(icon,color)=>update(items=>items.map(current=>current.id===item.id?{...current,icon,color}:current))}/>}
            {cloneElement(original, { item: { ...original.props.item, label: item.label, ...(item.icon ? {Icon:SIDEBAR_ICONS[item.icon]} : {}), ...(item.color ? {dot:item.color}: {}) } })}
            {draft && !saving && <ShortcutMenu shortcut={{ id: item.id, kind: 'object', icon: 'object', label: item.label }}
              shortcuts={combined} existingObjectTargets={existingObjectTargets} canSeeAudit={props.canSeeAudit} onMoveToFolder={combined.length <= MAX_SHORTCUTS ? moveToFolder : undefined} onInsert={combined.length < MAX_SHORTCUTS ? insert : undefined}
              onRename={(_key, label) => update(items => items.map(current => current.id === item.id ? { ...current, label } : current))}
              onRemove={() => update(items => items.filter(current => current.id !== item.id))}
              onMove={(_key, direction) => update(items => {
                const result = [...items]; const index = result.findIndex(current => current.id === item.id); const other = index + direction;
                if (other >= 0 && other < result.length) [result[index], result[other]] = [result[other]!, result[index]!];
                return result;
              })} />}
          </div>;
        }) : children}
        <ShortcutList onMoveToFolder={combined.length <= MAX_SHORTCUTS ? moveToFolder : undefined} onInsert={combined.length < MAX_SHORTCUTS ? insert : undefined} existingObjectTargets={existingObjectTargets} onAppearance={(key,icon,color)=>change(id,previous=>previous.map(item=>item.id===key?{...item,icon,color}:item))} onAdd={item => change(id, previous => [...previous, { ...item, id: `s${crypto.randomUUID()}` }])} items={items} canSeeAudit={props.canSeeAudit} isOrgAdmin={props.isOrgAdmin} editable={!!draft && !saving}
          onRename={(key, name) => change(id, previous => previous.map(item => item.id === key ? { ...item, label: name } : item))}
          onRemove={key => change(id, previous => previous.filter(item => item.id !== key && item.parentId !== key))}
          onMove={(key, direction) => change(id, previous => {
            const result = [...previous]; const index = result.findIndex(item => item.id === key);
            const siblings = result.map((item, i) => ({ item, i })).filter(({ item }) => item.parentId === result[index]?.parentId);
            const siblingIndex = siblings.findIndex(({ i }) => i === index); const other = siblings[siblingIndex + direction]?.i;
            if (other !== undefined) [result[index], result[other]] = [result[other]!, result[index]!];
            return result;
          })} />
        {draft && !saving && add(true)}
      </nav>}
    </div>;
  };
  return <div className="sidebar-layout-editor">
    {(draft || saved) && createPortal(<div className={`sidebar-layout-toolbar${saved ? ' is-finishing' : ''}`} role="region" aria-label="Workspace layout edition">
      <span><IconPaint size={14} aria-hidden="true" />Workspace layout edition</span>
      <div>{saved ? <span role="status"><IconCheck size={14} /> {persistent ? 'Saved on this device' : 'Saved for this session only'}</span> : <>
        <button type="button" disabled={saving} onClick={() => { setDraft(null); setBaseDraft(null); }}>Cancel</button>
        <button type="button" className="sidebar-layout-save" disabled={!dirty || saving} onClick={save} aria-busy={saving} aria-label={saving ? 'Saving layout' : 'Save layout'}>
          {saving ? <span className="sidebar-save-track" role="status" aria-label="Saving layout"><i /></span> : <><IconCheck size={13} /> Save</>}
        </button>
      </>}</div>
    </div>, document.body)}
    {section('workspace', 'Workspace', props.workspace)}
    {section('operations', 'Operations', props.operations)}
    <div className={`sidebar-section sidebar-group sidebar-editable-section${props.collapsed.includes('workspace') ? ' is-collapsed' : ''}`}>
      <div className="sidebar-group-head"><button type="button" className="sidebar-group-label" aria-expanded={!props.collapsed.includes('workspace')} onClick={() => props.onToggle('workspace')}>User Guide<IconChevronDown size={12} className="sidebar-group-caret" aria-hidden="true" /></button></div>
      {!props.collapsed.includes('workspace') && <nav className="sidebar-nav" aria-label="User Guide">{props.guide}</nav>}
    </div>
  </div>;
}
