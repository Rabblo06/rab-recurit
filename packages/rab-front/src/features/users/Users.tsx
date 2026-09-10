import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  IconUserOff, IconUserCheck, IconEye, IconKey, IconLock, IconMail,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import { timeAgo } from '../../shared/lib/timeAgo';
import PageHeader from '../../shared/components/PageHeader';
import TableViewControls, { TableSearchInput } from '../../shared/table-toolbar/TableToolbar';
import { useTableQueryState } from '../../shared/table-toolbar/useTableQueryState';
import { useColumnVisibility } from '../../shared/table-toolbar/useColumnVisibility';
import type { TableToolbarConfig } from '../../shared/table-toolbar/types';

const STAFF_TABLE_CONFIG: TableToolbarConfig = {
  storageKey: 'users-staff',
  filters: [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'pending_compliance', label: 'Pending compliance' },
        { value: 'active', label: 'Active' },
        { value: 'inactive', label: 'Inactive' },
        { value: 'suspended', label: 'Suspended' },
      ],
    },
    {
      key: 'employmentType',
      label: 'Employment type',
      type: 'select',
      options: ['Full-time', 'Part-time', 'Temporary', 'Casual', 'Contract'].map((t) => ({ value: t, label: t })),
    },
    { key: 'createdAt', label: 'Date added', type: 'dateRange' },
  ],
  sorts: [
    { key: 'name', label: 'Name', directions: ['asc', 'desc'] },
    { key: 'staffRef', label: 'Staff reference', directions: ['asc', 'desc'] },
    { key: 'email', label: 'Email', directions: ['asc', 'desc'] },
    { key: 'defaultPayRatePence', label: 'Default rate', directions: ['asc', 'desc'] },
    { key: 'createdAt', label: 'Date added', directions: ['desc', 'asc'], directionLabels: { desc: 'Newest first', asc: 'Oldest first' } },
  ],
  columns: [
    { key: 'name', label: 'Name', hideable: true },
    { key: 'staffRef', label: 'Ref', hideable: true },
    { key: 'email', label: 'Email', hideable: true },
    { key: 'phone', label: 'Phone', hideable: true },
    { key: 'rate', label: 'Rate', hideable: true },
    { key: 'status', label: 'Status', hideable: true },
    { key: 'password', label: 'Password', hideable: true },
    { key: 'added', label: 'Added', hideable: true },
  ],
  defaultSort: { key: 'createdAt', direction: 'desc' },
};

const MANAGERS_TABLE_CONFIG: TableToolbarConfig = {
  storageKey: 'users-managers',
  filters: [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'invited', label: 'Invited' },
        { value: 'active', label: 'Active' },
        { value: 'suspended', label: 'Suspended' },
        { value: 'deactivated', label: 'Deactivated' },
        { value: 'invite_expired', label: 'Invite expired' },
      ],
    },
    {
      key: 'type',
      label: 'Type',
      type: 'select',
      options: [
        { value: 'internal', label: 'Internal manager' },
        { value: 'venue', label: 'Venue manager' },
      ],
    },
    { key: 'createdAt', label: 'Date added', type: 'dateRange' },
  ],
  sorts: [
    { key: 'name', label: 'Name', directions: ['asc', 'desc'] },
    { key: 'email', label: 'Email', directions: ['asc', 'desc'] },
    { key: 'jobTitle', label: 'Job title', directions: ['asc', 'desc'] },
    { key: 'createdAt', label: 'Date added', directions: ['desc', 'asc'], directionLabels: { desc: 'Newest first', asc: 'Oldest first' } },
  ],
  columns: [
    { key: 'name', label: 'Name', hideable: true },
    { key: 'email', label: 'Email', hideable: true },
    { key: 'phone', label: 'Phone', hideable: true },
    { key: 'jobTitle', label: 'Job title', hideable: true },
    { key: 'type', label: 'Type', hideable: true },
    { key: 'status', label: 'Status', hideable: true },
    { key: 'password', label: 'Password', hideable: true },
    { key: 'added', label: 'Added', hideable: true },
  ],
  defaultSort: { key: 'createdAt', direction: 'desc' },
};

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

function StaffTab({ selected, onToggle, onSelectAllVisible, onRows, onTotal }: SelectionProps & { onTotal: (n: number) => void }) {
  const qc = useQueryClient();
  const { data: jobRoles = [] } = useQuery({
    queryKey: ['job-roles'],
    queryFn: async () => { const { data } = await api.get<Array<{ id: string; name: string }>>('/job-roles'); return data; },
  });

  const config: TableToolbarConfig = {
    ...STAFF_TABLE_CONFIG,
    filters: [
      ...STAFF_TABLE_CONFIG.filters,
      { key: 'jobRoleId', label: 'Job role', type: 'select', options: jobRoles.map((r) => ({ value: r.id, label: r.name })) },
    ],
  };

  const { search, filters, sort, page, setSearch, setFilters, setSort, activeFilterCount } = useTableQueryState(config);
  const columnVisibility = useColumnVisibility(config.storageKey, config.columns);

  const params = { q: search || undefined, ...filters, sort: sort.sort, direction: sort.direction, page };
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['staff', params],
    queryFn: async () => { const { data } = await api.get<{ data: StaffRow[]; total: number }>('/staff', { params }); return data; },
    refetchInterval: (query) => pollWhileInvitationInFlight(query.state.data?.data),
  });
  const staff = data?.data ?? [];
  const total = data?.total ?? 0;

  useEffect(() => onTotal(total), [total, onTotal]);
  const visibleRows = staff.map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName}` }));
  useEffect(() => onRows(visibleRows), [staff]); // eslint-disable-line react-hooks/exhaustive-deps

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.post(`/staff/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
  });

  const resetPassword = useMutation({
    mutationFn: (id: string) => api.post(`/staff/${id}/reset-password`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
  });

  const isVisible = columnVisibility.isVisible;
  const isFiltered = activeFilterCount > 0 || Boolean(search);
  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id));

  return (
    <>
      <div className="list-toolbar-row">
        <TableSearchInput value={search} onChange={setSearch} />
        <div className="list-toolbar-actions">
          {selected.size > 0 && (
            <button className="btn btn-outline" style={{ gap: 6 }} onClick={() => openBulkEmail('staff', selected)}>
              <IconMail size={14}/>
              Send Email
            </button>
          )}
          <button className="btn btn-accent-outline" onClick={() => openCreate('staff')}>+ New Staff</button>
          <TableViewControls
            config={config}
            filters={filters}
            onFiltersChange={setFilters}
            sort={sort}
            onSortChange={setSort}
            activeFilterCount={activeFilterCount}
            columnVisibility={columnVisibility}
          />
        </div>
      </div>
      <div className={`table-container${isFetching ? ' table-loading' : ''}`}>
        {isLoading ? <TableSkeleton columns={10} /> : (
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
                {isVisible('name') && <th>Name</th>}
                {isVisible('staffRef') && <th>Ref</th>}
                {isVisible('email') && <th>Email</th>}
                {isVisible('phone') && <th>Phone</th>}
                {isVisible('rate') && <th>Rate</th>}
                {isVisible('status') && <th>Status</th>}
                {isVisible('password') && <th>Password</th>}
                {isVisible('added') && <th>Added</th>}
                <th style={{ width: 76 }}/>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => {
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
                    {isVisible('name') && (
                      <td>
                        <span className="record-chip" style={{ cursor: 'pointer' }} onClick={() => openDetail(s.id, 'staff')}>
                          <span className="mini-avatar" style={{ background: c.bg, color: c.color }}>{name[0]}</span>
                          {name}
                        </span>
                      </td>
                    )}
                    {isVisible('staffRef') && <td className="cell-muted">{s.staffRef}</td>}
                    {isVisible('email') && <td className="cell-muted">{s.email}</td>}
                    {isVisible('phone') && <td className="cell-muted">{s.phone ?? '–'}</td>}
                    {isVisible('rate') && <td className="cell-muted">{s.defaultPayRatePence ? `£${(s.defaultPayRatePence / 100).toFixed(2)}/hr` : '–'}</td>}
                    {isVisible('status') && (
                      <td>
                        {/* Gated on accountStatus, not invitationStatus — the latter
                            is legitimately null for a still-pending account whose
                            creation-time invite was skipped (email/worker
                            unavailable), and must not be read as "genuinely active". */}
                        {s.accountStatus === 'active'
                          ? <span className={`badge badge-${active ? 'active' : 'inactive'}`}>{s.employmentStatus.replace(/_/g, ' ')}</span>
                          : <AccountStatusBadge invitationStatus={s.invitationStatus} accountStatus={s.accountStatus} pendingInvite={s.pendingInvite} />}
                      </td>
                    )}
                    {isVisible('password') && <td>{s.accountStatus === 'active' ? <PasswordStatusBadge mustResetPassword={s.mustResetPassword}/> : '–'}</td>}
                    {isVisible('added') && <td className="cell-muted">{timeAgo(s.createdAt)}</td>}
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
              {staff.length === 0 && (
                <tr>
                  <td colSpan={10}>
                    {isFiltered ? (
                      <EmptyState
                        variant="matches"
                        title="No results match these filters."
                        description="Try different values, or clear filters to see the full list."
                        action={<button className="btn btn-outline" onClick={() => { setSearch(''); setFilters({}); }}>Clear filters</button>}
                      />
                    ) : (
                      <EmptyState variant="records" title="No staff members yet" description="Create a staff member to start building your workforce." />
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function ManagersTab({ selected, onToggle, onSelectAllVisible, onRows, onTotal }: SelectionProps & { onTotal: (n: number) => void }) {
  const qc = useQueryClient();
  const config = MANAGERS_TABLE_CONFIG;
  const { search, filters, sort, page, setSearch, setFilters, setSort, activeFilterCount } = useTableQueryState(config);
  const columnVisibility = useColumnVisibility(config.storageKey, config.columns);

  const params = { q: search || undefined, ...filters, sort: sort.sort, direction: sort.direction, page };
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['managers', params],
    queryFn: async () => { const { data } = await api.get<{ data: ManagerRow[]; total: number }>('/managers', { params }); return data; },
    refetchInterval: (query) => pollWhileInvitationInFlight(query.state.data?.data),
  });
  const managers = data?.data ?? [];
  const total = data?.total ?? 0;

  useEffect(() => onTotal(total), [total, onTotal]);
  const visibleRows = managers.map((m) => ({ id: m.id, name: `${m.firstName} ${m.lastName}` }));
  useEffect(() => onRows(visibleRows), [managers]); // eslint-disable-line react-hooks/exhaustive-deps

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.post(`/managers/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['managers'] }),
  });

  const resetPassword = useMutation({
    mutationFn: (id: string) => api.post(`/managers/${id}/reset-password`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['managers'] }),
  });

  const isVisible = columnVisibility.isVisible;
  const isFiltered = activeFilterCount > 0 || Boolean(search);
  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id));

  return (
    <>
      <div className="list-toolbar-row">
        <TableSearchInput value={search} onChange={setSearch} />
        <div className="list-toolbar-actions">
          {selected.size > 0 && (
            <button className="btn btn-outline" style={{ gap: 6 }} onClick={() => openBulkEmail('manager', selected)}>
              <IconMail size={14}/>
              Send Email
            </button>
          )}
          <button className="btn btn-accent-outline" onClick={() => openCreate('manager')}>+ New Manager</button>
          <TableViewControls
            config={config}
            filters={filters}
            onFiltersChange={setFilters}
            sort={sort}
            onSortChange={setSort}
            activeFilterCount={activeFilterCount}
            columnVisibility={columnVisibility}
          />
        </div>
      </div>
      <div className={`table-container${isFetching ? ' table-loading' : ''}`}>
        {isLoading ? <TableSkeleton columns={10} /> : (
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
                {isVisible('name') && <th>Name</th>}
                {isVisible('email') && <th>Email</th>}
                {isVisible('phone') && <th>Phone</th>}
                {isVisible('jobTitle') && <th>Job title</th>}
                {isVisible('type') && <th>Type</th>}
                {isVisible('status') && <th>Status</th>}
                {isVisible('password') && <th>Password</th>}
                {isVisible('added') && <th>Added</th>}
                <th style={{ width: 76 }}/>
              </tr>
            </thead>
            <tbody>
              {managers.map((m) => {
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
                    {isVisible('name') && (
                      <td>
                        <span className="record-chip" style={{ cursor: 'pointer' }} onClick={() => openDetail(m.id, 'manager')}>
                          <span className="mini-avatar" style={{ background: c.bg, color: c.color }}>{name[0]}</span>
                          {name}
                        </span>
                      </td>
                    )}
                    {isVisible('email') && <td className="cell-muted">{m.email}</td>}
                    {isVisible('phone') && <td className="cell-muted">{m.phone ?? '–'}</td>}
                    {isVisible('jobTitle') && <td className="cell-muted">{m.jobTitle ?? '–'}</td>}
                    {isVisible('type') && <td><span className="badge badge-admin">{m.type === 'venue' ? 'Venue manager' : 'Manager'}</span></td>}
                    {isVisible('status') && (
                      <td>
                        {/* Gated on accountStatus, not invitationStatus — see
                            StaffTab's identical comment above for why. */}
                        {m.accountStatus === 'active'
                          ? <span className={`badge badge-${active ? 'active' : 'inactive'}`}>{active ? 'Active' : 'Suspended'}</span>
                          : <AccountStatusBadge invitationStatus={m.invitationStatus} accountStatus={m.accountStatus} pendingInvite={m.pendingInvite} />}
                      </td>
                    )}
                    {isVisible('password') && <td>{m.accountStatus === 'active' ? <PasswordStatusBadge mustResetPassword={m.mustResetPassword}/> : '–'}</td>}
                    {isVisible('added') && <td className="cell-muted">{timeAgo(m.createdAt)}</td>}
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
              {managers.length === 0 && (
                <tr>
                  <td colSpan={10}>
                    {isFiltered ? (
                      <EmptyState
                        variant="matches"
                        title="No results match these filters."
                        description="Try different values, or clear filters to see the full list."
                        action={<button className="btn btn-outline" onClick={() => { setSearch(''); setFilters({}); }}>Clear filters</button>}
                      />
                    ) : (
                      <EmptyState variant="records" title="No managers yet" description="Create a manager to give someone access to this workspace." />
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export default function Users() {
  const [tab, setTab] = useState<'staff' | 'managers'>('staff');
  const [, setSearchParams] = useSearchParams();
  const [visibleRows, setVisibleRows] = useState<Array<{ id: string; name: string }>>([]);
  const [total, setTotal] = useState(0);
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
    // Staff and Managers have different filter/sort field sets (e.g.
    // `status` means a different enum for each) — carrying one tab's URL
    // params into the other could send a value the other's DTO rejects
    // (400) right after switching. A fresh view per tab is also simply
    // the more sensible default when switching what you're looking at.
    setSearchParams({});
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

  return (
    <div className="page">
      <PageHeader
        title="Users"
        subtitle={selected.size > 0
          ? `${selected.size} selected`
          : `${total} ${tab === 'staff' ? 'staff member' : 'manager'}${total === 1 ? '' : 's'}`}
      />

      <div className="list-tabs-row">
        <button className={`tab-link ${tab === 'staff' ? 'active' : ''}`} onClick={() => switchTab('staff')}>Staff</button>
        <button className={`tab-link ${tab === 'managers' ? 'active' : ''}`} onClick={() => switchTab('managers')}>Managers</button>
      </div>

      {tab === 'staff'
        ? <StaffTab selected={selected} onToggle={onToggle} onSelectAllVisible={onSelectAllVisible} onRows={setVisibleRows} onTotal={setTotal} />
        : <ManagersTab selected={selected} onToggle={onToggle} onSelectAllVisible={onSelectAllVisible} onRows={setVisibleRows} onTotal={setTotal} />}

      <div className="list-footer">
        <span>Calculate</span>
        <span className="list-footer-divider"/>
        <span>Count all <strong>{total}</strong></span>
      </div>
    </div>
  );
}
