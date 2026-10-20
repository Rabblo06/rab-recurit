/**
 * Personal sidebar shortcuts (Operations "+" → Add menu item). NAVIGATION ONLY: a shortcut is a pointer to something that
 * already exists — never a new entity, view definition, permission or page. Opening one goes through the normal route, so
 * the server re-checks access every time; adding or removing a shortcut grants or deletes nothing.
 *
 * Persistence: device-local (`localStorage`), namespaced by the signed-in user id AND workspace id, so another account or
 * workspace on the same browser never sees them. There is no server-side preference for navigation today; making these
 * sync across devices would need an approved schema/permission change. Nothing secret is stored — labels and paths only.
 */

export type ShortcutKind = 'object' | 'view' | 'record' | 'folder' | 'link';
export type ShortcutIcon = 'object' | 'view' | 'person' | 'venue' | 'shift' | 'offer' | 'folder' | 'link' | 'star' | 'bolt';

export interface Shortcut {
  id: string;
  kind: ShortcutKind;
  label: string;
  icon: ShortcutIcon;
  /** object/view: registry key; record: `${type}:${id}`; link: the validated destination. Folders have none. */
  target?: string;
  /** Folder this item sits in (one level of folders keeps the tree acyclic by construction). */
  parentId?: string | null;
}

/** Existing pages a shortcut may point at (Object). `audit` is only offered/shown to roles that hold it by default. */
export const OBJECTS: Record<string, { label: string; to: string; icon: ShortcutIcon; requires?: 'audit' }> = {
  users: { label: 'Users', to: '/users', icon: 'person' },
  shifts: { label: 'Shifts', to: '/shifts', icon: 'shift' },
  offers: { label: 'Offers', to: '/offers', icon: 'offer' },
  payroll: { label: 'Payroll', to: '/payroll', icon: 'object' },
  calendar: { label: 'Calendar', to: '/calendar', icon: 'object' },
  venues: { label: 'Venues', to: '/venues', icon: 'venue' },
  'venue-offers': { label: 'Venue Offers', to: '/venue-offers', icon: 'offer' },
  audit: { label: 'Audit Log', to: '/audit', icon: 'object', requires: 'audit' },
  help: { label: 'Help Center', to: '/help', icon: 'object' },
};

/**
 * Supported filtered views (View) — exactly the filters the list pages already put in their URL (useTableQueryState).
 * Stored by key, never as a free-form query string. `to` is computed when opened (Upcoming = from today).
 */
export const VIEWS: Record<string, { label: string; object: string; to: () => string }> = {
  'shifts-upcoming': { label: 'Shifts · Upcoming', object: 'shifts', to: () => `/shifts?startsAtFrom=${new Date().toLocaleDateString('sv-SE')}` },
  'shifts-completed': { label: 'Shifts · Completed', object: 'shifts', to: () => '/shifts?status=completed' },
  'offers-pending': { label: 'Offers · Pending', object: 'offers', to: () => '/offers?status=pending' },
  'offers-accepted': { label: 'Offers · Staff accepted', object: 'offers', to: () => '/offers?status=staff_accepted' },
  'offers-confirmed': { label: 'Offers · Manager confirmed', object: 'offers', to: () => '/offers?status=manager_confirmed' },
  'offers-expired': { label: 'Offers · Expired', object: 'offers', to: () => '/offers?status=expired' },
  'payroll-active': { label: 'Payroll · In progress', object: 'payroll', to: () => '/payroll?status=active' },
  'payroll-completed': { label: 'Payroll · Completed', object: 'payroll', to: () => '/payroll?status=completed' },
  'venues-active': { label: 'Venues · Active', object: 'venues', to: () => '/venues?status=active' },
  'venues-archived': { label: 'Venues · Archived', object: 'venues', to: () => '/venues?status=archived' },
};

/** First path segments that are real Crewflow pages (internal Link validation). */
const INTERNAL_ROOTS = new Set(['', 'users', 'shifts', 'offers', 'venue-offers', 'calendar', 'payroll', 'venues', 'audit', 'settings', 'help', 'support', 'chat']);

export type LinkCheck = { ok: true; kind: 'internal'; to: string } | { ok: true; kind: 'external'; href: string } | { ok: false; error: string };

/**
 * Link shortcuts accept only (a) an internal Crewflow path, or (b) an https:// URL with no embedded credentials.
 * Everything else — javascript:, data:, file:, http:, protocol-relative //host, back-slashes, control characters — is refused.
 */
export function validateLink(raw: string): LinkCheck {
  const value = raw.trim();
  if (!value) return { ok: false, error: 'Enter a Crewflow path such as /shifts, or an https:// address.' };
  if (value.length > 2000) return { ok: false, error: 'That address is too long.' };
  if (/[\u0000-\u001f\u007f\\<>"'`\s]/.test(value)) return { ok: false, error: 'That address contains characters that are not allowed.' };
  if (value.startsWith('/')) {
    if (value.startsWith('//')) return { ok: false, error: 'Use a full https:// address for other sites.' };
    const root = value.slice(1).split(/[/?#]/)[0] ?? '';
    if (!INTERNAL_ROOTS.has(root)) return { ok: false, error: 'That is not a page in Crewflow.' };
    return { ok: true, kind: 'internal', to: value };
  }
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, error: 'Enter a Crewflow path such as /shifts, or an https:// address.' }; }
  if (url.protocol !== 'https:') return { ok: false, error: 'Only https:// links are allowed.' };
  if (url.username || url.password) return { ok: false, error: 'Links must not contain a user name or password.' };
  if (!url.hostname || !url.hostname.includes('.')) return { ok: false, error: 'Enter a complete web address.' };
  return { ok: true, kind: 'external', href: url.toString() };
}

const ICONS: ShortcutIcon[] = ['object', 'view', 'person', 'venue', 'shift', 'offer', 'folder', 'link', 'star', 'bolt'];
export const PICKABLE_ICONS: ShortcutIcon[] = ['star', 'bolt', 'object', 'view', 'person', 'venue', 'shift', 'offer', 'link'];
const KINDS: ShortcutKind[] = ['object', 'view', 'record', 'folder', 'link'];
const RECORD_TYPES = new Set(['Staff', 'Manager', 'Venue', 'Shift', 'Offer']);
export const MAX_SHORTCUTS = 40;

/** Storage key: per signed-in user AND workspace. `null` (no identity yet) means nothing is read or written. */
export function storageKey(userId: string | null, workspaceId: string | null | undefined): string | null {
  return userId ? `crewflow.nav.shortcuts.v1:${userId}:${workspaceId ?? 'none'}` : null;
}

/** Parses stored shortcuts defensively: anything malformed, unknown or unsafe is dropped, never trusted. */
export function parseShortcuts(raw: string | null): Shortcut[] {
  let data: unknown;
  try { data = JSON.parse(raw ?? '[]'); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out: Shortcut[] = [];
  const folders = new Set<string>();
  for (const item of data.slice(0, MAX_SHORTCUTS)) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.id !== 'string' || !KINDS.includes(s.kind as ShortcutKind) || typeof s.label !== 'string' || !s.label.trim()) continue;
    const icon = ICONS.includes(s.icon as ShortcutIcon) ? (s.icon as ShortcutIcon) : 'object';
    const base = { id: s.id, kind: s.kind as ShortcutKind, label: s.label.slice(0, 60), icon };
    if (s.kind === 'folder') { folders.add(s.id); out.push({ ...base, parentId: null }); continue; }
    const target = typeof s.target === 'string' ? s.target : '';
    if (s.kind === 'object' && !OBJECTS[target]) continue;
    if (s.kind === 'view' && !VIEWS[target]) continue;
    if (s.kind === 'record') { const [type, id] = target.split(':'); if (!RECORD_TYPES.has(type ?? '') || !id || !/^[\w-]{1,64}$/.test(id)) continue; }
    if (s.kind === 'link' && !validateLink(target).ok) continue;
    out.push({ ...base, target, parentId: typeof s.parentId === 'string' ? s.parentId : null });
  }
  // A parent must be an existing folder; otherwise the item returns to the top level (no dangling or cyclic links).
  return out.map((s) => (s.parentId && !folders.has(s.parentId) ? { ...s, parentId: null } : s));
}

/** Same destination twice is refused (folders are compared by name within their level). */
export function isDuplicate(list: Shortcut[], candidate: Pick<Shortcut, 'kind' | 'target' | 'label' | 'parentId'>): boolean {
  if (candidate.kind === 'folder') return list.some((s) => s.kind === 'folder' && s.label.trim().toLowerCase() === candidate.label.trim().toLowerCase());
  return list.some((s) => s.kind === candidate.kind && s.target === candidate.target);
}
