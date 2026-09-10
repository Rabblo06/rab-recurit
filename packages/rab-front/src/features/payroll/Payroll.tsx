import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';
import TableViewControls, { TableSearchInput } from '../../shared/table-toolbar/TableToolbar';
import { useTableQueryState } from '../../shared/table-toolbar/useTableQueryState';
import { useColumnVisibility } from '../../shared/table-toolbar/useColumnVisibility';
import type { TableToolbarConfig } from '../../shared/table-toolbar/types';

interface AttendanceRow {
  id: string;
  status: string;
  clockInAt: string;
  clockOutAt: string | null;
  workedMinutes: number | null;
  earnedPence: number | null;
  shiftId: string;
  startsAt: string;
  endsAt: string;
  venueName: string;
  roleName: string;
  staffProfileId: string;
  staffName: string;
}

interface Venue { id: string; name: string }

const avatarColors = [
  { bg: '#dbe9fe', color: '#1961ed' },
  { bg: '#d9f0de', color: '#2a8e44' },
  { bg: '#fdf2d4', color: '#946c00' },
  { bg: '#f1e6fd', color: '#7d3bc8' },
  { bg: '#fde2ef', color: '#c2185d' },
];
const getColor = (name: string) => avatarColors[(name?.charCodeAt(0) ?? 0) % avatarColors.length];

const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtHours = (minutes: number | null) => (minutes === null ? '–' : `${(minutes / 60).toFixed(2)}h`);
const fmtMoney = (pence: number | null) => (pence === null ? '–' : `£${(pence / 100).toFixed(2)}`);

// Real AttendanceStatus values (modules/attendance/constants/attendance-status.ts)
// — just ACTIVE ("clocked in, not yet out") vs COMPLETED ("clocked out,
// hours/pay computed"). There is no "Paid"/payment-run concept anywhere in
// this schema — never labelled that way here, since it would claim a fact
// this data doesn't track.
const PAYROLL_TABLE_CONFIG: TableToolbarConfig = {
  storageKey: 'payroll',
  filters: [
    { key: 'status', label: 'Status', type: 'select', options: [
      { value: 'active', label: 'In progress' },
      { value: 'completed', label: 'Completed' },
    ] },
    { key: 'clockIn', label: 'Date', type: 'dateRange' },
    { key: 'workedMinutes', label: 'Hours (minutes)', type: 'numberRange' },
    { key: 'earnedPence', label: 'Amount (pence)', type: 'numberRange' },
  ],
  sorts: [
    { key: 'clockInAt', label: 'Date', directions: ['desc', 'asc'], directionLabels: { desc: 'Newest first', asc: 'Oldest first' } },
    { key: 'staff', label: 'Staff', directions: ['asc', 'desc'] },
    { key: 'venue', label: 'Venue', directions: ['asc', 'desc'] },
    { key: 'workedMinutes', label: 'Hours', directions: ['desc', 'asc'] },
    { key: 'earnedPence', label: 'Amount', directions: ['desc', 'asc'] },
  ],
  columns: [
    { key: 'staff', label: 'Staff', hideable: false },
    { key: 'venue', label: 'Venue', hideable: true },
    { key: 'date', label: 'Shift date', hideable: true },
    { key: 'hours', label: 'Hours', hideable: true },
    { key: 'amount', label: 'Amount', hideable: false },
    { key: 'status', label: 'Status', hideable: true },
  ],
  defaultSort: { key: 'clockInAt', direction: 'desc' },
};

export default function Payroll() {
  const { data: venues = [] } = useQuery({
    queryKey: ['venues'],
    queryFn: async () => { const { data } = await api.get<{ data: Venue[] } | Venue[]>('/venues'); return Array.isArray(data) ? data : data.data; },
  });

  const config: TableToolbarConfig = {
    ...PAYROLL_TABLE_CONFIG,
    filters: [
      { key: 'venueId', label: 'Venue', type: 'select', options: venues.map((v) => ({ value: v.id, label: v.name })) },
      ...PAYROLL_TABLE_CONFIG.filters,
    ],
  };

  const { search, filters, sort, setSearch, setFilters, setSort, activeFilterCount } = useTableQueryState(config);
  const columnVisibility = useColumnVisibility(config.storageKey, config.columns);

  const params = {
    q: search || undefined,
    venueId: filters.venueId,
    status: filters.status,
    clockInFrom: filters.clockInFrom,
    clockInTo: filters.clockInTo,
    workedMinutesMin: filters.workedMinutesFrom,
    workedMinutesMax: filters.workedMinutesTo,
    earnedPenceMin: filters.earnedPenceFrom,
    earnedPenceMax: filters.earnedPenceTo,
    sort: sort.sort,
    direction: sort.direction,
  };
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['attendance', 'payroll', params],
    queryFn: async () => { const { data } = await api.get<{ data: AttendanceRow[]; total: number }>('/attendance', { params }); return data; },
  });
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  // Derived from authoritative backend rows only — never independently
  // computed, so the total can never drift from what the individual rows
  // (each already backend-verified: workedMinutes/earnedPence snapshotted
  // once at clock-out) actually sum to.
  const totalMinutes = rows.reduce((sum, r) => sum + (r.workedMinutes ?? 0), 0);
  const totalPence = rows.reduce((sum, r) => sum + (r.earnedPence ?? 0), 0);

  const isVisible = columnVisibility.isVisible;
  const isFiltered = activeFilterCount > 0 || Boolean(search);

  return (
    <div className="page">
      <PageHeader title="Payroll" subtitle={`${total} attendance record${total === 1 ? '' : 's'}`} />

      <div className="list-tabs-row">
        <span className="tab-link active">All attendance</span>
      </div>

      <div className="list-toolbar-row">
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

      <div className={`table-container${isFetching ? ' table-loading' : ''}`}>
        {isLoading ? (
          <TableSkeleton columns={6} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                {isVisible('staff') && <th style={{ width: 'auto' }}>Staff</th>}
                {isVisible('venue') && <th>Venue</th>}
                {isVisible('date') && <th>Shift date</th>}
                {isVisible('hours') && <th>Hours</th>}
                {isVisible('amount') && <th>Amount</th>}
                {isVisible('status') && <th>Status</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const c = getColor(r.staffName);
                return (
                  <tr key={r.id}>
                    {isVisible('staff') && (
                      <td style={{ width: 'auto' }}>
                        <span className="user-cell">
                          <span className="round-avatar" style={{ background: c.bg, color: c.color }}>{r.staffName?.[0]}</span>
                          {r.staffName}
                        </span>
                      </td>
                    )}
                    {isVisible('venue') && <td className="cell-muted">{r.venueName}</td>}
                    {isVisible('date') && <td className="cell-muted">{fmtDate(r.startsAt)}</td>}
                    {isVisible('hours') && <td className="cell-muted">{fmtHours(r.workedMinutes)}</td>}
                    {isVisible('amount') && <td style={{ color: 'var(--color-green)', fontWeight: 600 }}>{fmtMoney(r.earnedPence)}</td>}
                    {isVisible('status') && <td><span className={`badge badge-${r.status === 'completed' ? 'active' : 'pending'}`}>{r.status === 'completed' ? 'Completed' : 'In progress'}</span></td>}
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={6}>
                  {isFiltered ? (
                    <EmptyState
                      variant="matches"
                      title="No results match these filters."
                      description="Try different values, or clear filters to see the full list."
                      action={<button className="btn btn-outline" onClick={() => { setSearch(''); setFilters({}); }}>Clear filters</button>}
                    />
                  ) : (
                    <EmptyState variant="files" title="No payroll records yet" description="Completed shift attendance will appear here." />
                  )}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="table-footer">
        <span>Total</span>
        <span>{rows.length} record{rows.length === 1 ? '' : 's'} on this page</span>
        <span>{fmtHours(totalMinutes)}</span>
        <span style={{ fontWeight: 600, color: 'var(--font-primary)' }}>{fmtMoney(totalPence)}</span>
      </div>
    </div>
  );
}
