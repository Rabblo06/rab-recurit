import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconBriefcase, IconBuilding, IconCalendar, IconClipboard, IconEye, IconKey, IconShield, IconStar, IconUser, IconUsers,
} from '@tabler/icons-react';
import { toast } from '../../../shared/lib/toast';
import { DetailSkeleton } from '../../../shared/components/LoadingState';
import {
  apiError, assertSavedRole, draftFromDefinition, EMPTY_DRAFT, ObjectMetadata, RoleDefinition, RoleDraft, roleApi, SavedRoleResponseError,
} from './roleEditorModel';
import './role-editor.css';

export const ROLE_ICON_COMPONENTS: Record<string, typeof IconShield> = {
  shield: IconShield, user: IconUser, users: IconUsers, briefcase: IconBriefcase, calendar: IconCalendar,
  building: IconBuilding, eye: IconEye, star: IconStar, clipboard: IconClipboard, key: IconKey,
};

export function RoleIcon({ name, size = 18 }: { name: string | null | undefined; size?: number }) {
  const Icon = ROLE_ICON_COMPONENTS[name ?? 'shield'] ?? IconShield;
  return <Icon size={size} stroke={1.6} aria-hidden="true" />;
}

interface RoleEditorContextValue {
  roleId: string | null;
  basePath: string;
  metadata: ObjectMetadata;
  definition: RoleDefinition | null;
  /** System roles (and roles of other kinds) are shown read-only — the server refuses edits anyway. */
  readOnly: boolean;
  draft: RoleDraft;
  setDraft: (update: (draft: RoleDraft) => RoleDraft) => void;
  dirty: boolean;
  /** Leave the editor, asking first when there are unsaved changes. */
  leave: () => void;
}

const RoleEditorContext = createContext<RoleEditorContextValue | null>(null);

export function useRoleEditor(): RoleEditorContextValue {
  const value = useContext(RoleEditorContext);
  if (!value) throw new Error('useRoleEditor must be used inside RoleEditorLayout');
  return value;
}

export const ROLES_LIST_PATH = '/settings/workspace/members?tab=roles';

/** The shell owns the header slot; the feature supplies its current draft name and guarded navigation. */
function RoleBreadcrumb({ name, leave }: { name: string; leave: (path?: string) => void }) {
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => { setHost(document.querySelector('[data-role-breadcrumb-slot]')); }, []);
  const trail = <nav className="role-editor-breadcrumb" aria-label="Breadcrumb">
    {[
      ['Workspace', '/settings/my-workspace'],
      ['Members', '/settings/workspace/members'],
      ['Roles', ROLES_LIST_PATH],
    ].map(([label, path]) => <span className="role-crumb-part" key={label}>
      <a href={path} onClick={(event) => { event.preventDefault(); leave(path); }}>{label}</a>
      <span aria-hidden="true">/</span>
    </span>)}
    <span aria-current="page" title={name}>{name}</span>
  </nav>;
  return host ? createPortal(trail, host) : trail;
}

/**
 * Why a role (or the editor's metadata) could not be loaded. Each case gets its own message — the original
 * "This role could not be opened" screen hid a missing server route (stale backend build) behind a generic "deleted
 * or no access" text. 404 = not found or not in this workspace (never distinguished, by design); 401/403 = no access;
 * anything else (network, 5xx, 429) = temporary, with Retry.
 */
export type LoadFailure = 'not-found' | 'forbidden' | 'unavailable';
export function classifyLoadFailure(error: unknown): LoadFailure {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  if (status === 404 || status === 400) return 'not-found';
  if (status === 401 || status === 403) return 'forbidden';
  return 'unavailable';
}

function RoleLoadError({ failure, onRetry }: { failure: LoadFailure; onRetry: () => void }) {
  const copy: Record<LoadFailure, { title: string; body: string }> = {
    'not-found': { title: 'Role not found', body: 'This role doesn’t exist in your workspace. It may have been deleted.' },
    forbidden: { title: 'You don’t have access to roles', body: 'Ask your workspace owner if you need to manage roles.' },
    unavailable: { title: 'We couldn’t load this role', body: 'Something went wrong on our side or the connection dropped. Your roles are unchanged.' },
  };
  return (
    <div className="role-editor role-editor-state">
      <h2>{copy[failure].title}</h2>
      <p role="alert" className="feedback-error">{copy[failure].body}</p>
      <div className="role-editor-state-actions">
        {failure === 'unavailable' && <button type="button" className="btn btn-dark" onClick={onRetry}>Retry</button>}
        <Link className="btn btn-outline" to={ROLES_LIST_PATH}>Back to roles</Link>
      </div>
    </div>
  );
}

/** The role name as a heading; click (or Enter/Space) to edit inline. Enter keeps the draft, Escape restores it. */
function EditableRoleTitle({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const before = useRef(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const label = value.trim() || 'Untitled role';
  if (readOnly) return <h1 className="role-title">{label}</h1>;
  if (!editing) {
    return (
      <h1 className="role-title">
        <button
          type="button"
          className="role-title-button"
          aria-label={`Role name: ${label}. Click to rename.`}
          onClick={() => {
            before.current = value;
            setEditing(true);
          }}
        >
          {label}
        </button>
      </h1>
    );
  }
  return (
    <input
      ref={input}
      autoFocus
      className="role-title-input"
      aria-label="Role name"
      maxLength={80}
      value={value}
      placeholder="Untitled role"
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          setEditing(false);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onChange(before.current);
          setEditing(false);
        }
      }}
    />
  );
}

/**
 * Settings → Members → Roles → [Role]: a full-page editor whose draft lives here and is shared by the main view
 * (Permissions | Settings) and the two-step "Add rule" wizard (nested routes), so moving between steps never loses
 * work. Nothing is saved until Save, and Save sends the whole definition at once — the server applies it in one
 * transaction or not at all.
 */
export default function RoleEditorLayout() {
  const { roleId: param } = useParams();
  const roleId = param && param !== 'new' ? param : null;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const basePath = `/settings/workspace/members/roles/${param ?? 'new'}`;
  const mounted = useRef(false);
  const activeRole = useRef(roleId);
  activeRole.current = roleId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const metadata = useQuery({ queryKey: ['roles', 'object-metadata'], queryFn: roleApi.metadata, staleTime: 300_000 });
  const definition = useQuery({ queryKey: ['roles', 'definition', roleId], queryFn: () => roleApi.definition(roleId!), enabled: !!roleId });

  const [baseline, setBaseline] = useState<RoleDraft | null>(roleId ? null : EMPTY_DRAFT);
  const [draft, setDraftState] = useState<RoleDraft>(EMPTY_DRAFT);
  /** Which role the current draft belongs to ('new' for an unsaved role) — a different role reloads it. */
  const [loadedFor, setLoadedFor] = useState<string>(roleId ?? 'new');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const target = roleId ?? 'new';
    if (target === loadedFor && baseline !== null) return;
    if (!roleId) {
      setBaseline(EMPTY_DRAFT);
      setDraftState(EMPTY_DRAFT);
      setLoadedFor('new');
    } else if (definition.data && definition.data.id === roleId) {
      const loaded = draftFromDefinition(definition.data);
      setBaseline(loaded);
      setDraftState(loaded);
      setLoadedFor(roleId);
    }
  }, [definition.data, roleId, baseline, loadedFor]);

  const dirty = useMemo(() => baseline !== null && JSON.stringify(baseline) !== JSON.stringify(draft), [baseline, draft]);

  // Unsaved changes survive in-editor navigation (shared draft) but a reload / tab close asks first.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const readOnly = !!definition.data && !definition.data.isMemberRole;

  const save = useMutation({
    mutationFn: async ({ id, changes }: { id: string | null; changes: RoleDraft }) => {
      const saved = await (id ? roleApi.update(id, changes) : roleApi.create(changes));
      assertSavedRole(saved, id);
      return saved;
    },
    onSuccess: async (saved, { id }) => {
      qc.setQueryData(['roles', 'definition', saved.id], saved);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['roles'], refetchType: 'all' }),
        qc.invalidateQueries({ queryKey: ['member-invitations', 'assignable-roles'], refetchType: 'all' }),
      ]);
      // A slow request must not pull someone back into Members after they have already left it.
      if (!mounted.current || activeRole.current !== id) return;
      const loaded = draftFromDefinition(saved);
      setBaseline(loaded);
      setDraftState(loaded);
      setLoadedFor(saved.id);
      setSaveError(null);
      toast.success(id ? 'Role saved.' : 'Role created.');
      navigate(ROLES_LIST_PATH, { replace: true });
    },
    onError: (err, { id }) => {
      if (mounted.current && activeRole.current === id) setSaveError(err instanceof SavedRoleResponseError ? err.message : apiError(err, 'This role could not be saved. Check the highlighted settings and try again.'));
    },
  });

  const leave = (path = ROLES_LIST_PATH) => {
    if (save.isPending) return;
    if (dirty && !window.confirm('Discard your unsaved changes to this role?')) return;
    navigate(path);
  };
  const breadcrumb = <RoleBreadcrumb name={draft.name.trim() || (roleId ? definition.data?.name || 'Role' : 'Untitled role')} leave={leave} />;

  if (metadata.isLoading || (roleId && definition.isLoading)) {
    return <div className="role-editor">{breadcrumb}<DetailSkeleton /></div>;
  }
  if (metadata.isError || definition.isError || (roleId && !definition.data)) {
    const failure = classifyLoadFailure(definition.error ?? metadata.error);
    return (
      <>{breadcrumb}<RoleLoadError
        failure={failure}
        onRetry={() => {
          void metadata.refetch();
          if (roleId) void definition.refetch();
        }}
      /></>
    );
  }

  const nameMissing = !draft.name.trim();
  const value: RoleEditorContextValue = {
    roleId,
    basePath,
    metadata: metadata.data!,
    definition: definition.data ?? null,
    readOnly: readOnly || save.isPending,
    draft,
    setDraft: (update) => {
      setSaveError(null);
      setDraftState((current) => update(current));
    },
    dirty,
    leave,
  };

  return (
    <RoleEditorContext.Provider value={value}>
      <div className="role-editor">
        <header className="role-editor-topbar">
          {breadcrumb}
          <div className="role-editor-actions">
            <button type="button" className="btn btn-outline" disabled={save.isPending} onClick={() => leave()}>{readOnly ? 'Close' : 'Cancel'}</button>
            {!readOnly && (
              <button
                type="button"
                className="btn btn-dark role-editor-save"
                disabled={save.isPending || nameMissing || (!!roleId && !dirty)}
                onClick={() => save.mutate({ id: roleId, changes: draft })}
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        </header>
        <div className="role-editor-body" aria-busy={save.isPending}>
        <EditableRoleTitle value={draft.name} readOnly={readOnly || save.isPending} onChange={(name) => value.setDraft((d) => ({ ...d, name }))} />
        {readOnly && (
          <p className="role-editor-notice" role="note">
            System roles apply to the whole organisation and are read-only here. Create a custom role to give workspace members access.
          </p>
        )}
        {saveError && <div role="alert" className="role-editor-error feedback-error">{saveError}</div>}
        {!readOnly && nameMissing && dirty && <p className="role-editor-hint feedback-error">Enter a role name before saving.</p>}
        <Outlet />
        </div>
      </div>
    </RoleEditorContext.Provider>
  );
}
