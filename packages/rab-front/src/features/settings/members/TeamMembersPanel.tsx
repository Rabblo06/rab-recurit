import { useEffect, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { EmptyState, TableSkeleton } from '../../../shared/components/LoadingState';
import { TableSearchInput } from '../../../shared/table-toolbar/TableToolbar';

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

  return <>
    <div className="member-section-heading"><h3>Manage members</h3><p>The people in your workspace and their roles. Recruitment staff and venue managers are managed in Users.</p></div>
    <div className="members-toolbar"><TableSearchInput value={search} onChange={setSearch} />{action}</div>
    {members.isError ? (
      <p role="alert" className="member-error">Members could not be loaded. <button className="btn btn-outline" onClick={() => members.refetch()}>Retry</button></p>
    ) : members.isLoading ? <TableSkeleton columns={4} /> : (
      <div className="members-table-wrap">
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
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
                <td>{memberRoleLabel(m)}</td>
                <td><span className={`badge badge-${status.tone}`}>{status.label}</span></td>
              </tr>;
            })}
            {!members.data!.data.length && <tr><td colSpan={4}><EmptyState compact variant="members" title={debounced ? 'No members match your search' : 'Your team starts here'} description="Invite a member to start working together." /></td></tr>}
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
