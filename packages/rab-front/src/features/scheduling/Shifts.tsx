import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconClock, IconSend, IconBan, IconRocket, IconPlus,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';
import TableViewControls, { TableSearchInput } from '../../shared/table-toolbar/TableToolbar';
import { useTableQueryState } from '../../shared/table-toolbar/useTableQueryState';
import { useColumnVisibility } from '../../shared/table-toolbar/useColumnVisibility';
import type { TableToolbarConfig } from '../../shared/table-toolbar/types';

interface Venue { id: string; name: string; status: string }
interface JobRole { id: string; name: string; defaultRatePence: number }
interface Shift {
  id: string;
  venueId: string;
  jobRoleId: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  requiredCount: number;
  filledCount: number;
  payRatePence: number;
  status: string;
  notes?: string;
}

const ACTIVE_STATUSES = ['open', 'offered', 'partially_filled'];

// Real ShiftStatus values (@rab/shared) — never invented.
const SHIFT_STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'pending_manager_approval', label: 'Pending approval' },
  { value: 'declined', label: 'Declined' },
  { value: 'open', label: 'Open' },
  { value: 'offered', label: 'Offered' },
  { value: 'partially_filled', label: 'Partially filled' },
  { value: 'fully_filled', label: 'Fully filled' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const SHIFTS_TABLE_CONFIG: TableToolbarConfig = {
  storageKey: 'shifts',
  filters: [
    { key: 'status', label: 'Status', type: 'select', options: SHIFT_STATUS_OPTIONS },
    { key: 'startsAt', label: 'Date', type: 'dateRange' },
  ],
  sorts: [
    { key: 'startsAt', label: 'Date', directions: ['asc', 'desc'], directionLabels: { asc: 'Earliest first', desc: 'Latest first' } },
    { key: 'venue', label: 'Venue', directions: ['asc', 'desc'] },
    { key: 'jobRole', label: 'Role', directions: ['asc', 'desc'] },
    { key: 'status', label: 'Status', directions: ['asc', 'desc'] },
    { key: 'createdAt', label: 'Created date', directions: ['desc', 'asc'], directionLabels: { desc: 'Newest first', asc: 'Oldest first' } },
  ],
  columns: [
    { key: 'venue', label: 'Venue', hideable: false },
    { key: 'role', label: 'Role', hideable: true },
    { key: 'date', label: 'Date', hideable: false },
    { key: 'time', label: 'Time', hideable: true },
    { key: 'filled', label: 'Filled', hideable: true },
    { key: 'rate', label: 'Rate', hideable: true },
    { key: 'status', label: 'Status', hideable: false },
  ],
  defaultSort: { key: 'startsAt', direction: 'asc' },
};

const fmtMoney = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function openSendOffer(shift: Shift) {
  document.dispatchEvent(new CustomEvent('open-send-offer', { detail: { shift } }));
}
function openCancelShift(shiftId: string) {
  document.dispatchEvent(new CustomEvent('open-cancel-shift', { detail: { shiftId } }));
}
function openCreateShift() {
  document.dispatchEvent(new CustomEvent('open-create-placement'));
}
function openShiftApproval(shiftId: string) {
  document.dispatchEvent(new CustomEvent('open-shift-approval', { detail: { shiftId } }));
}
function openShiftRequest() {
  document.dispatchEvent(new CustomEvent('open-shift-request'));
}
const REQUEST_STATUSES = ['pending_manager_approval', 'declined'];

export default function Shifts() {
  const qc = useQueryClient();
  const { data: me } = useQuery({
    queryKey: ['auth-me'],
    queryFn: async () => { const { data } = await api.get<{ roles: string[] }>('/auth/me'); return data; },
    staleTime: 5 * 60 * 1000,
  });
  const isVenueManager = me?.roles.includes('venue_manager') ?? false;
  const { data: venues = [] } = useQuery({
    queryKey: ['venues'],
    queryFn: async () => { const { data } = await api.get<{ data: Venue[] } | Venue[]>('/venues'); return Array.isArray(data) ? data : data.data; },
  });
  const { data: jobRoles = [] } = useQuery({
    queryKey: ['job-roles'],
    queryFn: async () => { const { data } = await api.get<JobRole[]>('/job-roles'); return data; },
  });

  const config: TableToolbarConfig = {
    ...SHIFTS_TABLE_CONFIG,
    filters: [
      { key: 'venueId', label: 'Venue', type: 'select', options: venues.map((v) => ({ value: v.id, label: v.name })) },
      ...SHIFTS_TABLE_CONFIG.filters,
      { key: 'jobRoleId', label: 'Job role', type: 'select', options: jobRoles.map((r) => ({ value: r.id, label: r.name })) },
    ],
  };

  const { search, filters, sort, setSearch, setFilters, setSort, activeFilterCount } = useTableQueryState(config);
  const columnVisibility = useColumnVisibility(config.storageKey, config.columns);

  const params = { q: search || undefined, ...filters, sort: sort.sort, direction: sort.direction };
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['shifts', params],
    queryFn: async () => { const { data } = await api.get<{ data: Shift[]; total: number }>('/shifts', { params }); return data; },
  });
  const shifts = data?.data ?? [];
  const total = data?.total ?? 0;

  const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? '–';
  const roleName = (id: string) => jobRoles.find((r) => r.id === id)?.name ?? '–';

  const publish = useMutation({
    mutationFn: (id: string) => api.post(`/shifts/${id}/publish`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shifts'] }),
  });

  const isVisible = columnVisibility.isVisible;
  const isFiltered = activeFilterCount > 0 || Boolean(search);

  return (
    <div className="page">
      <PageHeader title="Shifts" subtitle={`${total} shift${total === 1 ? '' : 's'}`} />

      <div className="list-tabs-row">
        <span className="tab-link active">All shifts</span>
      </div>

      <div className="list-toolbar-row">
        <TableSearchInput value={search} onChange={setSearch} />
        <div className="list-toolbar-actions">
          {isVenueManager ? (
            <button className="btn btn-accent-outline" onClick={openShiftRequest}>
              <IconPlus size={14}/> Request shift
            </button>
          ) : (
            <button className="btn btn-accent-outline" onClick={openCreateShift}>
              <IconPlus size={14}/> New shift
            </button>
          )}
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
        {isLoading ? (
          <TableSkeleton columns={8} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                {isVisible('venue') && <th>Venue</th>}
                {isVisible('role') && <th>Role</th>}
                {isVisible('date') && <th>Date</th>}
                {isVisible('time') && <th>Time</th>}
                {isVisible('filled') && <th>Filled</th>}
                {isVisible('rate') && <th>Rate</th>}
                {isVisible('status') && <th>Status</th>}
                <th style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {shifts.map((s) => {
                const isRequest = REQUEST_STATUSES.includes(s.status);
                return (
                <tr
                  key={s.id}
                  onClick={isRequest ? () => openShiftApproval(s.id) : undefined}
                  style={isRequest ? { cursor: 'pointer' } : undefined}
                >
                  {isVisible('venue') && (
                    <td>
                      <span className="record-chip">
                        <span className="mini-avatar" style={{ background: '#d9f0de', color: '#2a8e44' }}>{venueName(s.venueId)[0]}</span>
                        {venueName(s.venueId)}
                      </span>
                    </td>
                  )}
                  {isVisible('role') && <td className="cell-muted">{roleName(s.jobRoleId)}</td>}
                  {isVisible('date') && <td className="cell-muted">{fmtDate(s.startsAt)}</td>}
                  {isVisible('time') && <td><span className="cell-icon-text"><IconClock size={13} />{fmtTime(s.startsAt)}–{fmtTime(s.endsAt)}</span></td>}
                  {isVisible('filled') && <td className="cell-muted">{s.filledCount} / {s.requiredCount}</td>}
                  {isVisible('rate') && <td style={{ color: 'var(--color-green)', fontWeight: 500 }}>{fmtMoney(s.payRatePence)}/hr</td>}
                  {isVisible('status') && (
                    <td>
                      <span className={`badge badge-${s.status}`}>
                        {s.status === 'pending_manager_approval' ? 'Pending approval' : s.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                  )}
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="row-actions action-btns">
                      {s.status === 'pending_manager_approval' && (
                        <button className="btn-icon success" title="Review request" onClick={() => openShiftApproval(s.id)}>
                          <IconRocket size={14} />
                        </button>
                      )}
                      {s.status === 'draft' && (
                        <button className="btn-icon success" title="Publish" onClick={() => publish.mutate(s.id)}>
                          <IconRocket size={14} />
                        </button>
                      )}
                      {ACTIVE_STATUSES.includes(s.status) && s.filledCount < s.requiredCount && (
                        <button className="btn-icon" title="Send offer" onClick={() => openSendOffer(s)}>
                          <IconSend size={14} />
                        </button>
                      )}
                      {!['cancelled', 'completed', ...REQUEST_STATUSES].includes(s.status) && (
                        <button className="btn-icon danger" title="Cancel shift" onClick={() => openCancelShift(s.id)}>
                          <IconBan size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
              {shifts.length === 0 && (
                <tr><td colSpan={8}>
                  {isFiltered ? (
                    <EmptyState
                      variant="matches"
                      title="No results match these filters."
                      description="Try different values, or clear filters to see the full list."
                      action={<button className="btn btn-outline" onClick={() => { setSearch(''); setFilters({}); }}>Clear filters</button>}
                    />
                  ) : (
                    <EmptyState variant="tasks" title="No shifts yet" description="Schedule a shift to start filling your rota." />
                  )}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="list-footer">
        <span>Calculate</span>
        <span className="list-footer-divider"/>
        <span>Count all <strong>{total}</strong></span>
      </div>
    </div>
  );
}
