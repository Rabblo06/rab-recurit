import { ListViewSelect, RecordFooter, ListError, listErrorStatus, useRetryUnlessPermanent } from '../../shared/table-toolbar/ListPresentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  IconUserOff, IconUserCheck, IconEye, IconKey, IconLock, IconMail, IconPlus, IconArchive, IconArchiveOff,
} from '@tabler/icons-react';
import { useArchiveRestore } from '../../shared/hooks/useArchiveRestore';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import { timeAgo } from '../../shared/lib/timeAgo';
import PageHeader from '../../shared/components/PageHeader';
import UsersBulkActions, { type SelectedRecord, type SelectionKind } from './UsersBulkActions';
import { getUserId, subscribeToSession } from '../../shared/lib/auth-session';
import TableViewControls, { TableSearchInput } from '../../shared/table-toolbar/TableToolbar';
import { useTableQueryState } from '../../shared/table-toolbar/useTableQueryState';
import { useColumnVisibility } from '../../shared/table-toolbar/useColumnVisibility';
import type { TableToolbarConfig } from '../../shared/table-toolbar/types';
import { getStaffDisplayStatus, type InvitationStatus, type PendingInvite } from './staffStatus';
import { toast } from '../../shared/lib/toast';
import { getApiErrorMessage } from '../../shared/lib/apiError';

/** The server's safe, user-readable refusal (e.g. 409 "not activated yet"), never a silent failure or a fake success. */
function serverMessage(e: unknown, fallback: string): string {
  return getApiErrorMessage(e, fallback);
}

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
    // Wave 5: archived leavers are hidden by the server unless this is set.
    { key: 'includeArchived', label: 'Show archived', type: 'select', options: [{ value: 'true', label: 'Include archived' }] },
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
    { key: 'password', label: 'Password', hideable: true, defaultVisible: false },
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
    { key: 'includeArchived', label: 'Show archived', type: 'select', options: [{ value: 'true', label: 'Include archived' }] },
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
    { key: 'password', label: 'Password', hideable: true, defaultVisible: false },
    { key: 'added', label: 'Added', hideable: true },
  ],
  defaultSort: { key: 'createdAt', direction: 'desc' },
};

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
  /** Wave 5: set while archived (hidden from the default list). */
  archivedAt?: string | null;
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
  /** Wave 5: set while archived (hidden from the default list). */
  archivedAt?: string | null;
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

/**
 * `isFetching` is true for every fetch, including the silent
 * `pollWhileInvitationInFlight` background poll — applying `table-loading`
 * (which sets `pointer-events: none` on the whole table, see index.css) for
 * every one of those blocks row clicks for the ~2s of each poll tick, even
 * though the poll never reorders rows. Only a real filter/sort/search/page
 * change (where rows may genuinely reorder) should get that treatment.
 *
 * The decision is made exactly once per fetch — at the moment it starts,
 * comparing against the params that were in effect when the *previous*
 * fetch settled — and then pinned for the fetch's whole duration. Comparing
 * live on every render instead (params vs a ref updated on every params
 * change) breaks the moment `params` itself changes: the ref update would
 * land before the fetch finishes, making the "still fetching" state look
 * identical to "already settled" well before `isFetching` actually goes
 * false, which would drop the loading class mid-fetch.
 */
function useIsParamsRefetch(params: unknown, isFetching: boolean): boolean {
  const paramsKey = JSON.stringify(params);
  const settledParamsKeyRef = useRef(paramsKey);
  const wasFetchingRef = useRef(isFetching);
  const [isParamsRefetch, setIsParamsRefetch] = useState(false);

  useEffect(() => {
    if (isFetching && !wasFetchingRef.current) {
      setIsParamsRefetch(settledParamsKeyRef.current !== paramsKey);
    } else if (!isFetching) {
      settledParamsKeyRef.current = paramsKey;
      setIsParamsRefetch(false);
    }
    wasFetchingRef.current = isFetching;
  }, [isFetching, paramsKey]);

  return isParamsRefetch;
}

function openCreate(role: 'staff' | 'manager', scope: 'org' | 'workspace' = 'org') {
  document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role, scope } }));
}

function openDetail(id: string, type: 'staff' | 'manager' | 'venueManager') {
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
 * Renders whatever `getStaffDisplayStatus` derives — the ONE canonical
 * status decision, shared with `UserDetailPanel`'s header badge so the
 * table and the detail drawer can never disagree about a record's status.
 */
function UserStatusBadge({ userType, accountStatus, employmentStatus, invitationStatus, pendingInvite }: {
  userType: 'staff' | 'manager';
  accountStatus: string;
  employmentStatus?: string | null;
  invitationStatus: InvitationStatus;
  pendingInvite: PendingInvite | null;
}) {
  const status = getStaffDisplayStatus({ userType, accountStatus, employmentStatus, invitationStatus, pendingInvite });
  return <span className={`badge badge-${status.tone}`}>{status.label}</span>;
}

interface SelectionProps {
  selected: Map<string, SelectedRecord>;
  onToggle: (id: string, record: SelectedRecord) => void;
  /** Reports the ids currently on screen, so the bar can say how much of the selection is off this page. */
  onVisible: (ids: string[]) => void;
  onSelectAllVisible: (rows: Array<{ id: string; record: SelectedRecord }>) => void;
}

/** "Select all" for the rows currently on screen: checked, unchecked, or indeterminate (some of them). */
function SelectAllCheckbox({ ids, selected, onToggleAll, label }: { ids: string[]; selected: Map<string, SelectedRecord>; onToggleAll: () => void; label: string }) {
  const count = ids.filter((id) => selected.has(id)).length;
  const all = ids.length > 0 && count === ids.length;
  return (
    <input
      type="checkbox"
      checked={all}
      ref={(el) => { if (el) el.indeterminate = count > 0 && !all; }}
      disabled={ids.length === 0}
      onChange={onToggleAll}
      aria-label={label}
    />
  );
}

function StaffTab({ selected, onToggle, onSelectAllVisible, onVisible, onTotal }: SelectionProps & { onTotal: (n: number | null) => void }) {
  const retryUnlessPermanent = useRetryUnlessPermanent();
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

  const { search, filters, sort, page, setPage, setSearch, setFilters, setSort, activeFilterCount } = useTableQueryState(config);
  const columnVisibility = useColumnVisibility(config.storageKey, config.columns);

  const params = { q: search || undefined, ...filters, sort: sort.sort, direction: sort.direction, page };
  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    retry: retryUnlessPermanent,
    queryKey: ['staff', params],
    queryFn: async () => { const { data } = await api.get<{ data: StaffRow[]; total: number }>('/staff', { params }); return data; },
    refetchInterval: (query) => pollWhileInvitationInFlight(query.state.data?.data),
  });
  const staff = data?.data ?? [];
  const total = data?.total ?? 0;
  const isParamsRefetch = useIsParamsRefetch(params, isFetching);

  useEffect(() => onTotal(data ? total : null), [data, total, onTotal]);
  const visibleRows = staff.map((s) => ({ id: s.id, record: { name: `${s.firstName} ${s.lastName}`, accountStatus: s.accountStatus, employmentStatus: s.employmentStatus } }));
  const visibleKey = visibleRows.map((r) => r.id).join(',');
  useEffect(() => onVisible(visibleKey ? visibleKey.split(',') : []), [visibleKey, onVisible]);

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.post(`/staff/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
    onError: (e: any) => toast.error(serverMessage(e, 'Could not update this account.')),
  });

  const staffArchive = useArchiveRestore<StaffRow>({
    basePath: (r) => `/staff/${r.id}`,
    noun: 'staff member',
    name: (r) => `${r.firstName} ${r.lastName}`,
    invalidate: [['staff']],
    archiveNote: 'Their account stays deactivated; restore them first to reactivate.',
  });

  const resetPassword = useMutation({
    mutationFn: (id: string) => api.post(`/staff/${id}/reset-password`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
    onError: (e: any) => toast.error(serverMessage(e, 'Could not reset this password.')),
  });

  const isVisible = columnVisibility.isVisible;
  const isFiltered = activeFilterCount > 0 || Boolean(search);
  return (
    <>
      <div className="list-toolbar-row">
        <ListViewSelect label="Staff view" value={filters.status ?? ''} options={[{value:'', label:'All staff'}, ...(config.filters.find(f => f.key === 'status')?.options ?? [])]} onChange={status => setFilters({...filters, status})} />
        <TableSearchInput value={search} onChange={setSearch} />
        <div className="list-toolbar-actions">
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
      <div className={`table-container${isParamsRefetch ? ' table-loading' : ''}`}>
        {isLoading ? <TableSkeleton columns={10} /> : isError ? <ListError retry={refetch} error={error} /> : (
          <table className="table staff-table">
            <thead>
              <tr>
                <th className="checkbox-col">
                  <SelectAllCheckbox ids={visibleRows.map((r) => r.id)} selected={selected} onToggleAll={() => onSelectAllVisible(visibleRows)} label="Select all staff on this page" />
                </th>
                {isVisible('name') && <th data-column="name">Name</th>}
                {isVisible('staffRef') && <th data-column="reference">Reference</th>}
                {isVisible('email') && <th data-column="email">Email</th>}
                {isVisible('phone') && <th data-column="phone">Phone</th>}
                {isVisible('rate') && <th data-column="rate">Rate</th>}
                {isVisible('status') && <th data-column="status">Status</th>}
                {isVisible('password') && <th data-column="password">Password</th>}
                {isVisible('added') && <th data-column="added">Added</th>}
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
                        onChange={() => onToggle(s.id, { name, accountStatus: s.accountStatus, employmentStatus: s.employmentStatus })}
                        aria-label={`Select ${name}`}
                      />
                    </td>
                    {isVisible('name') && (
                      <td>
                        <button type="button" className="record-chip" style={{ cursor: 'pointer' }} onClick={() => openDetail(s.id, 'staff')}>
                          <span className="mini-avatar" style={{ background: c.bg, color: c.color }}>{name.split(' ').filter(Boolean).map(part => part[0]).slice(0,2).join('')}</span>
                          {name}
                        </button>
                      </td>
                    )}
                    {isVisible('staffRef') && <td className="cell-muted">{s.staffRef}</td>}
                    {isVisible('email') && <td className="cell-muted">{s.email}</td>}
                    {isVisible('phone') && <td className="cell-muted">{s.phone ?? '–'}</td>}
                    {isVisible('rate') && <td className="cell-muted">{s.defaultPayRatePence ? `£${(s.defaultPayRatePence / 100).toFixed(2)}/hr` : '–'}</td>}
                    {isVisible('status') && (
                      <td>
                        <UserStatusBadge
                          userType="staff"
                          accountStatus={s.accountStatus}
                          employmentStatus={s.employmentStatus}
                          invitationStatus={s.invitationStatus}
                          pendingInvite={s.pendingInvite}
                        />
                      </td>
                    )}
                    {isVisible('password') && <td>{s.accountStatus === 'active' ? <PasswordStatusBadge mustResetPassword={s.mustResetPassword}/> : '–'}</td>}
                    {isVisible('added') && <td className="cell-muted">{new Date(s.createdAt).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'})}</td>}
                    <td>
                      <div className="row-actions">
                        <button className="btn-icon" title="View" onClick={() => openDetail(s.id, 'staff')}>
                          <IconEye size={14}/>
                        </button>
                        {(s.accountStatus === 'active' || s.accountStatus === 'suspended') && (
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
                              disabled={!!s.archivedAt}
                            >
                              {active ? <IconUserOff size={14}/> : <IconUserCheck size={14}/>}
                            </button>
                          </>
                        )}
                        {s.archivedAt ? (
                          <button className="btn-icon" title="Restore" aria-label={`Restore ${name}`} onClick={() => staffArchive.request(s, 'restore')}>
                            <IconArchiveOff size={14}/>
                          </button>
                        ) : s.employmentStatus === 'inactive' ? (
                          <button className="btn-icon danger" title="Archive (leaver)" aria-label={`Archive ${name}`} onClick={() => staffArchive.request(s, 'archive')}>
                            <IconArchive size={14}/>
                          </button>
                        ) : null}
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
                      <EmptyState variant="staff" title="Your team starts here" description="Add your first staff member to start building your workforce." />
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      {data && <RecordFooter total={total} page={page} onPage={setPage} />}
      {staffArchive.dialog}
    </>
  );
}

function ManagersTab({ selected, onToggle, onSelectAllVisible, onVisible, onTotal }: SelectionProps & { onTotal: (n: number | null) => void }) {
  const retryUnlessPermanent = useRetryUnlessPermanent();
  const qc = useQueryClient();
  const config = MANAGERS_TABLE_CONFIG;
  const { search, filters, sort, page, setPage, setSearch, setFilters, setSort, activeFilterCount } = useTableQueryState(config);
  const columnVisibility = useColumnVisibility(config.storageKey, config.columns);

  const params = { q: search || undefined, ...filters, sort: sort.sort, direction: sort.direction, page };
  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    retry: retryUnlessPermanent,
    queryKey: ['managers', params],
    queryFn: async () => { const { data } = await api.get<{ data: ManagerRow[]; total: number }>('/managers', { params }); return data; },
    refetchInterval: (query) => pollWhileInvitationInFlight(query.state.data?.data),
  });
  const managers = data?.data ?? [];
  const total = data?.total ?? 0;
  const isParamsRefetch = useIsParamsRefetch(params, isFetching);

  useEffect(() => onTotal(data ? total : null), [data, total, onTotal]);
  const visibleRows = managers.map((m) => ({ id: m.id, record: { name: `${m.firstName} ${m.lastName}`, accountStatus: m.accountStatus } }));
  const visibleKey = visibleRows.map((r) => r.id).join(',');
  useEffect(() => onVisible(visibleKey ? visibleKey.split(',') : []), [visibleKey, onVisible]);

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.post(`/managers/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['managers'] }),
    onError: (e: any) => toast.error(serverMessage(e, 'Could not update this account.')),
  });
  const managerArchive = useArchiveRestore<ManagerRow>({
    basePath: (r) => `/managers/${r.id}`,
    noun: 'manager',
    name: (r) => `${r.firstName} ${r.lastName}`,
    invalidate: [['managers']],
    archiveNote: 'Their account stays deactivated; restore them first to reactivate.',
  });

  const resetPassword = useMutation({
    mutationFn: (id: string) => api.post(`/managers/${id}/reset-password`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['managers'] }); toast.success('A new setup link has been sent.'); },
    onError: (e: any) => toast.error(serverMessage(e, 'Could not reset this password.')),
  });

  const isVisible = columnVisibility.isVisible;
  const isFiltered = activeFilterCount > 0 || Boolean(search);

  return (
    <>
      <div className="list-toolbar-row">
        <ListViewSelect label="Manager view" value={filters.status ?? ''} options={[{value:'', label:'All managers'}, ...(config.filters.find(f => f.key === 'status')?.options ?? [])]} onChange={status => setFilters({...filters, status})} />
        <TableSearchInput value={search} onChange={setSearch} />
        <div className="list-toolbar-actions">
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
      <div className={`table-container${isParamsRefetch ? ' table-loading' : ''}`}>
        {isLoading ? <TableSkeleton columns={10} /> : isError ? <ListError retry={refetch} error={error} /> : (
          <table className="table">
            <thead>
              <tr>
                <th className="checkbox-col">
                  <SelectAllCheckbox ids={visibleRows.map((r) => r.id)} selected={selected} onToggleAll={() => onSelectAllVisible(visibleRows)} label="Select all managers on this page" />
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
                        onChange={() => onToggle(m.id, { name, accountStatus: m.accountStatus })}
                        aria-label={`Select ${name}`}
                      />
                    </td>
                    {isVisible('name') && (
                      <td>
                        <button type="button" className="record-chip" style={{ cursor: 'pointer' }} onClick={() => openDetail(m.id, 'manager')}>
                          <span className="mini-avatar" style={{ background: c.bg, color: c.color }}>{name.split(' ').filter(Boolean).map(part => part[0]).slice(0,2).join('')}</span>
                          {name}
                        </button>
                      </td>
                    )}
                    {isVisible('email') && <td className="cell-muted">{m.email}</td>}
                    {isVisible('phone') && <td className="cell-muted">{m.phone ?? '–'}</td>}
                    {isVisible('jobTitle') && <td className="cell-muted">{m.jobTitle ?? '–'}</td>}
                    {isVisible('type') && <td><span className="badge badge-admin">{m.type === 'venue' ? 'Venue manager' : 'Manager'}</span></td>}
                    {isVisible('status') && (
                      <td>
                        <UserStatusBadge
                          userType="manager"
                          accountStatus={m.accountStatus}
                          invitationStatus={m.invitationStatus}
                          pendingInvite={m.pendingInvite}
                        />
                      </td>
                    )}
                    {isVisible('password') && <td>{m.accountStatus === 'active' ? <PasswordStatusBadge mustResetPassword={m.mustResetPassword}/> : '–'}</td>}
                    {isVisible('added') && <td className="cell-muted">{timeAgo(m.createdAt)}</td>}
                    <td>
                      <div className="row-actions">
                        <button className="btn-icon" title="View" onClick={() => openDetail(m.id, 'manager')}>
                          <IconEye size={14}/>
                        </button>
                        {(m.accountStatus === 'active' || m.accountStatus === 'suspended') && (
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
                              disabled={!!m.archivedAt}
                            >
                              {active ? <IconUserOff size={14}/> : <IconUserCheck size={14}/>}
                            </button>
                          </>
                        )}
                        {m.archivedAt ? (
                          <button className="btn-icon" title="Restore" aria-label={`Restore ${name}`} onClick={() => managerArchive.request(m, 'restore')}>
                            <IconArchiveOff size={14}/>
                          </button>
                        ) : m.accountStatus === 'suspended' ? (
                          <button className="btn-icon danger" title="Archive" aria-label={`Archive ${name}`} onClick={() => managerArchive.request(m, 'archive')}>
                            <IconArchive size={14}/>
                          </button>
                        ) : null}
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
      {data && <RecordFooter total={total} page={page} onPage={setPage} />}
      {managerArchive.dialog}
    </>
  );
}

interface VenueManagerRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  accountStatus: string;
  invitationStatus?: InvitationStatus | null;
  pendingInvite?: PendingInvite | null;
  createdAt: string;
  venues: Array<{ id: string; name: string }>;
}

/**
 * A Manager's own Venue Managers (GET /venue-managers: the caller's workspace only, server-enforced). Rows are selectable;
 * bulk actions use the `/venue-managers/:id/...` routes (VENUE_MANAGER_CREATE + own-workspace check on every record).
 */
function VenueManagersTab({ selected, onToggle, onSelectAllVisible, onVisible, onTotal }: SelectionProps & { onTotal: (n: number | null) => void }) {
  const retryUnlessPermanent = useRetryUnlessPermanent();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const params = { q: search || undefined, page };
  const { data, isLoading, isError, error, refetch } = useQuery({
    retry: retryUnlessPermanent,
    queryKey: ['venue-managers', params],
    queryFn: async () => (await api.get<{ data: VenueManagerRow[]; total: number }>('/venue-managers', { params })).data,
  });
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  useEffect(() => onTotal(data ? total : null), [data, total, onTotal]);
  const visibleRows = rows.map((m) => ({ id: m.id, record: { name: `${m.firstName} ${m.lastName}`, accountStatus: m.accountStatus } }));
  const visibleKey = visibleRows.map((r) => r.id).join(',');
  useEffect(() => onVisible(visibleKey ? visibleKey.split(',') : []), [visibleKey, onVisible]);

  return (
    <>
      <div className="list-toolbar-row">
        <TableSearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
      </div>
      <div className="table-container">
        {isLoading ? <TableSkeleton columns={5} /> : isError ? <ListError retry={refetch} error={error} /> : (
          <table className="table">
            <thead>
              <tr>
                <th className="checkbox-col">
                  <SelectAllCheckbox ids={visibleRows.map((r) => r.id)} selected={selected} onToggleAll={() => onSelectAllVisible(visibleRows)} label="Select all venue managers on this page" />
                </th>
                <th>Name</th><th>Email</th><th>Venue</th><th>Status</th><th>Added</th><th style={{ width: 44 }}/>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const name = `${m.firstName} ${m.lastName}`;
                const c = getColor(name);
                const isSelected = selected.has(m.id);
                return (
                  <tr key={m.id} className={isSelected ? 'row-selected' : undefined}>
                    <td className="checkbox-col">
                      <input type="checkbox" checked={isSelected} onChange={() => onToggle(m.id, { name, accountStatus: m.accountStatus })} aria-label={`Select ${name}`} />
                    </td>
                    <td>
                      <button type="button" className="record-chip" style={{ cursor: 'pointer' }} onClick={() => openDetail(m.id, 'venueManager')}>
                        <span className="mini-avatar" style={{ background: c.bg, color: c.color }}>{name.split(' ').filter(Boolean).map(part => part[0]).slice(0,2).join('')}</span>
                        {name}
                      </button>
                    </td>
                    <td className="cell-muted">{m.email}</td>
                    <td className="cell-muted">{m.venues.length ? m.venues.map((v) => v.name).join(', ') : 'No venue assigned'}</td>
                    <td>
                      <UserStatusBadge userType="manager" accountStatus={m.accountStatus} invitationStatus={m.invitationStatus ?? null} pendingInvite={m.pendingInvite ?? null} />
                    </td>
                    <td className="cell-muted">{timeAgo(m.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn-icon" title="View" onClick={() => openDetail(m.id, 'venueManager')}><IconEye size={14}/></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    {search
                      ? <EmptyState variant="matches" title="No results match this search." description="Try a different name or email." />
                      : <EmptyState variant="records" title="No venue managers yet" description="Add a venue manager and assign them one of your venues." />}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      {data && <RecordFooter total={total} page={page} onPage={setPage} />}
    </>
  );
}

export default function Users() {
  const retryUnlessPermanent = useRetryUnlessPermanent();
  const { data: me } = useQuery({queryKey:['me'],queryFn:async () => (await api.get<{roles:string[];isPlatformAdmin:boolean}>('/auth/me')).data,staleTime:300_000});
  const canCreateManager = !!me && (me.isPlatformAdmin || me.roles?.includes('ceo'));
  // Presentation only: GET /venue-managers re-checks venue_manager.create (and the caller's own workspace) on the server.
  const { data: capabilities } = useQuery({queryKey:['auth','capabilities'],enabled:!!me,queryFn:async () => (await api.get<Record<string, boolean>>('/auth/capabilities')).data,staleTime:300_000});
  const canManageVenueManagers = !canCreateManager && capabilities?.['venue_manager.create'] === true;
  const showManagersTab = canCreateManager || canManageVenueManagers;
  const managersTabLabel = canCreateManager ? 'Managers' : 'Venue managers';
  const {data:staffCount, error:staffCountError} = useQuery({queryKey:['staff','tab-count'],retry:retryUnlessPermanent,enabled:Array.isArray(me?.roles),queryFn:async () => (await api.get<{total:number}>('/staff',{params:{limit:1}})).data,staleTime:30_000});
  const {data:managerCount} = useQuery({queryKey:['managers','tab-count'],retry:retryUnlessPermanent,enabled:canCreateManager,queryFn:async () => (await api.get<{total:number}>('/managers',{params:{limit:1}})).data,staleTime:30_000});
  const {data:venueManagerCount} = useQuery({queryKey:['venue-managers','tab-count'],retry:retryUnlessPermanent,enabled:canManageVenueManagers,queryFn:async () => (await api.get<{total:number}>('/venue-managers',{params:{limit:1}})).data,staleTime:30_000});
  const managersTabCount = canCreateManager ? managerCount?.total : venueManagerCount?.total;
  const [tab, setTab] = useState<'staff' | 'managers'>('staff');
  const [, setSearchParams] = useSearchParams();
  // null = not (yet, or not successfully) loaded — never rendered as a confirmed "0".
  const [total, setTotal] = useState<number | null>(null);
  // The server refused the Staff list outright (no permission / no operational workspace): don't offer to create staff.
  const staffDenied = [403, 404].includes(listErrorStatus(staffCountError) ?? 0);
  // Selection is independent of the detail panel's `activeDetailUserId`
  // (owned entirely inside UserDetailPanel, via its own `open-user-detail`
  // listener) — checking a row never opens/closes/affects the panel, and
  // closing the panel never touches this. Keyed by id → name (not a bare
  // Set) so the bulk-email recipient label/target survives a search-filter
  // change between selecting a row and acting on the selection.
  const [selected, setSelected] = useState<Map<string, SelectedRecord>>(new Map());
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const onVisible = useCallback((ids: string[]) => setVisibleIds(ids), []);
  // Identity fence: a selection never survives a sign-out or an account switch (no late update can repopulate it either,
  // because the next identity starts from an empty map).
  useEffect(() => {
    let user = getUserId();
    return subscribeToSession(() => {
      const now = getUserId();
      if (now !== user) { user = now; setSelected(new Map()); }
    });
  }, []);

  const switchTab = (next: 'staff' | 'managers') => {
    setTab(next);
    setSelected(new Map());
    // Staff and Managers have different filter/sort field sets (e.g.
    // `status` means a different enum for each) — carrying one tab's URL
    // params into the other could send a value the other's DTO rejects
    // (400) right after switching. A fresh view per tab is also simply
    // the more sensible default when switching what you're looking at.
    setSearchParams({});
  };

  const onToggle = (id: string, record: SelectedRecord) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id); else next.set(id, record);
      return next;
    });
  };

  const onSelectAllVisible = (rows: Array<{ id: string; record: SelectedRecord }>) => {
    setSelected((prev) => {
      const allSelected = rows.length > 0 && rows.every((r) => prev.has(r.id));
      if (allSelected) {
        const next = new Map(prev);
        rows.forEach((r) => next.delete(r.id));
        return next;
      }
      const next = new Map(prev);
      rows.forEach((r) => next.set(r.id, r.record));
      return next;
    });
  };

  const selectionKind: SelectionKind | null = tab === 'staff' ? 'staff' : canCreateManager ? 'manager' : canManageVenueManagers ? 'venueManager' : null;
  const bulkPermissions = selectionKind === 'staff'
    ? { lifecycle: capabilities?.['staff.deactivate'] === true, email: true }
    : selectionKind === 'manager'
      ? { lifecycle: canCreateManager, email: canCreateManager }
      : { lifecycle: canManageVenueManagers, email: canManageVenueManagers };
  const offPage = [...selected.keys()].filter((id) => !visibleIds.includes(id)).length;

  return (
    <div className="page">
      <PageHeader
        title="Users"
        action={(tab === 'staff' ? !staffDenied : showManagersTab) && (
          <button className="btn btn-dark" onClick={() => tab === 'staff' ? openCreate('staff') : openCreate('manager', canCreateManager ? 'org' : 'workspace')}>
            <IconPlus size={14} /> New {tab === 'staff' ? 'staff' : canCreateManager ? 'manager' : 'venue manager'}
          </button>
        )}
        tabs={<>
        <button className={`tab-link ${tab === 'staff' ? 'active' : ''}`} onClick={() => switchTab('staff')}>Staff{(tab === 'staff' ? total : staffCount?.total) != null && <span className="tab-count"> · {tab === 'staff' ? total : staffCount?.total}</span>}</button>
        {showManagersTab && <button className={`tab-link ${tab === 'managers' ? 'active' : ''}`} onClick={() => switchTab('managers')}>{managersTabLabel}{(tab === 'managers' ? total : managersTabCount) != null && <span className="tab-count"> · {tab === 'managers' ? total : managersTabCount}</span>}</button>}
        </>}
      />

      {tab === 'staff'
        ? <StaffTab selected={selected} onToggle={onToggle} onSelectAllVisible={onSelectAllVisible} onVisible={onVisible} onTotal={setTotal} />
        : canCreateManager
          ? <ManagersTab selected={selected} onToggle={onToggle} onSelectAllVisible={onSelectAllVisible} onVisible={onVisible} onTotal={setTotal} />
          : canManageVenueManagers ? <VenueManagersTab selected={selected} onToggle={onToggle} onSelectAllVisible={onSelectAllVisible} onVisible={onVisible} onTotal={setTotal} /> : null}
      {/* One roster per selection (tab switch clears it). Actions appear only with the matching permission; the server
          re-checks each record (permission, own workspace/ownership, lifecycle, step-up for delete). */}
      {selectionKind && (
        <UsersBulkActions
          kind={selectionKind}
          selected={selected}
          setSelected={setSelected}
          permissions={bulkPermissions}
          scopeNote={offPage > 0 ? `${offPage} not on this page` : undefined}
        />
      )}
    </div>
  );
}
