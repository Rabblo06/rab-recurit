import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconChevronRight, IconUser, IconShield, IconUpload, IconTrash } from '@tabler/icons-react';
import MemberPermissionSummary from './MemberPermissionSummary';
import Avatar from '../../../shared/components/Avatar';
import MembersBreadcrumb from './MembersBreadcrumb';
import StaffSelect from '../../users/StaffSelect';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { api } from '../../../shared/api';
import { getApiErrorMessage } from '../../../shared/lib/apiError';
import { toast } from '../../../shared/lib/toast';
import { TableSkeleton } from '../../../shared/components/LoadingState';
import { TableSearchInput } from '../../../shared/table-toolbar/TableToolbar';
import './team-members.css';

export interface MemberListItem {
  userId: string;
  accountId?: string;
  directoryKind?: string;
  organisationName?: string;
  firstName: string;
  lastName: string;
  email: string;
  roles: Array<{ id: string; name: string; isMemberRole: boolean }>;
  status: 'active' | 'pending_setup' | 'suspended' | 'inactive' | 'invited' | 'expired';
  isOwner: boolean;
  isSelf: boolean;
}

const PAGE_SIZE = 25;

export function memberRoleLabel(m: Pick<MemberListItem, 'roles' | 'isOwner'>): string {
  if (m.roles.length) return m.roles.map((r) => r.name).join(', ');
  return m.isOwner ? 'Workspace owner' : '—';
}

/** Account or outstanding invitation state in the admin directory. */
export function memberStatus(m: Pick<MemberListItem, 'status'>): { label: string; tone: 'active' | 'pending' | 'inactive' } {
  switch (m.status) {
    case 'active':
      return { label: 'Active', tone: 'active' };
    case 'invited': return { label: 'Invited', tone: 'pending' };
    case 'expired': return { label: 'Invitation expired', tone: 'inactive' };
    case 'pending_setup':
      return { label: 'Not signed in yet', tone: 'pending' };
    case 'suspended':
      return { label: 'Suspended', tone: 'inactive' };
    default:
      return { label: 'Inactive', tone: 'inactive' };
  }
}

/** Name if the person has set one, otherwise their email (profile setup incomplete). */
export function memberDisplayName(m: Pick<MemberListItem, 'firstName' | 'lastName' | 'email'>): string {
  return `${m.firstName} ${m.lastName}`.trim() || m.email;
}

/** Only invited workspace members (custom roles only) are managed here — never the owner, yourself, or leadership. */
export function isManageableMember(m: Pick<MemberListItem, 'roles' | 'isOwner' | 'isSelf'>): boolean {
  return !m.isOwner && !m.isSelf && m.roles.length > 0 && m.roles.every((r) => r.isMemberRole);
}

/** Platform-wide directory for administrators; names and emails within the current workspace for everyone else. */
export default function TeamMembersPanel({ action, onDetailChange, platformAdmin = false, identity = "" }: { action: React.ReactNode; onDetailChange?: (open: boolean) => void; platformAdmin?: boolean; identity?: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { onDetailChange?.(selectedId !== null); return () => onDetailChange?.(false); }, [selectedId, onDetailChange]);
  const [detailTab, setDetailTab] = useState<'info' | 'permissions'>('info');
  const [suspendTarget, setSuspendTarget] = useState<MemberListItem | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const id = setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(id);
  }, [search]);
  const members = useQuery<{ data: MemberListItem[]; total: number }>({
    queryKey: ['members', identity, platformAdmin, debounced, page],
    // The workspace member list (GET /members, role.view). The new UI's directories (members/directory, admin/users/
    // directory) need the AdminMemberDirectory SQL, which is a follow-up PR; until then every viewer sees this list.
    queryFn: async () => (await api.get<{ data: MemberListItem[]; total: number }>(`/members?page=${page}&limit=${PAGE_SIZE}${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`)).data,
  });
  const totalPages = Math.max(1, Math.ceil((members.data?.total ?? 0) / PAGE_SIZE));
  const qc = useQueryClient();
  const manageable = platformAdmin && (members.data?.data ?? []).some(isManageableMember);
  const assignable = useQuery({
    queryKey: ['member-invitations', 'assignable-roles'],
    queryFn: async () => (await api.get<Array<{ id: string; name: string }>>('/member-invitations/assignable-roles')).data,
    enabled: manageable,
  });
  // Results are temporary: a green success toast or a red error toast (shared/lib/toast).
  const memberAction = useMutation({
    mutationFn: async (action: { kind: 'role'; userId: string; roleId: string } | { kind: 'suspend' | 'reinstate'; userId: string }) => {
      if (action.kind === 'role') await api.patch(`/members/${action.userId}/role`, { roleId: action.roleId });
      else await api.post(`/members/${action.userId}/${action.kind}`, {});
      return action;
    },
    onSuccess: (action) => {
      toast.success(action.kind === 'role' ? 'Role updated. It applies on their next action.' : action.kind === 'suspend' ? 'Member suspended.' : 'Member reinstated.');
      void qc.invalidateQueries({ queryKey: ['members'] });
      void qc.invalidateQueries({ queryKey: ['roles'] });
    },
    onError: (err) => toast.error(getApiErrorMessage(err, 'That change could not be made. Try again.')),
  });

  const selected = members.data?.data.find(member => member.userId === selectedId);
  const summary = useQuery({
    queryKey: ['admin-member-summary', identity, selected?.accountId],
    queryFn: async () => (await api.get<{ roles: string[] }>(`/admin/users/${selected!.accountId}/summary`)).data,
    enabled: platformAdmin && !!selected?.accountId,
  });
  if (platformAdmin && selected) return <section className="member-detail">
    <MembersBreadcrumb current={memberDisplayName(selected)} onMembers={() => setSelectedId(null)} />

    <nav className="member-tabs" aria-label="Member details">
      <button type="button" className={detailTab === 'info' ? 'active' : ''} onClick={() => setDetailTab('info')}><IconUser size={14} />Infos</button>
      <button type="button" className={detailTab === 'permissions' ? 'active' : ''} onClick={() => setDetailTab('permissions')}><IconShield size={14} />Permissions</button>
    </nav>
    {detailTab === 'info' ? <>
      <section className="member-picture-section" aria-label="Picture">
        <div className="member-section-heading"><h3>Picture</h3></div>
        <div className="member-picture-row"><Avatar label={memberDisplayName(selected)} variant="panel" />
          <div><div className="member-detail-actions"><button className="btn btn-outline" disabled title="Member picture editing is not available"><IconUpload size={14} />Upload</button><button className="btn btn-outline" disabled title="Member picture editing is not available"><IconTrash size={14} />Remove</button></div><p className="role-footnote">Member picture editing is not available here.</p></div>
        </div>
      </section>
      <div className="member-section-heading"><h3>Name</h3><p>The member’s current profile information.</p></div>
      <div className="member-info-grid"><label>First name<input className="form-input" value={selected.firstName} readOnly /></label><label>Last name<input className="form-input" value={selected.lastName} readOnly /></label></div>
      <label className="member-info-email">Email<span className="member-field-description">The email associated with their account.</span><input className="form-input" value={selected.email} readOnly /></label>
      <div className="member-section-heading"><h3>Admin</h3><p>{memberStatus(selected).label}{selected.organisationName ? ` · ${selected.organisationName}` : ""}</p></div>
      <div className="member-detail-actions">                    {isManageableMember(selected) && (
                      <button
                        type="button"
                        className="btn btn-outline"
                        disabled={memberAction.isPending}
                        onClick={() => {
                          const kind = selected.status === 'suspended' ? 'reinstate' : 'suspend';
                          if (kind === 'suspend') { setSuspendTarget(selected); return; }
                          memberAction.mutate({ kind, userId: selected.userId });
                        }}
                      >
                        {selected.status === 'suspended' ? 'Reinstate' : 'Suspend'}
                      </button>
                    )}</div>
      <p className="role-footnote">Profile editing and permanent deletion are unavailable here.</p>
    </> : <>
      <div className="member-section-heading"><h3>Role</h3><p>Access is determined by these existing workspace roles.</p></div>
      {selected.roles.map(role => <Link key={role.id} className="member-role-card" to={`/settings/workspace/members/roles/${role.id}`}><IconShield size={16} />{role.name}<IconChevronRight size={14} /></Link>)}
      {!selected.roles.length && <p>{memberRoleLabel(selected)}</p>}
      {isManageableMember(selected) && <div className="member-role-editor"><h3>Change role</h3>                  {isManageableMember(selected) && assignable.data?.length ? (
                    <StaffSelect label={`Role for ${memberDisplayName(selected)}`} placeholder={memberRoleLabel(selected)} compact
                      value={selected.roles.length === 1 ? selected.roles[0]!.id : ''} disabled={memberAction.isPending}
                      options={[...selected.roles.filter(role => !assignable.data!.some(item => item.id === role.id)), ...assignable.data].map(role => ({ value: role.id, label: role.name }))}
                      onChange={roleId => { if (roleId) memberAction.mutate({ kind: 'role', userId: selected.userId, roleId }); }} />
                  ) : memberRoleLabel(selected)}
      </div>}
      {selected.directoryKind ? <p role="status">{!selected.accountId ? 'This invitation has not been accepted yet.' : summary.isError ? 'Permissions could not be loaded.' : summary.isLoading ? 'Loading roles…' : summary.data?.roles.join(', ') || 'No assigned roles'}</p> : <MemberPermissionSummary roles={selected.roles} />}
      <p className="role-footnote">Open a role to inspect its permissions. Member-specific sharing and permission overrides are unavailable.</p>
    </>}
    <ConfirmDialog open={!!suspendTarget} title="Suspend member?" description="They will lose access to this workspace until reinstated." confirmLabel="Suspend member" destructive loading={memberAction.isPending} onCancel={() => setSuspendTarget(null)} onConfirm={() => { if (suspendTarget) memberAction.mutate({ kind: 'suspend', userId: suspendTarget.userId }, { onSuccess: () => setSuspendTarget(null) }); }} />
  </section>;

  return <>
    <MembersBreadcrumb />
    <div className="member-section-heading"><h3>Members</h3><p>Members of your workspace.</p></div>
    <div className="members-toolbar"><TableSearchInput value={search} onChange={setSearch} placeholder="Search a team member..." />{action}</div>
    {members.isError ? (
      <p role="alert" className="member-error">Members could not be loaded. <button className="btn btn-outline" onClick={() => members.refetch()}>Retry</button></p>
    ) : members.isLoading ? <TableSkeleton columns={2} /> : (
      <div className="members-table-wrap">
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th></tr></thead>
          <tbody>
            {members.data!.data.map((m) => {
              const status = memberStatus(m);
              const name = memberDisplayName(m);
              return <tr key={m.userId}>
                <td>
                  <button type="button" className="member-name member-name-button" disabled={!platformAdmin} onClick={() => { setSelectedId(m.userId); setDetailTab('info'); }}>
                    <span className="mini-avatar" aria-hidden="true">{(m.firstName?.[0] ?? m.email[0] ?? '').toUpperCase()}{m.lastName?.[0] ?? ''}</span>
                    <span className="member-name-label" title={name}>{name}</span>{m.isSelf && <span className="cell-muted"> (you)</span>}
                  </button>{platformAdmin && <span className="member-row-meta visually-hidden">{status.label}</span>}
                </td>
                <td className="cell-muted"><button type="button" className="member-email-button" disabled={!platformAdmin} aria-label={`Open ${name}`} onClick={() => { setSelectedId(m.userId); setDetailTab('info'); }}><span className="member-email-label" title={m.email}>{m.email}</span>{platformAdmin && <IconChevronRight size={13} aria-hidden="true" />}</button></td>

              </tr>;
            })}
            {!members.data!.data.length && <tr><td colSpan={2}><span className="member-empty-row">{debounced ? 'No members match your search' : 'No members yet. Invite your first teammate below.'}</span></td></tr>}
          </tbody>
        </table>
      </div>
    )}
    <ConfirmDialog open={!!suspendTarget} title="Suspend member?" description="They will lose access to this workspace until reinstated." confirmLabel="Suspend member" destructive loading={memberAction.isPending} onCancel={() => setSuspendTarget(null)} onConfirm={() => { if (suspendTarget) memberAction.mutate({ kind: 'suspend', userId: suspendTarget.userId }, { onSuccess: () => setSuspendTarget(null) }); }} />
    {totalPages > 1 && (
      <div className="invitations-pager">
        <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
        <span className="cell-muted">Page {page} of {totalPages} · {members.data?.total} members</span>
        <button className="btn btn-outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    )}
  </>;
}
