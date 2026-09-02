import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconSearch, IconUserOff, IconUserCheck, IconEye, IconKey, IconLock,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import { timeAgo } from '../../shared/lib/timeAgo';
import PageHeader from '../../shared/components/PageHeader';

interface PendingInvite {
  sendNumber: number;
  maxSendAttempts: number;
}

type InvitationStatus = 'pending' | 'cancelled' | 'expired' | null;

interface StaffRow {
  id: string;
  staffRef: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  employmentStatus: string;
  startDate: string | null;
  defaultPayRatePence: number;
  createdAt: string;
  accountStatus: string;
  invitationStatus: InvitationStatus;
  mustResetPassword: boolean;
  pendingInvite: PendingInvite | null;
}

interface ManagerRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  type: 'internal' | 'venue';
  jobTitle: string | null;
  createdAt: string;
  accountStatus: string;
  invitationStatus: InvitationStatus;
  mustResetPassword: boolean;
  pendingInvite: PendingInvite | null;
}

const avatarColors = [
  { bg: '#dbe9fe', color: '#1961ed' },
  { bg: '#d9f0de', color: '#2a8e44' },
  { bg: '#fdf2d4', color: '#946c00' },
  { bg: '#f1e6fd', color: '#7d3bc8' },
  { bg: '#fde2ef', color: '#c2185d' },
];
const getColor = (name: string) => avatarColors[(name?.charCodeAt(0) ?? 0) % avatarColors.length];

function openCreate(role: 'staff' | 'manager') {
  document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role } }));
}

function openDetail(id: string, type: 'staff' | 'manager') {
  document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id, type } }));
}

function PasswordStatusBadge({ mustResetPassword }: { mustResetPassword: boolean }) {
  return (
    <span className={`badge ${mustResetPassword ? 'badge-pending' : 'badge-active'}`}>
      <IconLock size={11} style={{ marginRight: 3, verticalAlign: -1 }} />
      {mustResetPassword ? 'Temporary' : 'Active'}
    </span>
  );
}

/**
 * Replaces the plain Active/Suspended status badge for an account still
 * somewhere in the invitation lifecycle (pending, cancelled, or expired —
 * never activated) — driven by `invitationStatus`, computed server-side from
 * the AccountInvite row, never conflated with an account state like
 * SUSPENDED/DEACTIVATED (see UserDetailPanel's identical comment).
 */
function AccountStatusBadge({ invitationStatus, accountStatus, pendingInvite }: { invitationStatus: InvitationStatus; accountStatus: string; pendingInvite: PendingInvite | null }) {
  if (invitationStatus === 'cancelled') return <span className="badge badge-inactive">Invitation cancelled</span>;
  if (invitationStatus === 'expired') return <span className="badge badge-inactive">{accountStatus === 'invite_expired' ? 'Expired — cleanup in 7d' : 'Invite expired'}</span>;
  if (invitationStatus === 'pending') {
    const n = pendingInvite?.sendNumber ?? 1;
    return <span className="badge badge-pending">{n >= 3 ? 'Final invite (3/3)' : `Pending invite (${n}/3)`}</span>;
  }
  return null;
}

function StaffTab({ search, onCount }: { search: string; onCount: (n: number) => void }) {
  const qc = useQueryClient();
  const { data: staff = [], isLoading } = useQuery({
    queryKey: ['staff'],
    queryFn: async () => { const { data } = await api.get<StaffRow[]>('/staff'); return data; },
  });

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.post(`/staff/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
  });

  const resetPassword = useMutation({
    mutationFn: (id: string) => api.post(`/staff/${id}/reset-password`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
  });

  const filtered = useMemo(() => staff.filter((s) => {
    const q = search.toLowerCase();
    return !q
      || `${s.firstName} ${s.lastName}`.toLowerCase().includes(q)
      || s.email.toLowerCase().includes(q)
      || s.staffRef.toLowerCase().includes(q);
  }), [staff, search]);

  useEffect(() => onCount(filtered.length), [filtered.length, onCount]);

  if (isLoading) return <TableSkeleton columns={9} />;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Ref</th>
          <th>Email</th>
          <th>Phone</th>
          <th>Rate</th>
          <th>Status</th>
          <th>Password</th>
          <th>Added</th>
          <th style={{ width: 76 }}/>
        </tr>
      </thead>
      <tbody>
        {filtered.map((s) => {
          const name = `${s.firstName} ${s.lastName}`;
          const c = getColor(name);
          const active = s.employmentStatus === 'active';
          return (
            <tr key={s.id}>
              <td>
                <span className="record-chip" style={{ cursor: 'pointer' }} onClick={() => openDetail(s.id, 'staff')}>
                  <span className="mini-avatar" style={{ background: c.bg, color: c.color }}>{name[0]}</span>
                  {name}
                </span>
              </td>
              <td className="cell-muted">{s.staffRef}</td>
              <td className="cell-muted">{s.email}</td>
              <td className="cell-muted">{s.phone ?? '–'}</td>
              <td className="cell-muted">{s.defaultPayRatePence ? `£${(s.defaultPayRatePence / 100).toFixed(2)}/hr` : '–'}</td>
              <td>
                {s.invitationStatus
                  ? <AccountStatusBadge invitationStatus={s.invitationStatus} accountStatus={s.accountStatus} pendingInvite={s.pendingInvite} />
                  : <span className={`badge badge-${active ? 'active' : 'inactive'}`}>{s.employmentStatus.replace(/_/g, ' ')}</span>}
              </td>
              <td>{s.invitationStatus ? '–' : <PasswordStatusBadge mustResetPassword={s.mustResetPassword}/>}</td>
              <td className="cell-muted">{timeAgo(s.createdAt)}</td>
              <td>
                <div className="row-actions">
                  <button className="btn-icon" title="View" onClick={() => openDetail(s.id, 'staff')}>
                    <IconEye size={14}/>
                  </button>
                  {!s.invitationStatus && (
                    <>
                      <button
                        className="btn-icon"
                        title="Reset password"
                        onClick={() => { if (confirm(`Reset ${name}'s password? They'll be emailed a new one-time setup link.`)) resetPassword.mutate(s.id); }}
                      >
                        <IconKey size={14}/>
                      </button>
                      <button
                        className={`btn-icon ${active ? 'danger' : 'success'}`}
                        title={active ? 'Deactivate' : 'Reactivate'}
                        onClick={() => setActive.mutate({ id: s.id, active: !active })}
                      >
                        {active ? <IconUserOff size={14}/> : <IconUserCheck size={14}/>}
                      </button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
        {filtered.length === 0 && (
          <tr><td colSpan={9}><EmptyState variant={search ? 'matches' : 'records'} title={search ? 'No staff found' : 'No staff members yet'} description={search ? 'Try a different name, email, or reference.' : 'Create a staff member to start building your workforce.'} /></td></tr>
        )}
      </tbody>
    </table>
  );
}

function ManagersTab({ search, onCount }: { search: string; onCount: (n: number) => void }) {
  const qc = useQueryClient();
  const { data: managers = [], isLoading } = useQuery({
    queryKey: ['managers'],
    queryFn: async () => { const { data } = await api.get<ManagerRow[]>('/managers'); return data; },
  });

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.post(`/managers/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['managers'] }),
  });

  const resetPassword = useMutation({
    mutationFn: (id: string) => api.post(`/managers/${id}/reset-password`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['managers'] }),
  });

  const filtered = useMemo(() => managers.filter((m) => {
    const q = search.toLowerCase();
    return !q
      || `${m.firstName} ${m.lastName}`.toLowerCase().includes(q)
      || m.email.toLowerCase().includes(q)
      || m.jobTitle?.toLowerCase().includes(q);
  }), [managers, search]);

  useEffect(() => onCount(filtered.length), [filtered.length, onCount]);

  if (isLoading) return <TableSkeleton columns={9} />;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Phone</th>
          <th>Job title</th>
          <th>Type</th>
          <th>Status</th>
          <th>Password</th>
          <th>Added</th>
          <th style={{ width: 76 }}/>
        </tr>
      </thead>
      <tbody>
        {filtered.map((m) => {
          const name = `${m.firstName} ${m.lastName}`;
          const c = getColor(name);
          const active = m.accountStatus === 'active';
          return (
            <tr key={m.id}>
              <td>
                <span className="record-chip" style={{ cursor: 'pointer' }} onClick={() => openDetail(m.id, 'manager')}>
                  <span className="mini-avatar" style={{ background: c.bg, color: c.color }}>{name[0]}</span>
                  {name}
                </span>
              </td>
              <td className="cell-muted">{m.email}</td>
              <td className="cell-muted">{m.phone ?? '–'}</td>
              <td className="cell-muted">{m.jobTitle ?? '–'}</td>
              <td><span className="badge badge-admin">{m.type === 'venue' ? 'Venue manager' : 'Manager'}</span></td>
              <td>
                {m.invitationStatus
                  ? <AccountStatusBadge invitationStatus={m.invitationStatus} accountStatus={m.accountStatus} pendingInvite={m.pendingInvite} />
                  : <span className={`badge badge-${active ? 'active' : 'inactive'}`}>{active ? 'Active' : 'Suspended'}</span>}
              </td>
              <td>{m.invitationStatus ? '–' : <PasswordStatusBadge mustResetPassword={m.mustResetPassword}/>}</td>
              <td className="cell-muted">{timeAgo(m.createdAt)}</td>
              <td>
                <div className="row-actions">
                  <button className="btn-icon" title="View" onClick={() => openDetail(m.id, 'manager')}>
                    <IconEye size={14}/>
                  </button>
                  {!m.invitationStatus && (
                    <>
                      <button
                        className="btn-icon"
                        title="Reset password"
                        onClick={() => { if (confirm(`Reset ${name}'s password? They'll be emailed a new one-time setup link.`)) resetPassword.mutate(m.id); }}
                      >
                        <IconKey size={14}/>
                      </button>
                      <button
                        className={`btn-icon ${active ? 'danger' : 'success'}`}
                        title={active ? 'Deactivate' : 'Reactivate'}
                        onClick={() => setActive.mutate({ id: m.id, active: !active })}
                      >
                        {active ? <IconUserOff size={14}/> : <IconUserCheck size={14}/>}
                      </button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
        {filtered.length === 0 && (
          <tr><td colSpan={9}><EmptyState variant={search ? 'matches' : 'records'} title={search ? 'No managers found' : 'No managers yet'} description={search ? 'Try a different name, email, or job title.' : 'Create a manager to give someone access to this workspace.'} /></td></tr>
        )}
      </tbody>
    </table>
  );
}

export default function Users() {
  const [tab, setTab] = useState<'staff' | 'managers'>('staff');
  const [search, setSearch] = useState('');
  const [count, setCount] = useState(0);

  return (
    <div className="page">
      <PageHeader title="Users" subtitle={`${count} ${tab === 'staff' ? 'staff member' : 'manager'}${count === 1 ? '' : 's'}`} />

      <div className="list-tabs-row">
        <button className={`tab-link ${tab === 'staff' ? 'active' : ''}`} onClick={() => setTab('staff')}>Staff</button>
        <button className={`tab-link ${tab === 'managers' ? 'active' : ''}`} onClick={() => setTab('managers')}>Managers</button>
      </div>

      <div className="list-toolbar-row">
        <div className="toolbar-search">
          <IconSearch size={14}/>
          <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <div className="list-toolbar-actions">
          <button className="btn btn-accent-outline" onClick={() => openCreate(tab === 'staff' ? 'staff' : 'manager')}>
            + New {tab === 'staff' ? 'Staff' : 'Manager'}
          </button>
          <button className="btn btn-outline">Filter</button>
          <button className="btn btn-outline">Sort</button>
          <button className="btn btn-outline">Options</button>
        </div>
      </div>

      <div className="table-container">
        {tab === 'staff' ? <StaffTab search={search} onCount={setCount} /> : <ManagersTab search={search} onCount={setCount} />}
      </div>

      <div className="list-footer">
        <span>Calculate</span>
        <span className="list-footer-divider"/>
        <span>Count all <strong>{count}</strong></span>
      </div>
    </div>
  );
}
