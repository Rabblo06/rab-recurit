import { useQuery } from '@tanstack/react-query';
import { IconClock } from '@tabler/icons-react';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';
import { TableSearchInput } from '../../shared/table-toolbar/TableToolbar';
import { useTableQueryState } from '../../shared/table-toolbar/useTableQueryState';
import type { TableToolbarConfig } from '../../shared/table-toolbar/types';

interface VenueOffer {
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  requiredCount: number;
  selectedCount: string | number;
  payRatePence: number;
  notes: string | null;
  submittedAt: string;
  venueName: string;
  roleName: string;
  venueManagerName: string;
}

function openShiftApproval(shiftId: string) {
  document.dispatchEvent(new CustomEvent('open-shift-approval', { detail: { shiftId } }));
}

// This page shows ONLY Venue-Manager-submitted requests (`requestedBy IS
// NOT NULL` server-side) — a directly-created shift (the normal Shifts
// page) never appears here, by design; see SchedulingService
// .listVenueOffers's own doc comment for why this is a separate query
// rather than a filtered view of the general Shifts list.
const STATUS_TABS: { key: '' | 'pending' | 'approved' | 'declined'; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'declined', label: 'Declined' },
];

const VENUE_OFFERS_TABLE_CONFIG: TableToolbarConfig = {
  storageKey: 'venue-offers',
  filters: [],
  sorts: [],
  columns: [
    { key: 'venue', label: 'Venue', hideable: false },
    { key: 'note', label: 'Note', hideable: true },
    { key: 'role', label: 'Role', hideable: true },
    { key: 'venueManager', label: 'Venue Manager', hideable: true },
    { key: 'date', label: 'Date', hideable: false },
    { key: 'time', label: 'Time', hideable: true },
    { key: 'staffing', label: 'Staff', hideable: true },
    { key: 'rate', label: 'Rate', hideable: true },
    { key: 'status', label: 'Status', hideable: false },
    { key: 'submitted', label: 'Submitted', hideable: true },
  ],
  defaultSort: { key: 'submittedAt', direction: 'desc' },
};

const fmtMoney = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const timeAgo = (iso: string): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export default function VenueOffers() {
  const config = VENUE_OFFERS_TABLE_CONFIG;
  const { search, filters, setSearch, setFilters, activeFilterCount } = useTableQueryState(config);
  const activeStatus = (filters.status as '' | 'pending' | 'approved' | 'declined' | undefined) ?? '';

  const params = { q: search || undefined, status: activeStatus || undefined };
  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ['venue-offers', params],
    queryFn: async () => {
      const { data } = await api.get<{ data: VenueOffer[]; total: number }>('/shifts/requests', { params });
      return data;
    },
  });
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const isFiltered = activeFilterCount > 0 || Boolean(search);

  return (
    <div className="page">
      <PageHeader title="Venue Offers" subtitle={`${total} request${total === 1 ? '' : 's'}`} />

      <div className="list-tabs-row">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            className={`tab-link ${activeStatus === t.key ? 'active' : ''}`}
            onClick={() => setFilters(t.key ? { status: t.key } : {})}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="list-toolbar-row">
        <TableSearchInput value={search} onChange={setSearch} />
      </div>

      <div className={`table-container${isFetching ? ' table-loading' : ''}`}>
        {isLoading ? (
          <TableSkeleton columns={10} />
        ) : isError ? (
          <EmptyState
            variant="matches"
            title="Could not load Venue Offers."
            description="Something went wrong fetching this list."
            action={<button className="btn btn-outline" onClick={() => refetch()}>Retry</button>}
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Venue</th>
                <th>Note</th>
                <th>Role</th>
                <th>Venue Manager</th>
                <th>Date</th>
                <th>Time</th>
                <th>Staff</th>
                <th>Rate</th>
                <th>Status</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => openShiftApproval(r.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <span className="record-chip">
                      <span className="mini-avatar" style={{ background: '#d9f0de', color: '#2a8e44' }}>{r.venueName?.[0]}</span>
                      {r.venueName}
                    </span>
                  </td>
                  <td className="cell-muted" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.notes ?? '–'}
                  </td>
                  <td className="cell-muted">{r.roleName}</td>
                  <td className="cell-muted">{r.venueManagerName}</td>
                  <td className="cell-muted">{fmtDate(r.startsAt)}</td>
                  <td><span className="cell-icon-text"><IconClock size={13} />{fmtTime(r.startsAt)}–{fmtTime(r.endsAt)}</span></td>
                  <td className="cell-muted">{r.selectedCount} / {r.requiredCount}</td>
                  <td style={{ color: 'var(--color-green)', fontWeight: 500 }}>{fmtMoney(r.payRatePence)}/hr</td>
                  <td>
                    <span className={`badge badge-${r.status}`}>
                      {r.status === 'pending_manager_approval' ? 'Pending approval' : r.status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="cell-muted">{timeAgo(r.submittedAt)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={10}>
                  {isFiltered ? (
                    <EmptyState
                      variant="matches"
                      title="No results match these filters."
                      description="Try different values, or clear filters to see the full list."
                      action={<button className="btn btn-outline" onClick={() => { setSearch(''); setFilters({}); }}>Clear filters</button>}
                    />
                  ) : (
                    <EmptyState variant="inbox" title="No Venue Offer requests yet" description="Requests submitted by Venue Managers will appear here for review." />
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
