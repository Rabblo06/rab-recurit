import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { EmptyState, TableSkeleton } from '../../../shared/components/LoadingState';
import { TableSearchInput } from '../../../shared/table-toolbar/TableToolbar';
import './team-members.css';

export interface MemberListItem {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  roles: Array<{ id: string; name: string; isMemberRole: boolean }>;
  status: 'active' | 'pending_setup' | 'suspended' | 'inactive';
  isOwner: boolean;
  isSelf: boolean;
}

const PAGE_SIZE = 25;

export function memberRoleLabel(m: Pick<MemberListItem, 'roles' | 'isOwner'>): string {
  if (m.roles.length) return m.roles.map((r) => r.name).join(', ');
  return m.isOwner ? 'Workspace owner' : '—';
}

/** Membership / account state (invitations are shown in the Invite tab, never here). */
export function memberStatus(m: Pick<MemberListItem, 'status'>): { label: string; tone: 'active' | 'pending' | 'inactive' } {
  switch (m.status) {
    case 'active':
      return { label: 'Active', tone: 'active' };
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

function errorText(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof message === 'string' && message ? message : fallback;
}

/**
 * Settings → Members → Team: the real members of this workspace (`GET /members` — workspace memberships, owner and
 * invited workspace members), server-paginated and searched. Recruitment Staff and Venue Managers are managed on the
 * Users page and are not listed here.
 */
export default function TeamMembersPanel({ action }: { action: React.ReactNode }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const id = setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(id);
  }, [search]);
  const members = useQuery({
    queryKey: ['members', debounced, page],
    queryFn: async () => (await api.get<{ data: MemberListItem[]; total: number }>(`/members?page=${page}&limit=${PAGE_SIZE}${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`)).data,
    placeholderData: keepPreviousData,
  });
  const totalPages = Math.max(1, Math.ceil((members.data?.total ?? 0) / PAGE_SIZE));
  const qc = useQueryClient();
  const manageable = (members.data?.data ?? []).some(isManageableMember);
  const assignable = useQuery({
    queryKey: ['member-invitations', 'assignable-roles'],
    queryFn: async () => (await api.get<Array<{ id: string; name: string }>>('/member-invitations/assignable-roles')).data,
    enabled: manageable,
  });
  // Results are announced next to the table: success in green, errors in red (feedback-* classes only).
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const memberAction = useMutation({
    mutationFn: async (action: { kind: 'role'; userId: string; roleId: string } | { kind: 'suspend' | 'reinstate'; userId: string }) => {
      if (action.kind === 'role') await api.patch(`/members/${action.userId}/role`, { roleId: action.roleId });
      else await api.post(`/members/${action.userId}/${action.kind}`, {});
      return action;
    },
    onSuccess: (action) => {
      setFeedback({ tone: 'success', text: action.kind === 'role' ? 'Role updated. It applies on their next action.' : action.kind === 'suspend' ? 'Member suspended.' : 'Member reinstated.' });
      void qc.invalidateQueries({ queryKey: ['members'] });
      void qc.invalidateQueries({ queryKey: ['roles'] });
    },
    onError: (err) => setFeedback({ tone: 'error', text: errorText(err, 'That change could not be made. Try again.') }),
  });

  return <>
    <div className="member-section-heading"><h3>Manage members</h3><p>The people in your workspace and their roles. Recruitment staff and venue managers are managed in Users.</p></div>
    <div className="members-toolbar"><TableSearchInput value={search} onChange={setSearch} />{action}</div>
    {feedback && (
      <p role={feedback.tone === 'error' ? 'alert' : 'status'} className={`member-feedback feedback-${feedback.tone}`}>{feedback.text}</p>
    )}
    {members.isError ? (
      <p role="alert" className="member-error">Members could not be loaded. <button className="btn btn-outline" onClick={() => members.refetch()}>Retry</button></p>
    ) : members.isLoading ? <TableSkeleton columns={4} /> : (
      <div className="members-table-wrap">
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th>{manageable && <th><span className="sr-only">Actions</span></th>}</tr></thead>
          <tbody>
            {members.data!.data.map((m) => {
              const status = memberStatus(m);
              const name = memberDisplayName(m);
              return <tr key={m.userId}>
                <td>
                  <span className="member-name">
                    <span className="mini-avatar" aria-hidden="true">{(m.firstName?.[0] ?? m.email[0] ?? '').toUpperCase()}{m.lastName?.[0] ?? ''}</span>
                    {name}{m.isSelf && <span className="cell-muted"> (you)</span>}
                  </span>
                </td>
                <td className="cell-muted">{m.email}</td>
                <td>
                  {isManageableMember(m) && assignable.data?.length ? (
                    <select
                      className="form-input member-role-select"
                      aria-label={`Role for ${name}`}
                      value={m.roles.length === 1 ? m.roles[0]!.id : ''}
                      disabled={memberAction.isPending}
                      onChange={(e) => {
                        setFeedback(null);
                        if (e.target.value) memberAction.mutate({ kind: 'role', userId: m.userId, roleId: e.target.value });
                      }}
                    >
                      {m.roles.length !== 1 && <option value="">{memberRoleLabel(m)}</option>}
                      {m.roles.length === 1 && !assignable.data.some((r) => r.id === m.roles[0]!.id) && <option value={m.roles[0]!.id}>{m.roles[0]!.name}</option>}
                      {assignable.data.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  ) : memberRoleLabel(m)}
                </td>
                <td><span className={`badge badge-${status.tone}`}>{status.label}</span></td>
                {manageable && (
                  <td>
                    {isManageableMember(m) && (
                      <button
                        type="button"
                        className="btn btn-outline"
                        disabled={memberAction.isPending}
                        onClick={() => {
                          setFeedback(null);
                          const kind = m.status === 'suspended' ? 'reinstate' : 'suspend';
                          if (kind === 'suspend' && !window.confirm(`Suspend ${name}? They lose access to this workspace until reinstated.`)) return;
                          memberAction.mutate({ kind, userId: m.userId });
                        }}
                      >
                        {m.status === 'suspended' ? 'Reinstate' : 'Suspend'}
                      </button>
                    )}
                  </td>
                )}
              </tr>;
            })}
            {!members.data!.data.length && <tr><td colSpan={manageable ? 5 : 4}><EmptyState compact variant="members" title={debounced ? 'No members match your search' : 'Your team starts here'} description="Invite a member to start working together." /></td></tr>}
          </tbody>
        </table>
      </div>
    )}
    {totalPages > 1 && (
      <div className="invitations-pager">
        <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
        <span className="cell-muted">Page {page} of {totalPages} · {members.data?.total} members</span>
        <button className="btn btn-outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    )}
  </>;
}
