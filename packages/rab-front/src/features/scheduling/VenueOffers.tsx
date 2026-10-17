import { useColumnVisibility } from '../../shared/table-toolbar/useColumnVisibility';
import { ListViewSelect, RecordFooter } from '../../shared/table-toolbar/ListPresentation';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { IconClock } from '@tabler/icons-react';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';
import TableViewControls, { TableSearchInput } from '../../shared/table-toolbar/TableToolbar';
import { useTableQueryState } from '../../shared/table-toolbar/useTableQueryState';
import type { TableToolbarConfig } from '../../shared/table-toolbar/types';

interface VenueOffer {
  id: string;
  status: string;
  displayStatus: string;
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
//
// PHASE 12 / WEB-02 — the single canonical list of valid status values,
// mirroring the server's own closed set (`VENUE_OFFER_VIEW_STATUSES`,
// list-venue-offers.dto.ts) by construction: both are
// "pending" | "approved" | "declined". The server's `@IsIn` on that DTO
// field is the authoritative enforcement; this is the client-side mirror
// both the tab buttons AND the table-toolbar filter config below derive
// from, so there is exactly one place that list is ever written out.
const VENUE_OFFER_STATUS_VALUES = ['pending', 'approved', 'declined'] as const;
type VenueOfferStatus = (typeof VENUE_OFFER_STATUS_VALUES)[number];

const STATUS_TABS: { key: '' | VenueOfferStatus; label: string }[] = [
  { key: '', label: 'All' },
  ...VENUE_OFFER_STATUS_VALUES.map((key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1) })),
];

const VENUE_OFFERS_TABLE_CONFIG: TableToolbarConfig = {
  storageKey: 'venue-offers',
  // `status` MUST be declared here — `useTableQueryState`'s read side
  // (`filters`) only ever reflects URL params for keys listed in
  // `config.filters`; its write side (`setFilters`) will happily persist
  // ANY key into the URL regardless of this list. Before this was added,
  // clicking a tab correctly wrote `?status=approved` to the URL, but
  // `filters.status` always read back `undefined` — the active tab, the
  // API request, and the URL disagreed. This is the actual fix: one
  // canonical config entry, not a second filter/state model.
  filters: [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: STATUS_TABS.filter((t) => t.key).map((t) => ({ value: t.key, label: t.label })),
    },
  ],
  sorts: [],
  columns: [
    { key: 'venue', label: 'Venue', hideable: false },
    { key: 'note', label: 'Note', hideable: true, defaultVisible: false },
    { key: 'role', label: 'Role', hideable: true },
    { key: 'venueManager', label: 'Venue Manager', hideable: true, defaultVisible: false },
    { key: 'date', label: 'Date', hideable: false },
    { key: 'time', label: 'Time', hideable: true, defaultVisible: false },
    { key: 'staffing', label: 'Staff', hideable: true },
    { key: 'rate', label: 'Rate', hideable: true, defaultVisible: false },
    { key: 'status', label: 'Status', hideable: false },
    { key: 'submitted', label: 'Submitted', hideable: true, defaultVisible: false },
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
  const navigate = useNavigate();
  const columnVisibility = useColumnVisibility(VENUE_OFFERS_TABLE_CONFIG.storageKey, VENUE_OFFERS_TABLE_CONFIG.columns);
  const isVisible = columnVisibility.isVisible;
  const config = VENUE_OFFERS_TABLE_CONFIG;
  const { search, filters, sort, setSort, setSearch, setFilters, activeFilterCount } = useTableQueryState(config);
  // An unrecognised URL value (`?status=garbage`) must never reach the API
  // as an unchecked filter — fail safe to "All" rather than forwarding it.
  // The server's own `@IsIn` on this DTO field would reject it anyway (400),
  // but the UI should never show a "phantom" active tab or make a doomed
  // request for a value it already knows is invalid.
  const rawStatus = filters.status;
  const activeStatus: '' | VenueOfferStatus = (VENUE_OFFER_STATUS_VALUES as readonly string[]).includes(rawStatus ?? '')
    ? (rawStatus as VenueOfferStatus)
    : '';

  const params = { q: search || undefined, status: activeStatus || undefined };
  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ['venue-offers', params],
    refetchInterval: 10000,
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
      <PageHeader title="Offers" />

      <div className="list-tabs-row">
        <NavLink className="tab-link" to="/offers">Staff Offers</NavLink>
        <NavLink className="tab-link active" to="/venue-offers">Venue Offers <span className="tab-count">· {total}</span></NavLink>
      </div>

      <div className="list-toolbar-row">
        <ListViewSelect label="Venue offer status" value={activeStatus} options={STATUS_TABS.map(t => ({value:t.key,label:t.key ? t.label : 'All requests'}))} onChange={status => setFilters(status ? {status} : {})} />
        <TableSearchInput value={search} onChange={setSearch} />
        <div className="list-toolbar-actions"><TableViewControls config={config} filters={filters} onFiltersChange={setFilters} sort={sort} onSortChange={setSort} activeFilterCount={activeFilterCount} columnVisibility={columnVisibility} /></div>
      </div>

      <div className={`table-container${isFetching ? ' table-loading' : ''}`}>
        {isLoading ? (
          <TableSkeleton columns={10} />
        ) : isError ? (
          <EmptyState
            variant="matches"
            title="Could not load Venue Offers."
            tone="error"
            description="Something went wrong fetching this list."
            action={<button className="btn btn-outline" onClick={() => refetch()}>Retry</button>}
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                {isVisible('venue') && <th>Venue</th>}
                {isVisible('note') && <th>Note</th>}
                {isVisible('role') && <th>Role</th>}
                {isVisible('venueManager') && <th>Venue Manager</th>}
                {isVisible('date') && <th>Date</th>}
                {isVisible('time') && <th>Time</th>}
                {isVisible('staffing') && <th>Staff</th>}
                {isVisible('rate') && <th>Rate</th>}
                {isVisible('status') && <th>Status</th>}
                {isVisible('submitted') && <th>Submitted</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => ['pending_manager_approval','declined'].includes(r.status) ? openShiftApproval(r.id) : navigate(`/venue-offers/${r.id}`)} style={{ cursor: 'pointer' }}>
                  {isVisible('venue') && <td>
                    <span className="record-chip">
                      <span className="mini-avatar" style={{ background: '#d9f0de', color: '#2a8e44' }}>{r.venueName?.[0]}</span>
                      {r.venueName}
                    </span>
                  </td>}
                  {isVisible('note') && <td className="cell-muted" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.notes ?? '–'}
                  </td>}
                  {isVisible('role') && <td className="cell-muted">{r.roleName}</td>}
                  {isVisible('venueManager') && <td className="cell-muted">{r.venueManagerName}</td>}
                  {isVisible('date') && <td className="cell-muted">{fmtDate(r.startsAt)}</td>}
                  {isVisible('time') && <td><span className="cell-icon-text"><IconClock size={13} />{fmtTime(r.startsAt)}–{fmtTime(r.endsAt)}</span></td>}
                  {isVisible('staffing') && <td className="cell-muted">{r.selectedCount} / {r.requiredCount}</td>}
                  {isVisible('rate') && <td style={{ color: 'var(--color-green)', fontWeight: 500 }}>{fmtMoney(r.payRatePence)}/hr</td>}
                  {isVisible('status') && <td>
                    <span className={`badge badge-${r.status}`}>
                      {r.displayStatus}
                    </span>
                  </td>}
                  {isVisible('submitted') && <td className="cell-muted">{timeAgo(r.submittedAt)}</td>}
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
                    <EmptyState variant="venueOffers" title="No venue requests yet" description="New requests from your venues will appear here." />
                  )}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <RecordFooter total={total} />
    </div>
  );
}
