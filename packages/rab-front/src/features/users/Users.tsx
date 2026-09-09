import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconSearch, IconUserOff, IconUserCheck, IconEye, IconKey, IconLock, IconMail,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import { timeAgo } from '../../shared/lib/timeAgo';
import PageHeader from '../../shared/components/PageHeader';

interface PendingInvite {
  sendNumber: number;
  maxSendAttempts: number;
}

type InvitationStatus = 'pending' | 'cancelled' | 'expired' | 'queued' | 'sending' | 'delivery_failed' | null;

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

/**
 * The invitation email send is genuinely async now (durable outbox +
 * background worker, not an inline HTTP-blocking call) — a row can sit in
 * `queued`/`sending` for a few seconds after creation. React Query has no
 * reason to refetch on its own once the initial list lands (no window
 * refocus, no mutation touching this query), so without this the row's
 * badge freezes on whatever transient state it had at fetch time even
 * after the real state has already moved on (confirmed live: the list
 * showed "Invitation sending…" long after the detail panel, fetched
 * fresh, already showed "Pending invite"). Poll only while at least one
 * row is actually mid-flight, stopping once nothing is — never a
 * permanent background poll.
 */
const TRANSIENT_INVITATION_STATUSES: InvitationStatus[] = ['queued', 'sending'];
function pollWhileInvitationInFlight<T extends { invitationStatus: InvitationStatus }>(rows: T[] | undefined): number | false {
  return rows?.some((r) => TRANSIENT_INVITATION_STATUSES.includes(r.invitationStatus)) ? 2000 : false;
}

function openCreate(role: 'staff' | 'manager') {
  document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role } }));
}

function openDetail(id: string, type: 'staff' | 'manager') {
  document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id, type } }));
}

function openBulkEmail(role: 'staff' | 'manager', selected: Map<string, string>) {
  document.dispatchEvent(new CustomEvent('open-bulk-email', {
    detail: { role, userIds: [...selected.keys()], names: [...selected.values()] },
  }));
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
  if (invitationStatus === 'queued') return <span className="badge badge-pending">Invitation queued</span>;
  if (invitationStatus === 'sending') return <span className="badge badge-pending">Invitation sending…</span>;
  if (invitationStatus === 'delivery_failed') return <span className="badge badge-inactive">Delivery failed</span>;
  if (invitationStatus === 'pending') {
    const n = pendingInvite?.sendNumber ?? 1;
    return <span className="badge badge-pending">{n >= 3 ? 'Final invite (3/3)' : `Pending invite (${n}/3)`}</span>;
  }
  // No invitationStatus but the account genuinely isn't active yet — no
  // AccountInvite row exists at all (creation-time email was skipped
  // because the worker/email service was unavailable; see
  // AccountLifecycleService.isEmailDeliveryAvailable()). Must still show a
  // real pending state here, never fall through to a caller's plain
  // Active/Suspended badge just because no invite happens to be in flight.
  if (accountStatus === 'invited' || accountStatus === 'invite_expired') {
    return <span className="badge badge-pending">Pending — invite not sent</span>;
  }
  return null;
}

interface SelectionProps {
  selected: Map<string, string>;
  onToggle: (id: string, name: string) => void;
  onSelectAllVisible: (rows: Array<{ id: string; name: string }>) => void;
  onRows: (rows: Array<{ id: string; name: string }>) => void;
}

function StaffTab({ search, selected, onToggle, onSelectAllVisible, onRows }: { search: string } & SelectionProps) {
  const qc = useQueryClient();
  const { data: staff = [], isLoading } = useQuery({
    queryKey: ['staff'],
    queryFn: async () => { const { data } = await api.get<StaffRow[]>('/staff'); return data; },
    refetchInterval: (query) => pollWhileInvitationInFlight(query.state.data),
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

  const visibleRows = useMemo(() => filtered.map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName}` })), [filtered]);
  useEffect(() => onRows(visibleRows), [visibleRows, onRows]);

  if (isLoading) return <TableSkeleton columns={10} />;

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id));

  return (
    <table className="table">
      <thead>
        <tr>
          <th className="checkbox-col">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={() => onSelectAllVisible(visibleRows)}
              aria-label="Select all staff"
            />
          </th>
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
          const isSelected = selected.has(s.id);
          return (
            <tr key={s.id} className={isSelected ? 'row-selected' : undefined}>
              <td className="checkbox-col">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(s.id, name)}
                  aria-label={`Select ${name}`}
                />
              </td>
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
                {/* Gated on accountStatus, not invitationStatus — the latter
                    is legitimately null for a still-pending account whose
                    creation-time invite was skipped (email/worker
                    unavailable), and must not be read as "genuinely active". */}
                {s.accountStatus === 'active'
                  ? <span className={`badge badge-${active ? 'active' : 'inactive'}`}>{s.employmentStatus.replace(/_/g, ' ')}</span>
                  : <AccountStatusBadge invitationStatus={s.invitationStatus} accountStatus={s.accountStatus} pendingInvite={s.pendingInvite} />}
              </td>
              <td>{s.accountStatus === 'active' ? <PasswordStatusBadge mustResetPassword={s.mustResetPassword}/> : '–'}</td>
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
          <tr><td colSpan={10}><EmptyState variant={search ? 'matches' : 'records'} title={search ? 'No staff found' : 'No staff members yet'} description={search ? 'Try a different name, email, or reference.' : 'Create a staff member to start building your workforce.'} /></td></tr>
        )}
      </tbody>
    </table>
  );
}

function ManagersTab({ search, selected, onToggle, onSelectAllVisible, onRows }: { search: string } & SelectionProps) {
  const qc = useQueryClient();
  const { data: managers = [], isLoading } = useQuery({
    queryKey: ['managers'],
    queryFn: async () => { const { data } = await api.get<ManagerRow[]>('/managers'); return data; },
    refetchInterval: (query) => pollWhileInvitationInFlight(query.state.data),
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

  const visibleRows = useMemo(() => filtered.map((m) => ({ id: m.id, name: `${m.firstName} ${m.lastName}` })), [filtered]);
  useEffect(() => onRows(visibleRows), [visibleRows, onRows]);

  if (isLoading) return <TableSkeleton columns={10} />;

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id));

  return (
    <table className="table">
      <thead>
        <tr>
          <th className="checkbox-col">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={() => onSelectAllVisible(visibleRows)}
              aria-label="Select all managers"
            />
          </th>
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
          const isSelected = selected.has(m.id);
          return (
            <tr key={m.id} className={isSelected ? 'row-selected' : undefined}>
              <td className="checkbox-col">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(m.id, name)}
                  aria-label={`Select ${name}`}
                />
              </td>
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
                {/* Gated on accountStatus, not invitationStatus — see
                    StaffTab's identical comment above for why. */}
                {m.accountStatus === 'active'
                  ? <span className={`badge badge-${active ? 'active' : 'inactive'}`}>{active ? 'Active' : 'Suspended'}</span>
                  : <AccountStatusBadge invitationStatus={m.invitationStatus} accountStatus={m.accountStatus} pendingInvite={m.pendingInvite} />}
              </td>
              <td>{m.accountStatus === 'active' ? <PasswordStatusBadge mustResetPassword={m.mustResetPassword}/> : '–'}</td>
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
          <tr><td colSpan={10}><EmptyState variant={search ? 'matches' : 'records'} title={search ? 'No managers found' : 'No managers yet'} description={search ? 'Try a different name, email, or job title.' : 'Create a manager to give someone access to this workspace.'} /></td></tr>
        )}
      </tbody>
    </table>
  );
}

export default function Users() {
  const [tab, setTab] = useState<'staff' | 'managers'>('staff');
  const [search, setSearch] = useState('');
  const [visibleRows, setVisibleRows] = useState<Array<{ id: string; name: string }>>([]);
  // Selection is independent of the detail panel's `activeDetailUserId`
  // (owned entirely inside UserDetailPanel, via its own `open-user-detail`
  // listener) — checking a row never opens/closes/affects the panel, and
  // closing the panel never touches this. Keyed by id → name (not a bare
  // Set) so the bulk-email recipient label/target survives a search-filter
  // change between selecting a row and acting on the selection.
  const [selected, setSelected] = useState<Map<string, string>>(new Map());

  const switchTab = (next: 'staff' | 'managers') => {
    setTab(next);
    setSelected(new Map());
    setVisibleRows([]);
  };

  const onToggle = (id: string, name: string) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id); else next.set(id, name);
      return next;
    });
  };

  const onSelectAllVisible = (rows: Array<{ id: string; name: string }>) => {
    setSelected((prev) => {
      const allSelected = rows.length > 0 && rows.every((r) => prev.has(r.id));
      if (allSelected) {
        const next = new Map(prev);
        rows.forEach((r) => next.delete(r.id));
        return next;
      }
      const next = new Map(prev);
      rows.forEach((r) => next.set(r.id, r.name));
      return next;
    });
  };

  const count = visibleRows.length;
  const selectionRole: 'staff' | 'manager' = tab === 'staff' ? 'staff' : 'manager';

  return (
    <div className="page">
      <PageHeader
        title="Users"
        subtitle={selected.size > 0
          ? `${selected.size} selected`
          : `${count} ${tab === 'staff' ? 'staff member' : 'manager'}${count === 1 ? '' : 's'}`}
      />

      <div className="list-tabs-row">
        <button className={`tab-link ${tab === 'staff' ? 'active' : ''}`} onClick={() => switchTab('staff')}>Staff</button>
        <button className={`tab-link ${tab === 'managers' ? 'active' : ''}`} onClick={() => switchTab('managers')}>Managers</button>
      </div>

      <div className="list-toolbar-row">
        <div className="toolbar-search">
          <IconSearch size={14}/>
          <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <div className="list-toolbar-actions">
          {selected.size > 0 && (
            <button className="btn btn-outline" style={{ gap: 6 }} onClick={() => openBulkEmail(selectionRole, selected)}>
              <IconMail size={14}/>
              Send Email
            </button>
          )}
          <button className="btn btn-accent-outline" onClick={() => openCreate(tab === 'staff' ? 'staff' : 'manager')}>
            + New {tab === 'staff' ? 'Staff' : 'Manager'}
          </button>
          <button className="btn btn-outline">Filter</button>
          <button className="btn btn-outline">Sort</button>
          <button className="btn btn-outline">Options</button>
        </div>
      </div>

      <div className="table-container">
        {tab === 'staff'
          ? <StaffTab search={search} selected={selected} onToggle={onToggle} onSelectAllVisible={onSelectAllVisible} onRows={setVisibleRows} />
          : <ManagersTab search={search} selected={selected} onToggle={onToggle} onSelectAllVisible={onSelectAllVisible} onRows={setVisibleRows} />}
      </div>

      <div className="list-footer">
        <span>Calculate</span>
        <span className="list-footer-divider"/>
        <span>Count all <strong>{count}</strong></span>
      </div>
    </div>
  );
}
