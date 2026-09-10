import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArchive, IconPencil, IconPlus } from '@tabler/icons-react';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';
import TableViewControls, { TableSearchInput } from '../../shared/table-toolbar/TableToolbar';
import { useTableQueryState } from '../../shared/table-toolbar/useTableQueryState';
import { useColumnVisibility } from '../../shared/table-toolbar/useColumnVisibility';
import type { TableToolbarConfig } from '../../shared/table-toolbar/types';

interface Venue {
  id: string;
  name: string;
  clientName: string | null;
  type: string;
  address: { line1?: string; city?: string; postcode?: string };
  instructions: string | null;
  breakPaid: boolean;
  status: string;
}

// Real VenueStatus/VenueType values (@rab/shared) — never invented.
const VENUES_TABLE_CONFIG: TableToolbarConfig = {
  storageKey: 'venues',
  filters: [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'active', label: 'Active' },
        { value: 'archived', label: 'Archived' },
      ],
    },
    {
      key: 'type',
      label: 'Type',
      type: 'select',
      options: [
        { value: 'hotel', label: 'Hotel' },
        { value: 'restaurant', label: 'Restaurant' },
        { value: 'warehouse', label: 'Warehouse' },
        { value: 'event', label: 'Event' },
        { value: 'other', label: 'Other' },
      ],
    },
  ],
  sorts: [
    { key: 'name', label: 'Name', directions: ['asc', 'desc'], directionLabels: { asc: 'A–Z', desc: 'Z–A' } },
    { key: 'createdAt', label: 'Created', directions: ['desc', 'asc'], directionLabels: { desc: 'Newest first', asc: 'Oldest first' } },
  ],
  columns: [
    { key: 'venue', label: 'Venue', hideable: false },
    { key: 'address', label: 'Address', hideable: true },
    { key: 'client', label: 'Client', hideable: true },
    { key: 'type', label: 'Type', hideable: true },
  ],
  defaultSort: { key: 'name', direction: 'asc' },
  // Matches this page's existing behavior (archived venues were always
  // hidden client-side, with no way to see them) — preserved as a real,
  // visible, clearable default rather than silently changed to "show
  // everything" just because the underlying data-fetch moved server-side.
  defaultFilters: { status: 'active' },
};

function editVenue(venue: Venue) {
  document.dispatchEvent(new CustomEvent('open-edit-venue', { detail: { venue } }));
}
function openCreateVenue() {
  document.dispatchEvent(new CustomEvent('open-create-venue'));
}

export default function Venues() {
  const qc = useQueryClient();
  const config = VENUES_TABLE_CONFIG;
  const { search, filters, sort, setSearch, setFilters, setSort, activeFilterCount } = useTableQueryState(config);
  const columnVisibility = useColumnVisibility(config.storageKey, config.columns);

  const params = { q: search || undefined, ...filters, sort: sort.sort, direction: sort.direction };
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['venues', params],
    queryFn: async () => { const { data } = await api.get<{ data: Venue[]; total: number }>('/venues', { params }); return data; },
  });
  const venues = data?.data ?? [];
  const total = data?.total ?? 0;

  // Venues are archived, never deleted (rab-workforce-architecture.md §13
  // edge cases — shifts and history keep referencing a venue after it stops
  // taking new bookings).
  const archive = useMutation({
    mutationFn: (id: string) => api.post(`/venues/${id}/archive`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });

  const isVisible = columnVisibility.isVisible;
  const isFiltered = Boolean(search) || Object.keys(filters).some((k) => k !== 'status' && filters[k]) || filters.status !== 'active';

  return (
    <div className="page">
      <PageHeader title="Venues" subtitle={`${total} venue${total === 1 ? '' : 's'}`} />

      <div className="list-tabs-row">
        <span className="tab-link active">All venues</span>
      </div>

      <div className="list-toolbar-row">
        <TableSearchInput value={search} onChange={setSearch} />
        <div className="list-toolbar-actions">
          <button className="btn btn-accent-outline" onClick={openCreateVenue}>
            <IconPlus size={14}/> New venue
          </button>
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
          <TableSkeleton columns={5} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                {isVisible('venue') && <th style={{ width: 'auto' }}>Venue</th>}
                {isVisible('address') && <th>Address</th>}
                {isVisible('client') && <th>Client</th>}
                {isVisible('type') && <th>Type</th>}
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {venues.map((v) => (
                <tr key={v.id}>
                  {isVisible('venue') && (
                    <td style={{ width: 'auto' }}>
                      <span className="record-chip">
                        <span className="mini-avatar" style={{ background: '#fdded9', color: '#d93025' }}>{v.name?.[0]}</span>
                        {v.name}
                      </span>
                    </td>
                  )}
                  {isVisible('address') && <td className="cell-muted">{[v.address?.line1, v.address?.city, v.address?.postcode].filter(Boolean).join(', ') || '–'}</td>}
                  {isVisible('client') && <td className="cell-muted">{v.clientName ?? '–'}</td>}
                  {isVisible('type') && <td><span className="badge badge-active">{v.type}</span></td>}
                  <td>
                    <div className="row-actions">
                      <button className="btn-icon" title="Edit" onClick={() => editVenue(v)}><IconPencil size={14}/></button>
                      <button className="btn-icon danger" title="Archive" onClick={() => archive.mutate(v.id)}><IconArchive size={14}/></button>
                    </div>
                  </td>
                </tr>
              ))}
              {venues.length === 0 && (
                <tr><td colSpan={5}>
                  {isFiltered ? (
                    <EmptyState
                      variant="matches"
                      title="No results match these filters."
                      description="Try different values, or clear filters to see the full list."
                      action={<button className="btn btn-outline" onClick={() => { setSearch(''); setFilters({}); }}>Clear filters</button>}
                    />
                  ) : (
                    <EmptyState title="No venues yet" description="Add a venue to begin scheduling shifts." />
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
