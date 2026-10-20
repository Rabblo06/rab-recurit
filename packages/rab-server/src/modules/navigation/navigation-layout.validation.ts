/**
 * Strict, pure validation of a personal navigation layout (the sidebar shortcuts saved by the web editor).
 * Everything is allowlisted: kinds, icons, Object/View keys (must match `rab-front/src/shell/nav-shortcuts.ts`),
 * internal route roots, record types and id shapes. A shortcut is a POINTER — nothing here grants access to anything;
 * referenced records are re-checked against the caller's own scope by `NavigationLayoutService` on every save.
 */
export const MAX_ITEMS = 40;
export const MAX_LABEL = 60;

export const ITEM_KINDS = ['object', 'view', 'record', 'folder', 'link'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_ICONS = ['object', 'view', 'person', 'venue', 'shift', 'offer', 'folder', 'link', 'star', 'bolt'] as const;
/** Existing Crewflow pages (Object shortcuts). `audit` additionally needs AUDIT_VIEW at save time. */
export const OBJECT_KEYS = ['users', 'shifts', 'offers', 'payroll', 'calendar', 'venues', 'venue-offers', 'audit', 'help'] as const;
/** Supported filtered views (View shortcuts) — keys only, never a query string. */
export const VIEW_KEYS = [
  'shifts-upcoming', 'shifts-completed', 'offers-pending', 'offers-accepted', 'offers-confirmed', 'offers-expired',
  'payroll-active', 'payroll-completed', 'venues-active', 'venues-archived',
] as const;
/** Record shortcuts point at records the caller can open in an existing detail/list view. */
export const RECORD_TYPES = ['Staff', 'Manager', 'Venue', 'Shift'] as const;
const INTERNAL_ROOTS = new Set(['', 'users', 'shifts', 'offers', 'venue-offers', 'calendar', 'payroll', 'venues', 'audit', 'settings', 'help', 'support', 'chat']);
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface NavigationItem {
  id: string;
  kind: ItemKind;
  label: string;
  icon: (typeof ITEM_ICONS)[number];
  target: string | null;
  parentId: string | null;
}

export class NavigationLayoutInvalid extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('; '));
  }
}

/** Internal Crewflow path, or https URL without credentials. Anything executable or malformed is refused. */
export function isSafeLink(raw: string): boolean {
  if (typeof raw !== 'string' || !raw || raw.length > 2000 || /[\u0000-\u001f\u007f\\<>"'`\s]/.test(raw)) return false;
  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) return false;
    return INTERNAL_ROOTS.has(raw.slice(1).split(/[/?#]/)[0] ?? '');
  }
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.');
}

/**
 * Returns the normalised list (order = array order) or throws `NavigationLayoutInvalid` listing every problem.
 * Folders are one level deep (a folder has no parent, an item's parent must be a folder in the same list), so a cycle
 * is impossible by construction.
 */
export function validateNavigationItems(input: unknown): NavigationItem[] {
  if (!Array.isArray(input)) throw new NavigationLayoutInvalid(['items must be a list']);
  const problems: string[] = [];
  if (input.length > MAX_ITEMS) problems.push(`at most ${MAX_ITEMS} items`);
  const out: NavigationItem[] = [];
  const ids = new Set<string>();
  for (const [i, raw] of input.slice(0, MAX_ITEMS).entries()) {
    const at = `item ${i + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`${at}: not an object`); continue; }
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    if (!ID_RE.test(id)) problems.push(`${at}: invalid id`);
    else if (ids.has(id)) problems.push(`${at}: duplicate id`);
    ids.add(id);
    const kind = r.kind as ItemKind;
    if (!ITEM_KINDS.includes(kind)) { problems.push(`${at}: unknown kind`); continue; }
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    if (!label || label.length > MAX_LABEL || CONTROL_RE.test(label)) problems.push(`${at}: label must be 1–${MAX_LABEL} plain characters`);
    const icon = r.icon as NavigationItem['icon'];
    if (!ITEM_ICONS.includes(icon)) problems.push(`${at}: unknown icon`);
    const target = r.target == null ? null : String(r.target);
    const parentId = r.parentId == null || r.parentId === '' ? null : String(r.parentId);
    if (kind === 'folder') {
      if (target !== null) problems.push(`${at}: a folder has no destination`);
      if (parentId !== null) problems.push(`${at}: folders cannot be nested`);
    } else if (kind === 'object' && !OBJECT_KEYS.includes(target as never)) problems.push(`${at}: unknown page`);
    else if (kind === 'view' && !VIEW_KEYS.includes(target as never)) problems.push(`${at}: unknown view`);
    else if (kind === 'record') {
      const [type, rid, ...rest] = (target ?? '').split(':');
      if (rest.length || !RECORD_TYPES.includes(type as never) || !UUID_RE.test(rid ?? '')) problems.push(`${at}: invalid record reference`);
    } else if (kind === 'link' && !isSafeLink(target ?? '')) problems.push(`${at}: only Crewflow paths or https:// links without credentials`);
    out.push({ id, kind, label, icon, target, parentId });
  }
  const folders = new Set(out.filter((s) => s.kind === 'folder').map((s) => s.id));
  for (const s of out) if (s.parentId !== null && !folders.has(s.parentId)) problems.push(`item ${s.id}: parent is not a folder in this layout`);
  const seen = new Set<string>();
  for (const s of out) {
    if (s.kind === 'folder') continue;
    const key = `${s.kind}|${s.target}`;
    if (seen.has(key)) problems.push(`item ${s.id}: duplicate destination`);
    seen.add(key);
  }
  if (problems.length) throw new NavigationLayoutInvalid(problems);
  return out;
}

/** Counts per kind and added/removed ids — what the audit log records (never labels, links or record ids). */
export function summariseChange(before: NavigationItem[], after: NavigationItem[]) {
  const b = new Set(before.map((s) => s.id));
  const a = new Set(after.map((s) => s.id));
  const byKind = Object.fromEntries(ITEM_KINDS.map((k) => [k, after.filter((s) => s.kind === k).length]));
  return { items: after.length, byKind, added: [...a].filter((id) => !b.has(id)).length, removed: [...b].filter((id) => !a.has(id)).length };
}
